// Pre-emission row filter.
//
// Two forms supported:
//
//   - sift query object: { status: 'published', price: { $gt: 0 } }
//     Same syntax as findEntities / vector store query / api endpoint
//     filters. Compiled once at config load.
//
//   - function: (row, ctx) => boolean
//     Escape hatch for predicates sift can't express (cross-field
//     computation, regex with a closure, calling a config-time helper).
//     ctx exposes { parent, key, columnNames } so the function can
//     reference the CSV file's metadata when sharing one function
//     across multiple match entries.
//
// Compile-once means a 100k-row CSV does 100k matcher calls, not 100k
// sift-parse round trips. The matcher is reused across every poll /
// re-emission.

import sift from 'sift'

export function compileFilter(spec) {
    if (spec == null) return null
    if (typeof spec === 'function') {
        return { kind: 'function', matcher: spec }
    }
    if (typeof spec === 'object') {
        const matcher = sift(spec)
        return { kind: 'sift', matcher }
    }
    throw new Error(`csv: filter must be a sift query object or a function; got ${typeof spec}`)
}

export function applyFilter(rows, compiledFilter, context) {
    if (!compiledFilter) return rows
    if (compiledFilter.kind === 'sift') {
        return rows.filter(row => compiledFilter.matcher(row))
    }
    return rows.filter(row => compiledFilter.matcher(row, context))
}
