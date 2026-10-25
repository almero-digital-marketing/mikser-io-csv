import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parserOptionsFrom } from '../lib/fanout.js'

describe('parserOptionsFrom — the documented entry fields reach the parser', () => {
    it('maps the flat per-entry fields', () => {
        // The regression this guards: fanout read config.parseOptions, which
        // nothing populated, so every documented field — delimiter above all —
        // was silently ignored. A TSV configured correctly was parsed with
        // commas and failed as Invalid Record Length, blaming the data.
        const options = parserOptionsFrom({
            idColumn: 'sku', prefix: '/p/', collection: 'documents',
            delimiter: '\t', quote: false, coerce: true, relaxColumnCount: true,
        })
        assert.equal(options.delimiter, '\t')
        assert.equal(options.quote, false)
        assert.equal(options.coerce, true)
        assert.equal(options.relaxColumnCount, true)
    })

    it('maps headerRow and lineColumn', () => {
        const options = parserOptionsFrom({
            idColumn: 'row', prefix: '/p/', collection: 'documents', headerRow: 2, lineColumn: 'row',
        })
        assert.equal(options.headerRow, 2)
        assert.equal(options.lineColumn, 'row')
    })

    it('omits what was not configured, so parseCsv keeps its own defaults', () => {
        const options = parserOptionsFrom({ idColumn: 'sku', prefix: '/p/', collection: 'documents' })
        assert.ok(!('delimiter' in options))
        assert.ok(!('quote' in options))
    })

    it('parseOptions still works and wins, as an escape hatch', () => {
        const options = parserOptionsFrom({ delimiter: ',', parseOptions: { delimiter: ';' } })
        assert.equal(options.delimiter, ';')
    })
})
