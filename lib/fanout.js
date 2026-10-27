// Orchestrate the parent-CSV → row-entity fan-out.
//
// Called once per parent CSV per cycle, after change detection has
// determined work is needed. Pipeline:
//
//   bytes (from readEntityContent) → parseCsv → coerce → filter
//      → three-way diff against the row state → emit createEntity /
//      updateEntity / deleteEntity → stage the row state, which reaches
//      its table once the catalog has persisted those rows (lib/state.js).
//
// The bytes themselves come from readEntityContent — that's the
// substrate-side composition that lets local files, gdrive sheets
// exported as CSV, and HTTP URLs all share this codepath with no
// special-casing here.

import { createHash } from 'node:crypto'
import { readEntityContent } from 'mikser-io'
import { parseCsv } from './parse.js'
import { applyFilter } from './filter.js'
import { indexByKey, threeWayDiff } from './diff.js'
import {
    getPreviousRows, upsertRow, deleteRow,
} from './state.js'
import { buildRowEntity } from './entity.js'

function checksumOf(text) {
    return createHash('sha256').update(text).digest('hex')
}

// `key` is the operator's match-map key (used in log lines).
//
// Parent state lives on the parent entity itself:
//   parent.checksum        — sha256 of the last successfully-parsed CSV
//                            body. The fast skip-if-unchanged gate.
//   parent.meta.csvColumns — column order from the last parse (diagnostic).
//   parent.content         — URL parents only (`owned`): the body that
//                            checksum describes. Set together with it and
//                            never apart.
//
// Why a URL parent carries its body: a second fetch of a URL is not the same
// read. A published Google Sheet sends no ETag or Last-Modified, so the http
// provider has nothing to revalidate against and every read goes to an edge —
// and right after a publish the edges disagree. A reader that fetches the
// parent after the fanout can get the other version, and every later poll
// finds the fanout's checksum unchanged and stays silent, so that reader keeps
// it until the sheet changes again. With the body on the entity,
// readEntityContent hands every later reader in the cycle these bytes without
// fetching. Glob parents belong to whichever source emitted them and are left
// as they came.
//
// `owned` parents are therefore read with `reload`, because the content they
// arrive with is last cycle's — unless `fetched` is given: the body the poll
// already fetched to decide there was a change. Fetching again could get the
// edge that still serves the old one, find the checksum unchanged, and skip
// the change the poll just saw.
//
// fanoutParent MUTATES parent in place on those fields when content
// changes. Caller is responsible for persisting:
//   - onProcess callers iterate via useJournal; mutation triggers
//     auto-persist (mikser-io/src/journal.js useJournal contract).
//   - cold-start / out-of-cycle callers must call updateEntity(parent)
//     themselves.
// The parser options live on the entry itself — `delimiter`, `quote`,
// `headerless`, `columns`, `coerce`, `headerRow`, `lineColumn` — which is what
// the README documents and what an operator writes.
//
// They used to be read from `config.parseOptions`, which NOTHING ever
// populated, so every one of those documented fields was silently ignored: a
// TSV configured with `delimiter: '\t'` was parsed with commas and failed as
// `Invalid Record Length`, pointing at the data rather than at the config.
// `parseOptions` is still honoured, and still wins, as an escape hatch for a
// csv-parse option this plugin has no opinion about.
export function parserOptionsFrom(config = {}) {
    const {
        delimiter, quote, headerless, columns, coerce, relaxColumnCount,
        headerRow, lineColumn, parseOptions,
    } = config
    return {
        ...(delimiter !== undefined && { delimiter }),
        ...(quote !== undefined && { quote }),
        ...(headerless !== undefined && { headerless }),
        ...(columns !== undefined && { columns }),
        ...(coerce !== undefined && { coerce }),
        ...(relaxColumnCount !== undefined && { relaxColumnCount }),
        ...(headerRow !== undefined && { headerRow }),
        ...(lineColumn !== undefined && { lineColumn }),
        ...parseOptions,
    }
}

export async function fanoutParent({
    parent, key, config, compiledFilter,
    createEntity, updateEntity, deleteEntity,
    logger,
    owned = false,
    fetched,
}) {
    const { idColumn, prefix, collection, force, meta: metaDefaults } = config

    const content = typeof fetched === 'string'
        ? { content: fetched }
        : await readEntityContent(parent, { reload: owned })
    if (content.contentError) {
        logger.warn('Csv: %s — readEntityContent failed: %s', parent.id, content.contentError)
        return { skipped: true, reason: content.contentError }
    }
    if (typeof content.content !== 'string') {
        logger.warn('Csv: %s — readEntityContent returned non-text (binary? skipped: %s)',
            parent.id, content.contentSkipped ?? '(unknown)')
        return { skipped: true, reason: 'non-text content' }
    }

    const checksum = checksumOf(content.content)
    if (!force && parent.checksum === checksum) {
        // Unchanged bytes are still the rows' body, and the parent may not
        // carry it yet.
        if (owned) parent.content = content.content
        logger.trace('Csv: %s — unchanged checksum, skipping', parent.id)
        return { skipped: true, reason: 'unchanged' }
    }

    const { columns, rows: parsedRows } = parseCsv(content.content, parserOptionsFrom(config))
    const ctx = { parent, key, columnNames: columns }
    const filteredRows = applyFilter(parsedRows, compiledFilter, ctx)

    const { byKey: currentMap, dropped } = indexByKey(filteredRows, idColumn)
    if (dropped.length) {
        logger.warn('Csv: %s — %d rows dropped (missing/empty %s)',
            parent.id, dropped.length, idColumn)
    }

    const previousRows = getPreviousRows(parent.id)
    const diff = threeWayDiff(previousRows, currentMap)

    for (const { row, rowHash } of diff.created) {
        const entity = buildRowEntity({
            row, rowKey: String(row[idColumn]),
            parent, prefix, collection, idColumn, metaDefaults,
        })
        await createEntity(entity)
        upsertRow(parent.id, String(row[idColumn]), entity.id, rowHash)
    }
    for (const { row, rowHash } of diff.updated) {
        const entity = buildRowEntity({
            row, rowKey: String(row[idColumn]),
            parent, prefix, collection, idColumn, metaDefaults,
        })
        await updateEntity(entity)
        upsertRow(parent.id, String(row[idColumn]), entity.id, rowHash)
    }
    for (const { key: rowKey, prevEntityId } of diff.deleted) {
        await deleteEntity({ id: prevEntityId, collection })
        deleteRow(parent.id, rowKey)
    }

    // Stamp parent — auto-persist (when fanout runs inside an
    // onProcess useJournal walk) carries this onto the journal row,
    // and onPersist flushes it to mikser_entities.
    parent.checksum = checksum
    if (owned) parent.content = content.content
    parent.meta = { ...(parent.meta ?? {}), csvColumns: columns }

    const excluded = parsedRows.length - filteredRows.length
    logger.info(
        'Csv: %s — %d parsed, %d passed filter%s; diff %d create + %d update + %d delete',
        parent.id, parsedRows.length, filteredRows.length,
        excluded ? ` (${excluded} excluded by filter)` : '',
        diff.created.length, diff.updated.length, diff.deleted.length,
    )

    return {
        skipped: false,
        parsedCount: parsedRows.length,
        passedFilterCount: filteredRows.length,
        excludedCount: excluded,
        droppedCount: dropped.length,
        created: diff.created.length,
        updated: diff.updated.length,
        deleted: diff.deleted.length,
    }
}
