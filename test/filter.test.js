import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { compileFilter, applyFilter } from '../lib/filter.js'

describe('filter — sift queries', () => {
    it('exact equality on a single field', () => {
        const f = compileFilter({ status: 'published' })
        const out = applyFilter(
            [{ status: 'published' }, { status: 'draft' }, { status: 'published' }],
            f,
        )
        assert.equal(out.length, 2)
    })

    it('$gt / $lte range comparisons (after coercion the values are numbers)', () => {
        const f = compileFilter({ price: { $gt: 10, $lte: 100 } })
        const out = applyFilter(
            [{ price: 5 }, { price: 15 }, { price: 100 }, { price: 200 }],
            f,
        )
        assert.deepEqual(out.map(r => r.price), [15, 100])
    })

    it('$in set membership', () => {
        const f = compileFilter({ category: { $in: ['gadgets', 'widgets'] } })
        const out = applyFilter(
            [{ category: 'gadgets' }, { category: 'tools' }, { category: 'widgets' }],
            f,
        )
        assert.equal(out.length, 2)
    })

    it('$and combines conditions', () => {
        const f = compileFilter({ $and: [{ status: 'published' }, { price: { $gt: 0 } }] })
        const out = applyFilter(
            [
                { status: 'published', price: 10 },
                { status: 'published', price: 0  },
                { status: 'draft',     price: 50 },
            ],
            f,
        )
        assert.equal(out.length, 1)
        assert.equal(out[0].price, 10)
    })

    it('$ne excludes the matched value', () => {
        const f = compileFilter({ status: { $ne: 'cancelled' } })
        const out = applyFilter(
            [{ status: 'cancelled' }, { status: 'shipped' }, { status: 'pending' }],
            f,
        )
        assert.equal(out.length, 2)
    })

    it('compile-once: same compiled filter reusable across calls', () => {
        const f = compileFilter({ active: true })
        const a = applyFilter([{ active: true }, { active: false }], f)
        const b = applyFilter([{ active: true }], f)
        assert.equal(a.length, 1)
        assert.equal(b.length, 1)
    })
})

describe('filter — function form', () => {
    it('plain function predicate', () => {
        const f = compileFilter(row => row.amount * row.quantity > 100)
        const out = applyFilter(
            [{ amount: 10, quantity: 5 }, { amount: 20, quantity: 6 }, { amount: 1, quantity: 1 }],
            f,
        )
        assert.equal(out.length, 1)
        assert.equal(out[0].quantity, 6)
    })

    it('function receives ctx as second arg', () => {
        let seenCtx = null
        const f = compileFilter((row, ctx) => { seenCtx = ctx; return true })
        const ctx = { parent: { id: '/p' }, key: '/csv', columnNames: ['a', 'b'] }
        applyFilter([{ a: 1 }], f, ctx)
        assert.equal(seenCtx.key, '/csv')
        assert.equal(seenCtx.parent.id, '/p')
        assert.deepEqual(seenCtx.columnNames, ['a', 'b'])
    })
})

describe('filter — null / invalid spec', () => {
    it('null compiles to null; applyFilter passes all rows through', () => {
        const f = compileFilter(null)
        const out = applyFilter([{ a: 1 }, { a: 2 }], f)
        assert.equal(out.length, 2)
    })

    it('throws on unexpected spec types (number, string)', () => {
        assert.throws(() => compileFilter(42), /filter must be a sift query object or a function/)
        assert.throws(() => compileFilter('status=published'), /filter must be a sift query object or a function/)
    })
})
