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
import { readEntityContent } from 'mikser-io'
import { compileFilter } from './lib/filter.js'
import { fanoutParent } from './lib/fanout.js'
import { isUrlKey, findMatchingKey } from './lib/match-key.js'
import { dropAllForParent } from './lib/state.js'
import './lib/state.js'   // side-effect: registerSchema
import { registerCsvProvenance } from './lib/provenance.js'

// A row entity is synthetic, so "where was this written" has no answer from
// the entity alone — but every value was written on one line of the parent
// csv, which is a real place to go and edit. Registered once at module scope;
// it costs nothing until something asks.
registerCsvProvenance()

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
        throw new Error(`Csv: match[${JSON.stringify(key)}] must be a config object`)
    }
    if (!entry.idColumn || typeof entry.idColumn !== 'string') {
        throw new Error(
            `Csv: match[${JSON.stringify(key)}] requires an idColumn (string column name). ` +
            `Pick the column whose values uniquely identify a row; without it, change detection ` +
            `would treat every edit as wholesale delete+recreate.`
        )
    }
    if (!entry.prefix || typeof entry.prefix !== 'string') {
        throw new Error(`Csv: match[${JSON.stringify(key)}] requires a prefix (string, mikser-side id prefix for row entities)`)
    }
    if (!entry.collection || typeof entry.collection !== 'string') {
        throw new Error(`Csv: match[${JSON.stringify(key)}] requires a collection (string)`)
    }
}

export function csv(options = {}) {
    return ({
        runtime, onLoaded, onProcess, useLogger, useJournal,
        createEntity, updateEntity, deleteEntity,
        findEntity,
        triggeredHook,
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
            onLoaded(() => useLogger().warn('Csv: no `match` entries configured — plugin is inert.'))
            return
        }

        // For each URL entry, create the parent CSV entity at onLoaded
        // and schedule polling. The CREATE/UPDATE from this call lands
        // a journal entry that onProcess (below) picks up and runs the
        // initial fanout for — no separate onImport pass needed.
        const pollTimers = []
        // The body a poll fetched and found changed, for the fanout of the
        // cycle it triggers — see `fetched` in lib/fanout.js.
        const fetchedByParent = new Map()   // parentId → body
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
                    // Carry checksum forward on warm restart so the
                    // gate hits and the first cycle is silent when the
                    // upstream hasn't drifted since shutdown. Without
                    // this preservation the bump in onLoaded would
                    // clear it, fanout would re-run, diff would emit
                    // zero row changes — wasteful but quiet.
                    checksum:   existing?.checksum,
                    // With the body that checksum describes, so a reader
                    // still gets the bytes the rows came from if the first
                    // fetch fails. The fanout reads fresh regardless.
                    content:    existing?.content,
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
                logger.info('Csv: registered URL source %s → %s', key, parentId)

                // Poll timer (watch mode only). Each tick does a CHEAP
                // change check before disturbing anything — fetch via
                // the http provider (conditional GET; nearly free when
                // the upstream serves 304 within its cache window, a full
                // download when it sends no validators), checksum the
                // body, compare against the persisted parent checksum.
                // If unchanged, the tick is silent: no journal write, no
                // trigger, no render cycle. Only when the bytes actually
                // differ do we bump the entity and wake the watch loop.
                //
                // The previous design bumped on every tick and let the
                // process cycle discover "nothing changed" via the same
                // checksum compare inside fanout. That worked but spun
                // a full cycle every poll interval — wasted CPU, wasted
                // log noise, and at scale (many polled CSVs) wasted
                // contention on the journal/manifest path. Cheaper to
                // gate at the source.
                const pollIntervalMs = entry.pollIntervalMs ?? options.pollIntervalMs ?? 60_000
                if (runtime.options.watch && pollIntervalMs > 0) {
                    const t = setInterval(async () => {
                        try {
                            // Read fresh catalog state each tick — the
                            // closure-captured `parent` from onLoaded
                            // is stale the moment fanout runs the first
                            // time (parent.checksum gets set). findEntity
                            // returns whatever's currently in mikser_entities,
                            // including any checksum the last fanout left.
                            const current = await findEntity({ id: parentId })
                            if (!current) return        // catalog dropped it; let it stay gone
                            // `reload`: the catalog copy carries the body
                            // it was last fanned from, and the question
                            // is what the URL serves now.
                            const content = await readEntityContent(current, { reload: true })
                            if (content.contentError) {
                                logger.warn('Csv: poll fetch for %s failed: %s', key, content.contentError)
                                return
                            }
                            if (typeof content.content !== 'string') return
                            const checksum = createHash('sha256').update(content.content).digest('hex')
                            if (current.checksum === checksum) {
                                logger.trace('Csv: poll %s — unchanged, no cycle', key)
                                return
                            }
                            // Changed. Bump entity time so the UPDATE
                            // lands in the journal, then trigger a
                            // cycle to drain it. Fanout in onProcess
                            // parses the body fetched here rather than
                            // fetching again, stamps its checksum and
                            // content on the parent, and runs the row
                            // diff. The 1s debounce in triggeredHook
                            // collapses bursts (multiple sources
                            // detecting changes in the same window) into
                            // one cycle.
                            logger.info('Csv: %s changed upstream — fanning out again', key)
                            fetchedByParent.set(parentId, content.content)
                            await updateEntity({ ...current, time: Date.now() })
                            await triggeredHook('csv-poll', { url: key, parentId })
                        } catch (err) {
                            logger.error('Csv: poll check failed for %s — %s', key, err.message)
                        }
                    }, pollIntervalMs)
                    t.unref?.()
                    pollTimers.push(t)
                    logger.info('Csv: polling %s every %dms', key, pollIntervalMs)
                }
            }
        })

        // Note: no separate onImport pass for URL mode. onLoaded's
        // createEntity/updateEntity lands a CREATE/UPDATE journal
        // entry for each URL parent; onProcess (below) picks it up
        // and runs the initial fanout. Glob-mode parents flow through
        // the same onProcess path naturally — their CREATE/UPDATE
        // entries come from the documents/files/gdrive sources.

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
                // rely on FK cascade (mikser_csv_rows has no FK to
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
                    logger.info('Csv: parent %s deleted — cleaned up %d row entities', entity.id, orphaned.length)
                    continue
                }

                // Don't re-fan our own row entities (format = csv-row).
                if (entity?.format === 'csv-row') continue

                const matched = findMatchingKey(entity, match, parentIdByUrl)
                if (!matched) continue

                const entry = configByKey.get(matched)
                const fetched = fetchedByParent.get(entity.id)
                fetchedByParent.delete(entity.id)
                try {
                    await fanoutParent({
                        parent: entity, key: matched,
                        config: { ...entry, force: runtime.options.clear },
                        compiledFilter: compiledByKey.get(matched),
                        createEntity, updateEntity, deleteEntity,
                        logger,
                        owned: isUrlKey(matched),
                        fetched,
                    })
                } catch (err) {
                    logger.error('Csv: fanout failed for %s — %s', entity.id, err.message)
                }
            }
        })
        // Names this package to the runtime's loaded-plugin record, so
        // ping reports it as running rather than as undetectable.
        return { module: import.meta.url }
    }
}
