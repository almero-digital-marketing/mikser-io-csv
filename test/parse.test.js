import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseCsv } from '../lib/parse.js'

describe('parseCsv — headers + basic parsing', () => {
    it('first row is headers by default; rows are objects keyed by column name', () => {
        const { columns, rows } = parseCsv('sku,name,price\nA-1,Widget,19.99\nA-2,Gadget,29.99')
        assert.deepEqual(columns, ['sku', 'name', 'price'])
        assert.equal(rows.length, 2)
        assert.equal(rows[0].sku, 'A-1')
        assert.equal(rows[0].name, 'Widget')
        assert.equal(rows[0].price, '19.99')        // strings without coerce
    })

    it('handles quoted fields with embedded commas + newlines', () => {
        const csv =
            'sku,description\n' +
            '"A-1","Widget, comma\nand newline"\n' +
            'A-2,Simple'
        const { rows } = parseCsv(csv)
        assert.equal(rows[0].description, 'Widget, comma\nand newline')
        assert.equal(rows[1].description, 'Simple')
    })

    it('supports custom delimiter (TSV)', () => {
        const tsv = 'sku\tname\nA-1\tWidget\n'
        const { rows } = parseCsv(tsv, { delimiter: '\t' })
        assert.equal(rows[0].sku, 'A-1')
        assert.equal(rows[0].name, 'Widget')
    })

    it('supports headerless: true + operator-supplied columns', () => {
        const csv = 'A-1,Widget,19.99\nA-2,Gadget,29.99\n'
        const { rows, columns } = parseCsv(csv, {
            headerless: true,
            columns: ['sku', 'name', 'price'],
        })
        assert.deepEqual(columns, ['sku', 'name', 'price'])
        assert.equal(rows[0].sku, 'A-1')
    })

    it('throws if headerless: true without columns', () => {
        assert.throws(
            () => parseCsv('A-1,Widget', { headerless: true }),
            /headerless: true requires `columns:/,
        )
    })

    it('skips blank lines', () => {
        const csv = 'a,b\n1,2\n\n3,4\n'
        const { rows } = parseCsv(csv)
        assert.equal(rows.length, 2)
    })
})

describe('parseCsv — coercion: auto (coerce: true)', () => {
    it('coerces numeric strings to numbers', () => {
        const { rows } = parseCsv('sku,price\nA-1,19.99\nA-2,100', { coerce: true })
        assert.equal(rows[0].price, 19.99)
        assert.equal(rows[1].price, 100)
    })

    it('preserves leading-zero strings (SKUs like 01234)', () => {
        // Casual numeric coercion would lose the leading zero — that's
        // information, not noise, so the parser leaves it alone.
        const { rows } = parseCsv('sku,code\nA-1,01234\nA-2,0', { coerce: true })
        assert.equal(rows[0].code, '01234')
        assert.equal(rows[1].code, 0)            // bare '0' is fine
    })

    it('coerces true/false strings to booleans', () => {
        const { rows } = parseCsv('id,active\n1,true\n2,FALSE', { coerce: true })
        assert.equal(rows[0].active, true)
        assert.equal(rows[1].active, false)
    })

    it('coerces ISO datetime strings to normalized ISO strings', () => {
        const { rows } = parseCsv('id,placedAt\n1,2026-06-15T09:30:00Z\n2,2026-01-01', { coerce: true })
        assert.equal(rows[0].placedAt, new Date('2026-06-15T09:30:00Z').toISOString())
        assert.equal(rows[1].placedAt, new Date('2026-01-01').toISOString())
    })

    it('empty cells become null', () => {
        const { rows } = parseCsv('a,b,c\n1,,3\n', { coerce: true })
        assert.equal(rows[0].a, 1)
        assert.equal(rows[0].b, null)
        assert.equal(rows[0].c, 3)
    })

    it('leaves unrecognised strings alone', () => {
        const { rows } = parseCsv('name\nWidget', { coerce: true })
        assert.equal(rows[0].name, 'Widget')
    })
})

describe('parseCsv — coercion: per-column object', () => {
    it('coerces only the columns named in coerce', () => {
        const { rows } = parseCsv(
            'sku,price,launchedAt\nA-1,19.99,2026-01-01\n',
            { coerce: { price: 'number', launchedAt: 'date' } },
        )
        assert.equal(rows[0].sku, 'A-1')                                            // string (no rule)
        assert.equal(rows[0].price, 19.99)                                          // number
        assert.equal(rows[0].launchedAt, new Date('2026-01-01').toISOString())      // date
    })

    it('explicit string type leaves leading-zero-like values verbatim', () => {
        const { rows } = parseCsv('sku\n01234', { coerce: { sku: 'string' } })
        assert.equal(rows[0].sku, '01234')
    })

    it('boolean coercion handles 1/0 and yes/no aliases', () => {
        const { rows } = parseCsv(
            'a,b,c,d,e\n1,0,yes,no,maybe',
            { coerce: { a: 'boolean', b: 'boolean', c: 'boolean', d: 'boolean', e: 'boolean' } },
        )
        assert.equal(rows[0].a, true)
        assert.equal(rows[0].b, false)
        assert.equal(rows[0].c, true)
        assert.equal(rows[0].d, false)
        assert.equal(rows[0].e, 'maybe')         // unparseable → original value
    })

    it('coerce: undefined means no coercion (everything stays strings)', () => {
        const { rows } = parseCsv('id,price\n1,19.99\n')
        assert.equal(rows[0].id, '1')
        assert.equal(rows[0].price, '19.99')
    })
})

describe('parseCsv — TSV and ragged sheets', () => {
    it('quote: false treats a double quote as a literal character', () => {
        // A spreadsheet exports a cell like `"CELESTETIC"()` verbatim. TSV has no
        // quoting convention, but csv-parse still defaults to quote: '"' and dies
        // with Invalid Closing Quote — taking the whole file, not just the cell.
        const tsv = 'brand\tname\n"CELESTETIC"()\tSoftClean'
        assert.throws(() => parseCsv(tsv, { delimiter: '\t' }), /Invalid Closing Quote/)

        const { rows } = parseCsv(tsv, { delimiter: '\t', quote: false })
        assert.equal(rows.length, 1)
        assert.equal(rows[0].brand, '"CELESTETIC"()')
        assert.equal(rows[0].name, 'SoftClean')
    })

    it('relaxColumnCount tolerates a short row, and is off by default', () => {
        // Off by default on purpose: in a real CSV a length mismatch usually
        // means the delimiter is wrong, and that should be loud.
        const csv = 'a,b,c\n1,2,3\n4,5'
        assert.throws(() => parseCsv(csv), /Invalid Record Length/)

        const { rows } = parseCsv(csv, { relaxColumnCount: true })
        assert.equal(rows.length, 2)
        assert.equal(rows[1].a, '4')
        assert.equal(rows[1].c, null)   // csv-parse fills a missing column with null, not undefined
    })

    it('a tab-delimited file with comma-bearing values parses on delimiter alone', () => {
        // "9,300 €" is why the delimiter matters here rather than being cosmetic:
        // parsed as CSV the price splits in two and the record no longer matches
        // the header.
        const tsv = 'device\tsku\tprice\nNOVAPRESS\tLC0002201\t9,300 €'
        assert.throws(() => parseCsv(tsv), /Invalid Record Length/)

        const { rows } = parseCsv(tsv, { delimiter: '\t' })
        assert.equal(rows[0].price, '9,300 €')
    })
})
