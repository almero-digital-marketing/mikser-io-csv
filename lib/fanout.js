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
    getParentState, setParentState,
    getPreviousRows, upsertRow, deleteRow,
} from './state.js'
import { buildRowEntity } from './entity.js'

function checksumOf(text) {
    return createHash('sha256').update(text).digest('hex')
}

// `key` is the operator's match-map key (used in log lines).
export async function fanoutParent({
    parent, key, config, compiledFilter,
    createEntity, updateEntity, deleteEntity,
    logger,
}) {
    const { idColumn, prefix, collection, parseOptions, force } = config

    const content = await readEntityContent(parent)
    if (content.contentError) {
        logger.warn('csv: %s — readEntityContent failed: %s', parent.id, content.contentError)
        return { skipped: true, reason: content.contentError }
    }
    if (typeof content.content !== 'string') {
        logger.warn('csv: %s — readEntityContent returned non-text (binary? skipped: %s)',
            parent.id, content.contentSkipped ?? '(unknown)')
        return { skipped: true, reason: 'non-text content' }
    }

    const checksum = checksumOf(content.content)
    const prevState = getParentState(parent.id)
    if (!force && prevState?.file_checksum === checksum) {
        logger.trace('csv: %s — unchanged checksum, skipping', parent.id)
        return { skipped: true, reason: 'unchanged' }
    }

    const { columns, rows: parsedRows } = parseCsv(content.content, parseOptions)
    const ctx = { parent, key, columnNames: columns }
    const filteredRows = applyFilter(parsedRows, compiledFilter, ctx)

    const { byKey: currentMap, dropped } = indexByKey(filteredRows, idColumn)
    if (dropped.length) {
        logger.warn('csv: %s — %d rows dropped (missing/empty %s)',
            parent.id, dropped.length, idColumn)
    }

    const previousRows = getPreviousRows(parent.id)
    const diff = threeWayDiff(previousRows, currentMap)

    for (const { row, rowHash } of diff.created) {
        const entity = buildRowEntity({
            row, rowKey: String(row[idColumn]),
            parent, prefix, collection, idColumn,
        })
        await createEntity(entity)
        upsertRow(parent.id, String(row[idColumn]), entity.id, rowHash)
    }
    for (const { row, rowHash } of diff.updated) {
        const entity = buildRowEntity({
            row, rowKey: String(row[idColumn]),
            parent, prefix, collection, idColumn,
        })
        await updateEntity(entity)
        upsertRow(parent.id, String(row[idColumn]), entity.id, rowHash)
    }
    for (const { key: rowKey, prevEntityId } of diff.deleted) {
        await deleteEntity({ id: prevEntityId, collection })
        deleteRow(parent.id, rowKey)
    }

    setParentState(parent.id, checksum, columns)

    const excluded = parsedRows.length - filteredRows.length
    logger.info(
        'csv: %s — %d parsed, %d passed filter%s; diff %d create + %d update + %d delete',
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
