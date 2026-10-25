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
        // The line (1-based) that names the columns. Lines above it are not
        // read at all. A sheet written for people often carries a row of
        // readable titles over the row of keys a program should use: there
        // the keys are on line 2.
        headerRow = 1,
        // The name of a column to add to every row, holding the line (1-based,
        // as the spreadsheet numbers its rows) the row starts on. A table with
        // no natural key — a rule table where several rows share every value
        // that names them — can use it as its idColumn, and whoever reads a row
        // can say which line of the sheet to fix.
        lineColumn,
    } = options

    if (!Number.isInteger(headerRow) || headerRow < 1) {
        throw new Error(`Csv: headerRow must be a line number from 1, got ${JSON.stringify(headerRow)}`)
    }
    if (headerless && headerRow !== 1) {
        throw new Error('Csv: headerRow names the line that holds the column names, and headerless: true says there is none')
    }

    const parserOptions = {
        delimiter,
        ...(quote !== undefined && { quote }),
        relax_column_count: relaxColumnCount,
        skip_empty_lines: true,
        trim: false,
        bom: true,
        ...(headerRow > 1 && { from_line: headerRow }),
        // `info.lines` is the line a record ENDS on and `raw` is its text, which
        // is what it takes to know the line it starts on. Asked for only when
        // a line column is wanted; otherwise records keep their plain shape.
        ...(lineColumn && { info: true, raw: true }),
    }

    let columns
    let records
    if (headerless) {
        if (!operatorColumns || !Array.isArray(operatorColumns) || !operatorColumns.length) {
            throw new Error('Csv: headerless: true requires `columns: [...]` to be configured')
        }
        records = parse(text, { ...parserOptions, columns: operatorColumns })
        columns = operatorColumns
    } else {
        records = parse(text, { ...parserOptions, columns: true })
        const first = lineColumn ? records[0]?.record : records[0]
        columns = first ? Object.keys(first) : (operatorColumns ?? [])
    }

    if (lineColumn && columns.includes(lineColumn)) {
        throw new Error(`Csv: lineColumn "${lineColumn}" is already a column of this csv — pick a name it does not use`)
    }

    const coerceMap = buildCoerceMap(columns, coerce)
    const rows = records.map(item => {
        const row = lineColumn ? item.record : item
        const out = {}
        for (const col of columns) {
            out[col] = coerceValue(row[col], coerceMap[col])
        }
        if (lineColumn) out[lineColumn] = startLine(item)
        return out
    })

    return { columns: lineColumn ? [...columns, lineColumn] : columns, rows }
}

// The line a record starts on. csv-parse reports the line it ENDS on; a quoted
// field can carry newlines, so the two differ by the newlines inside the
// record. Its raw text also holds the empty lines skipped in front of it and
// its own line break, and neither of those is inside the record.
function startLine({ info, raw }) {
    const body = String(raw ?? '').replace(/^(\r?\n)+/, '').replace(/\r?\n$/, '')
    return info.lines - (body.match(/\n/g)?.length ?? 0)
}
