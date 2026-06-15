// Persistent state for csv fan-out.
//
// Two tables in the engine's sqlite (via registerSchema):
//
//   mikser_csv_state — one row per parent CSV. file_checksum is the
//     fast gate (file unchanged → no work). columns_json carries the
//     column-order snapshot for diagnostics; the diff doesn't depend
//     on it.
//
//   mikser_csv_rows — one row per row entity ever emitted. Indexed
//     by (parent_id, row_key). Carries the entity id + row_hash so
//     the three-way diff can run by-key without re-fetching entities.
//     FK CASCADE on the engine's mikser_entities so a parent delete
//     cascades the row records away naturally.

import { registerSchema, useDatabase } from 'mikser-io'

registerSchema('csv', `
    CREATE TABLE IF NOT EXISTS mikser_csv_state (
        parent_id          TEXT PRIMARY KEY REFERENCES mikser_entities(id) ON DELETE CASCADE,
        file_checksum      TEXT,
        columns_json       TEXT,
        last_scanned_at    INTEGER
    );
    CREATE TABLE IF NOT EXISTS mikser_csv_rows (
        parent_id          TEXT NOT NULL,
        row_key            TEXT NOT NULL,
        entity_id          TEXT NOT NULL,
        row_hash           TEXT NOT NULL,
        last_seen_at       INTEGER,
        PRIMARY KEY (parent_id, row_key),
        FOREIGN KEY (parent_id) REFERENCES mikser_entities(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_mikser_csv_rows_entity ON mikser_csv_rows(entity_id);
`)

export function getParentState(parentId) {
    return useDatabase().handle.prepare(
        `SELECT file_checksum, columns_json, last_scanned_at FROM mikser_csv_state WHERE parent_id = ?`
    ).get(parentId) ?? null
}

export function setParentState(parentId, fileChecksum, columns) {
    useDatabase().handle.prepare(`
        INSERT INTO mikser_csv_state (parent_id, file_checksum, columns_json, last_scanned_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(parent_id) DO UPDATE SET
            file_checksum   = excluded.file_checksum,
            columns_json    = excluded.columns_json,
            last_scanned_at = excluded.last_scanned_at
    `).run(parentId, fileChecksum, JSON.stringify(columns ?? []), Date.now())
}

// Returns Map<rowKey, { rowHash, entity_id }>.
export function getPreviousRows(parentId) {
    const rows = useDatabase().handle.prepare(
        `SELECT row_key, row_hash, entity_id FROM mikser_csv_rows WHERE parent_id = ?`
    ).all(parentId)
    const out = new Map()
    for (const r of rows) {
        out.set(r.row_key, { rowHash: r.row_hash, entity_id: r.entity_id })
    }
    return out
}

export function upsertRow(parentId, rowKey, entityId, rowHash) {
    useDatabase().handle.prepare(`
        INSERT INTO mikser_csv_rows (parent_id, row_key, entity_id, row_hash, last_seen_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(parent_id, row_key) DO UPDATE SET
            entity_id    = excluded.entity_id,
            row_hash     = excluded.row_hash,
            last_seen_at = excluded.last_seen_at
    `).run(parentId, rowKey, entityId, rowHash, Date.now())
}

export function deleteRow(parentId, rowKey) {
    useDatabase().handle.prepare(
        `DELETE FROM mikser_csv_rows WHERE parent_id = ? AND row_key = ?`
    ).run(parentId, rowKey)
}
