// Per-row state for csv fan-out.
//
// One table in the engine's sqlite (via registerSchema):
//
//   mikser_csv_rows — one row per row entity ever emitted. Indexed
//     by (parent_id, row_key). Carries the entity id + row_hash so
//     the three-way diff can run by-key without re-fetching entities.
//
// Parent-level state (file checksum + column snapshot) lives on the
// parent entity itself: `entity.checksum` (engine-tracked, persisted
// on `mikser_entities.data` via JSON, indexed via json_extract) and
// `entity.meta.csvColumns` (diagnostic — the diff doesn't depend on
// it). Keeping it on the entity collapses what used to be a parallel
// `mikser_csv_state` table into the catalog's existing per-entity
// store; one place to look, one schema to evolve.

import { registerSchema, useDatabase } from 'mikser-io'

// NOTE: no FK to mikser_entities on parent_id. The csv plugin can write
// state for a parent whose CREATE journal entry hasn't yet been
// persisted to mikser_entities (onProcess fires while pending entries
// are still draining). Cleanup-on-parent-delete is handled explicitly
// in the onProcess loop's OPERATION.DELETE branch instead.
registerSchema('csv', `
    CREATE TABLE IF NOT EXISTS mikser_csv_rows (
        parent_id          TEXT NOT NULL,
        row_key            TEXT NOT NULL,
        entity_id          TEXT NOT NULL,
        row_hash           TEXT NOT NULL,
        last_seen_at       INTEGER,
        PRIMARY KEY (parent_id, row_key)
    );
    CREATE INDEX IF NOT EXISTS idx_mikser_csv_rows_entity ON mikser_csv_rows(entity_id);
    CREATE INDEX IF NOT EXISTS idx_mikser_csv_rows_parent ON mikser_csv_rows(parent_id);
`)

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

// Called from the csv plugin's onProcess when the parent CSV entity
// is itself deleted. Returns the list of orphaned row entity ids so
// the caller can issue deleteEntity for each.
export function dropAllForParent(parentId) {
    const db = useDatabase().handle
    const orphanedIds = db.prepare(
        `SELECT entity_id FROM mikser_csv_rows WHERE parent_id = ?`
    ).all(parentId).map(r => r.entity_id)
    db.prepare(`DELETE FROM mikser_csv_rows WHERE parent_id = ?`).run(parentId)
    return orphanedIds
}
