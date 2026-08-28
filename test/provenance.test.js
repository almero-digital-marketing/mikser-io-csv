import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import '../index.js'   // side-effect: registers the csv-row provenance handler
import { positionsForSource } from 'mikser-io'

// A row entity is synthetic — no uri, no file of its own. But its values were
// written on one line of the parent csv, and the engine hands this handler the
// parent's text, so there IS somewhere to point.
describe('csv row provenance', () => {
    const RAW = 'slug,name,role\nada,Ada Lovelace,author\ngrace,Grace Hopper,editor\n'
    const row = (meta) => ({ format: 'csv-row', parent: '/files/people.csv', meta })

    it('finds the row by its key, not by counting rows', () => {
        // Rows are filtered before fan-out and a quoted field may contain a
        // newline, so "the Nth row" and "the Nth line" are different numbers.
        const positions = positionsForSource(RAW, row({ slug: 'grace', name: 'Grace Hopper', role: 'editor' }))
        assert.equal(positions.slug.line, 3)
        assert.equal(positions.name.line, 3)
    })

    it('gives each column its own column position within that line', () => {
        const positions = positionsForSource(RAW, row({ slug: 'grace', name: 'Grace Hopper', role: 'editor' }))
        const line = RAW.split('\n')[positions.name.line - 1]
        assert.equal(line.slice(positions.name.col, positions.name.col + 'Grace Hopper'.length), 'Grace Hopper')
        assert.equal(line.slice(positions.role.col), 'editor')
    })

    it('does not confuse a key that is a prefix of another', () => {
        // `12` must not match inside `123`, or every row resolves to the first
        // one that happens to contain its digits.
        const raw = 'id,name\n123,Long\n12,Short\n'
        const positions = positionsForSource(raw, row({ id: '12', name: 'Short' }))
        assert.equal(positions.id.line, 3)
    })

    it('returns nothing rather than a wrong line when the row is not found', () => {
        // A value rewritten by a filter appears nowhere verbatim. Pointing at
        // the header would be worse than pointing nowhere.
        assert.deepEqual(positionsForSource(RAW, row({ slug: 'nobody', name: 'Nobody Here' })), {})
    })
})
