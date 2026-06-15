// Orchestrate the parent-CSV → row-entity fan-out.
//
// Called once per parent CSV per cycle, after change detection has
// determined work is needed. Pipeline:
//
//   bytes (from readEntityContent) → parseCsv → coerce → filter
//      → three-way diff against persisted state → emit createEntity /
//      updateEntity / deleteEntity → update state.
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
//
// fanoutParent MUTATES parent in place on those two fields when content
// changes. Caller is responsible for persisting:
//   - onProcess callers iterate via useJournal; mutation triggers
//     auto-persist (mikser-io/src/journal.js useJournal contract).
//   - cold-start / out-of-cycle callers must call updateEntity(parent)
//     themselves.
export async function fanoutParent({
    parent, key, config, compiledFilter,
    createEntity, updateEntity, deleteEntity,
    logger,
}) {
    const { idColumn, prefix, collection, parseOptions, force, meta: metaDefaults } = config

    const content = await readEntityContent(parent)
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
        logger.trace('Csv: %s — unchanged checksum, skipping', parent.id)
        return { skipped: true, reason: 'unchanged' }
    }

    const { columns, rows: parsedRows } = parseCsv(content.content, parseOptions)
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
