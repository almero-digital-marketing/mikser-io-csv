// Three-way row diff by `idColumn` value.
//
// Given previous-state rows from the sqlite cache and freshly-parsed
// rows from the current CSV, returns:
//
//   { created: [...], updated: [...], deleted: [...] }
//
//   - created: rowKey present in `current` but not in `previous`.
//   - updated: rowKey in both, but the row hash differs.
//   - deleted: rowKey in `previous` but not in `current`.
//
// Filtered-out rows look indistinguishable from deleted rows — they
// just aren't in `current` after filter.applyFilter has run. The diff
// emits a delete for them, which is the right behaviour: an entity
// that no longer passes the filter shouldn't be in the catalog.

import { createHash } from 'node:crypto'

export function hashRow(row) {
    // Stable hash: sort keys before stringifying so column-order
    // changes between CSV edits don't trigger spurious updates.
    const keys = Object.keys(row).sort()
    const canon = {}
    for (const k of keys) canon[k] = row[k]
    return createHash('sha256').update(JSON.stringify(canon)).digest('hex')
}

// Build a Map<rowKey, { row, rowHash }> from an array of rows.
// Reads idColumn off each row to determine the key. Rows where the
// id column is missing or empty are dropped (logged at the call site).
export function indexByKey(rows, idColumn) {
    const out = new Map()
    const dropped = []
    for (const row of rows) {
        const v = row?.[idColumn]
        if (v == null || v === '') {
            dropped.push(row)
            continue
        }
        const key = String(v)
        out.set(key, { row, rowHash: hashRow(row) })
    }
    return { byKey: out, dropped }
}

// Three-way diff. previousRows is Map<rowKey, { row_hash }>; currentMap
// is the output of indexByKey on the freshly-parsed (and filtered) set.
export function threeWayDiff(previousRows, currentMap) {
    const created = []
    const updated = []
    const deleted = []

    for (const [key, { row, rowHash }] of currentMap) {
        const prev = previousRows.get(key)
        if (!prev) {
            created.push({ key, row, rowHash })
        } else if (prev.rowHash !== rowHash) {
            updated.push({ key, row, rowHash })
        }
    }
    for (const [key, prev] of previousRows) {
        if (!currentMap.has(key)) {
            deleted.push({ key, prevEntityId: prev.entity_id })
        }
    }
    return { created, updated, deleted }
}
