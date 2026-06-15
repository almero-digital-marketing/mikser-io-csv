// Discriminate the two shapes a `match` key can take:
//
//   - URL string (http:// or https://): the csv plugin owns this URL.
//     It creates a parent CSV entity for it, schedules polling, and
//     re-fans rows when the poll bumps the parent.
//
//   - Anything else: glob pattern over entity.id. The parent CSV is
//     already in the catalog (emitted by documents / files / gdrive /
//     etc.); the csv plugin watches the journal for matching entities
//     and re-fans rows when their inputHash drifts.
//
// Detection is a one-line scheme check on the key.

import { minimatch } from 'minimatch'

const URL_RE = /^https?:\/\//i

export function isUrlKey(key) {
    return URL_RE.test(String(key ?? ''))
}

export function entityIdMatches(entityId, glob) {
    if (!entityId || !glob) return false
    return minimatch(entityId, glob, { dot: true })
}

// First glob/URL key whose pattern matches the given entity wins.
// For URL keys, the "match" is by exact parent id equivalence (the
// parent id is constructed deterministically from the URL — see
// index.js). For glob keys, minimatch against entity.id.
export function findMatchingKey(entity, match, parentIdByUrl) {
    if (!entity?.id) return null
    for (const key of Object.keys(match)) {
        if (isUrlKey(key)) {
            const parentId = parentIdByUrl.get(key)
            if (parentId && entity.id === parentId) return key
        } else {
            if (entityIdMatches(entity.id, key)) return key
        }
    }
    return null
}
