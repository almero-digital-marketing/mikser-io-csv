import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { hashRow, indexByKey, threeWayDiff } from '../lib/diff.js'

describe('hashRow', () => {
    it('hash is stable across key reordering', () => {
        const a = hashRow({ sku: 'A-1', name: 'Widget', price: 19.99 })
        const b = hashRow({ price: 19.99, sku: 'A-1', name: 'Widget' })
        assert.equal(a, b)
    })

    it('different values yield different hashes', () => {
        const a = hashRow({ sku: 'A-1', name: 'Widget' })
        const b = hashRow({ sku: 'A-1', name: 'Gadget' })
        assert.notEqual(a, b)
    })

    it('handles nested values', () => {
        const a = hashRow({ tags: ['x', 'y'], meta: { count: 1 } })
        const b = hashRow({ tags: ['x', 'y'], meta: { count: 1 } })
        assert.equal(a, b)
    })
})

describe('indexByKey', () => {
    it('builds map keyed by idColumn value', () => {
        const { byKey, dropped } = indexByKey(
            [
                { sku: 'A-1', name: 'Widget' },
                { sku: 'A-2', name: 'Gadget' },
            ],
            'sku',
        )
        assert.equal(byKey.size, 2)
        assert.equal(byKey.get('A-1').row.name, 'Widget')
        assert.equal(byKey.get('A-2').row.name, 'Gadget')
        assert.equal(dropped.length, 0)
    })

    it('drops rows with missing / empty id column values', () => {
        const { byKey, dropped } = indexByKey(
            [
                { sku: 'A-1', name: 'Widget' },
                { sku: '',    name: 'No-id Row' },
                { sku: null,  name: 'Null Row' },
                { sku: 'A-2', name: 'Gadget' },
            ],
            'sku',
        )
        assert.equal(byKey.size, 2)
        assert.equal(dropped.length, 2)
    })

    it('coerces numeric ids to strings (matching what state table stores)', () => {
        const { byKey } = indexByKey([{ id: 1, x: 'a' }, { id: 2, x: 'b' }], 'id')
        assert.equal(byKey.has('1'), true)
        assert.equal(byKey.has('2'), true)
    })
})

describe('threeWayDiff', () => {
    function asPrev(rows) {
        // Helper: build a previous-state map matching state.js shape.
        const m = new Map()
        for (const { key, row, entity_id } of rows) {
            m.set(key, {
                rowHash:   hashRow(row),
                entity_id: entity_id ?? `/x/${key}`,
            })
        }
        return m
    }

    it('detects creates: keys only in current', () => {
        const prev = asPrev([{ key: 'A', row: { sku: 'A', n: 1 } }])
        const curr = indexByKey([{ sku: 'A', n: 1 }, { sku: 'B', n: 2 }], 'sku').byKey
        const diff = threeWayDiff(prev, curr)
        assert.equal(diff.created.length, 1)
        assert.equal(diff.created[0].key, 'B')
        assert.equal(diff.updated.length, 0)
        assert.equal(diff.deleted.length, 0)
    })

    it('detects updates: same key, different hash', () => {
        const prev = asPrev([{ key: 'A', row: { sku: 'A', n: 1 } }])
        const curr = indexByKey([{ sku: 'A', n: 2 }], 'sku').byKey
        const diff = threeWayDiff(prev, curr)
        assert.equal(diff.created.length, 0)
        assert.equal(diff.updated.length, 1)
        assert.equal(diff.updated[0].key, 'A')
        assert.equal(diff.updated[0].row.n, 2)
        assert.equal(diff.deleted.length, 0)
    })

    it('detects deletes: keys only in previous', () => {
        const prev = asPrev([
            { key: 'A', row: { sku: 'A', n: 1 } },
            { key: 'B', row: { sku: 'B', n: 2 } },
        ])
        const curr = indexByKey([{ sku: 'A', n: 1 }], 'sku').byKey
        const diff = threeWayDiff(prev, curr)
        assert.equal(diff.deleted.length, 1)
        assert.equal(diff.deleted[0].key, 'B')
        assert.equal(diff.deleted[0].prevEntityId, '/x/B')
    })

    it('no diffs when previous and current are identical', () => {
        const prev = asPrev([{ key: 'A', row: { sku: 'A', n: 1 } }])
        const curr = indexByKey([{ sku: 'A', n: 1 }], 'sku').byKey
        const diff = threeWayDiff(prev, curr)
        assert.equal(diff.created.length, 0)
        assert.equal(diff.updated.length, 0)
        assert.equal(diff.deleted.length, 0)
    })

    it('mixed: create + update + delete in one pass', () => {
        const prev = asPrev([
            { key: 'A', row: { sku: 'A', n: 1 } },     // updated next
            { key: 'B', row: { sku: 'B', n: 1 } },     // deleted next
            { key: 'C', row: { sku: 'C', n: 1 } },     // unchanged
        ])
        const curr = indexByKey([
            { sku: 'A', n: 2 },                        // update (hash changed)
            { sku: 'C', n: 1 },                        // unchanged
            { sku: 'D', n: 4 },                        // new
        ], 'sku').byKey
        const diff = threeWayDiff(prev, curr)
        assert.deepEqual(diff.created.map(c => c.key), ['D'])
        assert.deepEqual(diff.updated.map(u => u.key), ['A'])
        assert.deepEqual(diff.deleted.map(d => d.key), ['B'])
    })
})
