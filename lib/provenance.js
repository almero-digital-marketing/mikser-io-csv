// Where a csv row's values were written.
//
// A row entity is synthetic — no uri, no file of its own — so on the face of
// it there is nothing to point at. But every one of its values WAS written
// somewhere a person can go and edit: one line of the parent csv. The engine
// already hands this handler the parent's raw text (a synthetic entity
// resolves its source through `entity.parent`), so all that is left is finding
// the row inside it.
//
// Not by row index. Rows are filtered before fan-out and the file may use
// quoted fields containing newlines, so "the Nth row" and "the Nth line" are
// different numbers and the difference is invisible until it is wrong. The row
// is found by its key value instead — the same value that made its id.
//
// Registered at module scope: a pure registration keyed on `entity.format`,
// costing nothing until something asks for a position.

import { probeFormat, registerProvenanceFormat } from 'mikser-io'

// The line that holds this row, located by its key. Returns the line's index
// (0-based) and its text, or null when the row cannot be found — a value that
// was rewritten by a filter, or a key that appears nowhere verbatim.
function findRowLine(lines, keyValue) {
    if (!keyValue) return null
    // A csv field may be quoted, so match the value either bare or quoted, and
    // require a delimiter or a line edge on each side rather than a substring
    // hit — `12` must not match `123`.
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        for (const candidate of [keyValue, `"${keyValue}"`]) {
            const at = line.indexOf(candidate)
            if (at < 0) continue
            const before = at === 0 ? '' : line[at - 1]
            const after = line[at + candidate.length] ?? ''
            if ((before === '' || before === ',' || before === ';' || before === '\t')
                && (after === '' || after === ',' || after === ';' || after === '\t')) {
                return { index: i, line }
            }
        }
    }
    return null
}

export function registerCsvProvenance() {
    return registerProvenanceFormat('csv-row', {
        test: (entity) => entity?.format === 'csv-row',
        positions: (raw, entity) => {
            if (typeof raw !== 'string' || !entity?.meta) return {}
            const lines = raw.split('\n')
            // The header names the columns, and their order is what makes a
            // column position findable at all.
            const header = lines[0]
            if (!header) return {}

            // The id column is whichever meta key the row's own id was built
            // from; it is not recorded on the entity, so try each value in
            // turn and take the first that locates a unique-looking line.
            let found = null
            for (const value of Object.values(entity.meta)) {
                if (typeof value !== 'string' && typeof value !== 'number') continue
                found = findRowLine(lines.slice(1), String(value))
                if (found) { found.index += 1; break }
            }
            if (!found) return {}

            const out = {}
            for (const [field, value] of Object.entries(entity.meta)) {
                if (typeof value !== 'string' && typeof value !== 'number') continue
                const text = String(value)
                if (!text) continue
                const at = found.line.indexOf(text)
                if (at < 0) continue
                out[field] = { line: found.index + 1, col: at }
            }
            return out
        },
    })
}

// The parent csv itself is a plain text file with no meta of its own, so
// nothing to register for it. Exported for symmetry with the row handler and
// so a caller can see that the omission is deliberate.
export { probeFormat }
