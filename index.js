// mikser-io-csv — CSV-as-source for mikser-io.
//
// One factory; two operating modes selected per match entry:
//
//   - Glob mode: key is a glob pattern over entity.id. The parent CSV
//     entity is already in the catalog (emitted by documents / files /
//     gdrive / etc.). When that entity drifts (file edited, Drive sheet
//     changed), the journal carries it through onProcess; we re-fan rows.
//
//   - URL mode: key is an http:// or https:// URL. The csv plugin owns
//     the parent CSV entity entirely: creates it at onLoaded with the
//     URL as uri (so the built-in http provider handles fetch + ETag
//     caching), runs a poll timer that bumps the entity's inputHash so
//     the same onProcess path picks up changes.
//
// Both modes converge on the same fanout pipeline: parse + filter +
// three-way row diff + emit row entities. The only mode-specific code
// is the parent-entity bootstrap and the poll timer.

import { createHash } from 'node:crypto'
import { compileFilter } from './lib/filter.js'
import { fanoutParent } from './lib/fanout.js'
import { isUrlKey, findMatchingKey } from './lib/match-key.js'
import { dropAllForParent } from './lib/state.js'
import './lib/state.js'   // side-effect: registerSchema

function urlToParentId(url, configParentId) {
    if (configParentId) return configParentId
    // Stable, predictable id derived from the URL. Prefix with /csv-remote/
    // so it's distinguishable from filesystem-sourced entities.
    const hash = createHash('sha256').update(url).digest('hex').slice(0, 12)
    let basename = 'remote.csv'
    try {
        const u = new URL(url)
        const last = u.pathname.split('/').filter(Boolean).pop() || 'remote'
        basename = last.endsWith('.csv') || last.endsWith('.tsv') ? last : `${last}.csv`
    } catch { /* keep default */ }
    return `/csv-remote/${hash}-${basename}`
}

function validateEntry(key, entry) {
    if (!entry || typeof entry !== 'object') {
        throw new Error(`csv: match[${JSON.stringify(key)}] must be a config object`)
    }
    if (!entry.idColumn || typeof entry.idColumn !== 'string') {
        throw new Error(
            `csv: match[${JSON.stringify(key)}] requires an idColumn (string column name). ` +
            `Pick the column whose values uniquely identify a row; without it, change detection ` +
            `would treat every edit as wholesale delete+recreate.`
        )
    }
    if (!entry.prefix || typeof entry.prefix !== 'string') {
        throw new Error(`csv: match[${JSON.stringify(key)}] requires a prefix (string, mikser-side id prefix for row entities)`)
    }
    if (!entry.collection || typeof entry.collection !== 'string') {
        throw new Error(`csv: match[${JSON.stringify(key)}] requires a collection (string)`)
    }
}

export function csv(options = {}) {
    return ({
        runtime, onLoaded, onImport, onProcess, useLogger, useJournal,
        createEntity, updateEntity, deleteEntity,
        findEntity,
        constants: { OPERATION },
    }) => {
        const match = options.match ?? {}
        const entries = Object.entries(match)

        // Compile-once: filter matcher per entry, plus precompute
        // parent-id lookup for URL keys.
        const compiledByKey  = new Map()
        const configByKey    = new Map()
        const parentIdByUrl  = new Map()      // URL → parentId

        for (const [key, entry] of entries) {
            validateEntry(key, entry)
            compiledByKey.set(key, compileFilter(entry.filter))
            configByKey.set(key, entry)
            if (isUrlKey(key)) {
                parentIdByUrl.set(key, urlToParentId(key, entry.parentId))
            }
        }

        if (entries.length === 0) {
            onLoaded(() => useLogger().warn('csv: no `match` entries configured — plugin is inert.'))
            return
        }

        // For each URL entry, create the parent CSV entity at onLoaded
        // and schedule polling. We bump the entity on every poll tick;
        // the http provider's ETag cache makes the actual fetch nearly
        // free when the URL hasn't changed.
        const pollTimers = []
        onLoaded(async () => {
            const logger = useLogger()
            for (const [key, entry] of entries) {
                if (!isUrlKey(key)) continue
                const parentId = parentIdByUrl.get(key)
                const existing = await findEntity({ id: parentId })
                const parent = {
                    id:         parentId,
                    collection: entry.collection,
                    type:       'document',
                    name:       parentId.split('/').pop().replace(/\.csv$/i, ''),
                    format:     'csv',
                    uri:        key,
                    meta: {
                        ...(existing?.meta ?? {}),
                        csvSource:     'http',
                        csvUrl:        key,
                        ...(entry.headers ? { httpHeaders: entry.headers } : {}),
                        ...(entry.httpTimeoutMs ? { httpTimeoutMs: entry.httpTimeoutMs } : {}),
                    },
                    time: Date.now(),
                }
                if (existing) {
                    await updateEntity(parent)
                } else {
                    await createEntity(parent)
                }
                logger.info('csv: registered URL source %s → %s', key, parentId)

                // Poll timer (watch mode only). Each tick UPDATEs the
                // parent entity; onProcess picks it up; fanout runs;
                // the http provider's ETag cache shortcuts the actual
                // re-fetch when there's nothing new.
                const pollIntervalMs = entry.pollIntervalMs ?? options.pollIntervalMs ?? 60_000
                if (runtime.options.watch && pollIntervalMs > 0) {
                    const t = setInterval(() => {
                        updateEntity({ ...parent, time: Date.now() }).catch(err => {
                            logger.error('csv: poll bump failed for %s — %s', key, err.message)
                        })
                    }, pollIntervalMs)
                    t.unref?.()
                    pollTimers.push(t)
                    logger.info('csv: polling %s every %dms', key, pollIntervalMs)
                }
            }
        })

        // onImport: trigger one fanout per URL parent at startup so
        // cold runs ingest rows without waiting for the first poll tick.
        // Glob-mode parents flow through onProcess naturally when the
        // documents/files/gdrive plugins emit their journal entries.
        onImport(async () => {
            const logger = useLogger()
            for (const [key, entry] of entries) {
                if (!isUrlKey(key)) continue
                const parentId = parentIdByUrl.get(key)
                const parent = await findEntity({ id: parentId })
                if (!parent) continue
                await fanoutParent({
                    parent, key,
                    config: { ...entry, force: runtime.options.clear },
                    compiledFilter: compiledByKey.get(key),
                    createEntity, updateEntity, deleteEntity,
                    logger,
                })
            }
        })

        onProcess(async (signal) => {
            const logger = useLogger()
            for await (const { entity, operation } of useJournal(
                'CSV fan-out',
                [OPERATION.CREATE, OPERATION.UPDATE, OPERATION.DELETE],
                signal,
            )) {
                if (signal.aborted) return

                // Parent CSV deleted → drop the per-row state we own
                // AND emit deleteEntity for every row entity. We can't
                // rely on FK cascade (mikser_csv_state has no FK to
                // mikser_entities — onProcess fires while pending
                // CREATEs are still draining and would block the
                // initial state row from being written). Explicit
                // cleanup is the price.
                if (operation === OPERATION.DELETE) {
                    if (entity?.format === 'csv-row') continue
                    const matched = findMatchingKey(entity, match, parentIdByUrl)
                    if (!matched) continue
                    const entry = configByKey.get(matched)
                    const orphaned = dropAllForParent(entity.id)
                    for (const rowEntityId of orphaned) {
                        await deleteEntity({ id: rowEntityId, collection: entry.collection })
                    }
                    logger.info('csv: parent %s deleted — cleaned up %d row entities', entity.id, orphaned.length)
                    continue
                }

                // Don't re-fan our own row entities (format = csv-row).
                if (entity?.format === 'csv-row') continue

                const matched = findMatchingKey(entity, match, parentIdByUrl)
                if (!matched) continue

                const entry = configByKey.get(matched)
                try {
                    await fanoutParent({
                        parent: entity, key: matched,
                        config: { ...entry, force: runtime.options.clear },
                        compiledFilter: compiledByKey.get(matched),
                        createEntity, updateEntity, deleteEntity,
                        logger,
                    })
                } catch (err) {
                    logger.error('csv: fanout failed for %s — %s', entity.id, err.message)
                }
            }
        })
    }
}
