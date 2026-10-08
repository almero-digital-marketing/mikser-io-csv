// CSV parsing + per-column type coercion.
//
// csv-parse handles the standard hairy parts (quoted fields with
// embedded newlines, escaped delimiters, BOMs, etc.). This module wraps
// it to:
//   - Accept either auto-detected headers (default) or operator-supplied
//     column names (for headerless CSVs).
//   - Apply type coercion per-column. Two shapes supported:
//     * coerce: true        — auto-detect numeric / boolean / date per
//                             value (conservative; falls back to string)
//     * coerce: { col: type } — explicit per-column directives
//                             ('number' | 'boolean' | 'date' | 'string')
//   - Return rows as plain objects keyed by column name (not arrays).
//
// Output shape:
//   { columns: ['sku', 'name', ...], rows: [{sku: 'A-1', name: 'Widget', ...}, ...] }

import { parse } from 'csv-parse/sync'

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/
const NUMERIC_RE  = /^-?\d+(\.\d+)?$/

function coerceValue(raw, type) {
    if (raw == null || raw === '') return null
    if (type === 'string')  return String(raw)
    if (type === 'number') {
        const n = Number(raw)
        return Number.isNaN(n) ? raw : n
    }
    if (type === 'boolean') {
        const s = String(raw).toLowerCase().trim()
        if (s === 'true'  || s === '1' || s === 'yes' || s === 'y') return true
        if (s === 'false' || s === '0' || s === 'no'  || s === 'n') return false
        return raw
    }
    if (type === 'date') {
        const ms = Date.parse(raw)
        return Number.isNaN(ms) ? raw : new Date(ms).toISOString()
    }
    // type === 'auto'
    if (typeof raw !== 'string') return raw
    const s = raw.trim()
    if (s === '') return null
    if (NUMERIC_RE.test(s)) {
        // Don't coerce leading-zero strings (SKUs like "01234"); they
        // look numeric but the leading zero is information.
        if (s.startsWith('0') && s.length > 1 && !s.startsWith('0.')) return raw
        return Number(s)
    }
    const lower = s.toLowerCase()
    if (lower === 'true'  || lower === 'false') return lower === 'true'
    if (ISO_DATE_RE.test(s)) {
        const ms = Date.parse(s)
        if (!Number.isNaN(ms)) return new Date(ms).toISOString()
    }
    return raw
}

function buildCoerceMap(columns, coerce) {
    // Maps column → 'string' | 'number' | 'boolean' | 'date' | 'auto'.
    // 'string' means "leave as-is".
    if (coerce === true || coerce === 'auto') {
        const out = {}
        for (const c of columns) out[c] = 'auto'
        return out
    }
    if (coerce && typeof coerce === 'object') {
        const out = {}
        for (const c of columns) out[c] = coerce[c] ?? 'string'
        return out
    }
    // coerce undefined / false / null → no coercion
    const out = {}
    for (const c of columns) out[c] = 'string'
    return out
}

export function parseCsv(text, options = {}) {
    const {
        delimiter = ',',
        headerless = false,
        columns: operatorColumns,
        coerce,
        // TSV has no quoting convention: a tab separates fields and a `"` is a
        // literal character. csv-parse still defaults to `quote: '"'`, so a cell
        // like `"CELESTETIC"()` — which a spreadsheet exports verbatim — fails
        // with `Invalid Closing Quote` and takes the whole file with it. Passing
        // `quote: false` turns quoting off entirely.
        quote,
        // A sheet with a short trailing row, or a merged cell, produces a record
        // whose field count differs from the header's. Off by default, because a
        // length mismatch in a real CSV usually means a delimiter problem and
        // should be loud.
        relaxColumnCount = false,
    } = options

    let columns
    let records
    if (headerless) {
        if (!operatorColumns || !Array.isArray(operatorColumns) || !operatorColumns.length) {
            throw new Error('Csv: headerless: true requires `columns: [...]` to be configured')
        }
        records = parse(text, {
            columns: operatorColumns,
            delimiter,
            ...(quote !== undefined && { quote }),
            relax_column_count: relaxColumnCount,
            skip_empty_lines: true,
            trim: false,
            bom: true,
        })
        columns = operatorColumns
    } else {
        records = parse(text, {
            columns: true,
            delimiter,
            ...(quote !== undefined && { quote }),
            relax_column_count: relaxColumnCount,
            skip_empty_lines: true,
            trim: false,
            bom: true,
        })
        columns = records.length > 0 ? Object.keys(records[0]) : (operatorColumns ?? [])
    }

    const coerceMap = buildCoerceMap(columns, coerce)
    const rows = records.map(row => {
        const out = {}
        for (const col of columns) {
            out[col] = coerceValue(row[col], coerceMap[col])
        }
        return out
    })

    return { columns, rows }
}
