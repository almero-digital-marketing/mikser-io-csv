// Per-row state for csv fan-out.
//
// One table in the engine's sqlite (via registerSchema):
//
//   mikser_csv_rows — one row per row entity the catalog holds. Indexed
//     by (parent_id, row_key). Carries the entity id + row_hash so
//     the three-way diff can run by-key without re-fetching entities.
//     Written only after persist — see `staged` below.
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

// Writes the catalog has not persisted yet, in the order they were made.
//
// The fanout journals each row entity and records its hash here, and the two
// meet only at persist: the catalog applies the journal there. Written to the
// table at once, the hashes ran ahead of the catalog for the rest of the cycle.
// A cycle cancelled before persist left the next fanout diffing against rows
// the catalog did not have yet, so it found nothing to update. A process that
// died before persist — a deploy restarting it during a long cycle — came back
// with its journal discarded and this table saying the rows were done, so the
// change never landed, and restarting again could not help.
//
// So they wait here and reach the table in commitStaged, after the catalog has
// persisted (onPersisted). A cancelled cycle keeps them, as it keeps its
// journal, and the cycle that persists that journal commits them with it. A
// process that dies loses them with its journal. The table is never ahead of
// the catalog, and every read in between sees it with these applied.
const staged = []   // { op: 'upsert' | 'delete' | 'drop', parentId, rowKey?, entityId?, rowHash? }

// Returns Map<rowKey, { rowHash, entity_id }>.
export function getPreviousRows(parentId) {
    const rows = useDatabase().handle.prepare(
        `SELECT row_key, row_hash, entity_id FROM mikser_csv_rows WHERE parent_id = ?`
    ).all(parentId)
    const out = new Map()
    for (const r of rows) {
        out.set(r.row_key, { rowHash: r.row_hash, entity_id: r.entity_id })
    }
    for (const write of staged) {
        if (write.parentId !== parentId) continue
        if (write.op === 'upsert') out.set(write.rowKey, { rowHash: write.rowHash, entity_id: write.entityId })
        else if (write.op === 'delete') out.delete(write.rowKey)
        else out.clear()
    }
    return out
}

export function upsertRow(parentId, rowKey, entityId, rowHash) {
    staged.push({ op: 'upsert', parentId, rowKey, entityId, rowHash })
}

export function deleteRow(parentId, rowKey) {
    staged.push({ op: 'delete', parentId, rowKey })
}

// Called from the csv plugin's onProcess when the parent CSV entity
// is itself deleted. Returns the list of orphaned row entity ids so
// the caller can issue deleteEntity for each.
export function dropAllForParent(parentId) {
    const orphanedIds = [...getPreviousRows(parentId).values()].map(r => r.entity_id)
    staged.push({ op: 'drop', parentId })
    return orphanedIds
}

// Called once the catalog has persisted the cycle that made these writes.
// One transaction, so a crash leaves the table at the last commit rather than
// part way through one.
export function commitStaged() {
    if (!staged.length) return
    const db = useDatabase().handle
    const upsert = db.prepare(`
        INSERT INTO mikser_csv_rows (parent_id, row_key, entity_id, row_hash, last_seen_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(parent_id, row_key) DO UPDATE SET
            entity_id    = excluded.entity_id,
            row_hash     = excluded.row_hash,
            last_seen_at = excluded.last_seen_at
    `)
    const remove = db.prepare(`DELETE FROM mikser_csv_rows WHERE parent_id = ? AND row_key = ?`)
    const drop = db.prepare(`DELETE FROM mikser_csv_rows WHERE parent_id = ?`)
    const now = Date.now()
    db.transaction(() => {
        for (const write of staged) {
            if (write.op === 'upsert') upsert.run(write.parentId, write.rowKey, write.entityId, write.rowHash, now)
            else if (write.op === 'delete') remove.run(write.parentId, write.rowKey)
            else drop.run(write.parentId)
        }
    })()
    // Only once they are in: a commit that throws keeps them for the next
    // persist instead of dropping them.
    staged.length = 0
}
