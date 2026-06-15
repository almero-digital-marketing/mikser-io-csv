// Build the row-entity shape mikser stores in the catalog.
//
// Row entities don't have their own content — their data lives entirely
// in `meta` (the CSV columns). uri is null (synthetic; no separate
// content to fetch). entity.parent points at the parent CSV entity so
// the manifest's "cascade-drop snapshots when parent dies" path works
// without extra cleanup code.

import path from 'node:path'

function safeSegment(value) {
    // Conservative slug for the URL-safe portion of the entity id. Keep
    // dots and dashes (SKU-1.0), strip everything weird. Preserves the
    // recognisable shape of the idColumn value.
    return String(value).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

function collectionToType(collection) {
    if (collection === 'documents') return 'document'
    if (collection === 'files')     return 'file'
    if (collection === 'assets')    return 'asset'
    return collection
}

export function buildRowEntity({ row, rowKey, parent, prefix, collection, idColumn, metaDefaults }) {
    const slug = safeSegment(rowKey)
    const id = path.posix.join(prefix.endsWith('/') ? prefix : prefix + '/', slug)
    // entity.name carries the path-under-prefix so the layouts plugin's
    // destination derivation (entity.name + .format → cleanUrls) lands
    // outputs at the prefix-aware URL. Without this, a row at id
    // /authors/dr-pragma rendered with author.html.hbs would land at
    // /dr-pragma/index.html (just the slug) instead of
    // /authors/dr-pragma/index.html (the operator's intent).
    const name = id.replace(/^\/+/, '')
    return {
        id,
        parent:     parent.id,
        collection,
        type:       collectionToType(collection),
        name,
        format:     'csv-row',
        uri:        null,             // synthetic — no separate content fetch
        content:    null,
        // Order matters: row columns win over metaDefaults so a CSV
        // explicitly overriding `layout` etc. still works. idColumn is
        // re-pinned last so a metaDefaults entry can't accidentally
        // overwrite it.
        meta:       { ...(metaDefaults ?? {}), ...row, [idColumn]: row[idColumn] },
        time:       parent.time ?? Date.now(),
    }
}
