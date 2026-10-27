// A change the fanout diffed reaches the catalog.
//
// Seen on gpoint-premium: a published sheet's row changed, the fanout parsed
// it and logged one update, and the catalog kept the old row for 35 minutes.
// Every two minutes after that the log said "0 update" and "Mikser restarted"
// and no cycle finished. Two things in this plugin, each harmless alone:
//
//   - The poll compared the URL against the catalog's copy of the parent,
//     which takes a cycle's checksum only when that cycle persists, and a
//     trigger does not wait for the cycle in flight — it cancels it. A cycle
//     longer than the poll interval (gpoint re-derives every report when a
//     table changes) was cancelled by the next poll for the very change it
//     was applying, and the next one too, for as long as the cycles outlasted
//     the interval.
//
//   - The fanout wrote each row's new hash to its own table at once, while
//     the row entity reached the catalog only at persist. Between the two a
//     cancelled cycle diffed against rows the catalog did not have yet, so
//     "0 update"; and a process that died there came back with the journal
//     discarded and the table saying the rows were done, so the change never
//     landed at all.
//
// Both live between engine phases, so this runs real mikser: the poll, the
// cancel, the journal, persist, and a process killed mid-cycle.

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { workingFolder, startMikser, startEdge, waitFor } from './engine.js'

const A = 'id\tlow\n17\t>= 10\n'
const B = 'id\tlow\n17\t>= 6\n'
const PARENT = '/readings.tsv'
const ROW = '/readings/17'

// Longer than the engine's 1s trigger debounce, so a changed poll is a cycle
// of its own; and the work after a change outlasts several of them.
const POLL_MS = 1500
const SLOW_MS = 4 * POLL_MS
const BOOT_TIMEOUT_MS = 60_000

const config = (url) => (records) => `
import { appendFileSync } from 'node:fs'
import { csv } from 'mikser-io-csv'

const SLOW_MS = Number(process.env.CSV_TEST_SLOW_MS ?? 0)

// Waits out \`ms\`, or until the cycle is cancelled: work that costs something
// gives way the moment it is no longer wanted.
const sleep = (ms, signal) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})

// Work that follows a change of the table and outlasts the poll interval.
// gpoint's findings re-derive every report when a table changes, and the
// questions that sends run for minutes.
const derive = () => ({ onProcess, useJournal, constants: { OPERATION } }) => {
    onProcess(async (signal) => {
        let changed = false
        for await (const { entity } of useJournal('Derive', [OPERATION.CREATE, OPERATION.UPDATE], signal)) {
            if (entity?.id === ${JSON.stringify(PARENT)}) changed = true
        }
        if (changed && SLOW_MS) await sleep(SLOW_MS, signal)
    })
}

// What the catalog holds for the row once a cycle has finished: where the
// stale value was read from.
const recorder = () => ({ onFinalized, findEntity }) => {
    onFinalized(async () => {
        const row = await findEntity({ id: ${JSON.stringify(ROW)} })
        appendFileSync(${JSON.stringify(records)}, JSON.stringify({ low: row?.meta?.low ?? null }) + '\\n')
    })
}

export default {
    plugins: [
        csv({
            match: {
                ${JSON.stringify(url)}: {
                    idColumn: 'id', delimiter: '\\t',
                    prefix: '/readings/', collection: 'documents',
                    parentId: ${JSON.stringify(PARENT)},
                    pollIntervalMs: ${POLL_MS},
                },
            },
        }),
        derive(),
        recorder(),
    ],
}
`

const restarts = (log) => log.split('Mikser restarted').length - 1
const lastLow = async (mikser) => (await mikser.reads()).at(-1)?.low

describe('a cycle that outlasts the poll interval', () => {
    let edge, mikser
    after(async () => {
        await mikser?.stop()
        await edge?.close()
        if (mikser) await rm(mikser.dir, { recursive: true, force: true })
    })

    it('lands the change, and no poll cancels the cycle applying it', async () => {
        edge = await startEdge([], A)
        mikser = startMikser(await workingFolder(config(edge.url)), { env: { CSV_TEST_SLOW_MS: String(SLOW_MS) } })

        const booted = await waitFor(async () => await lastLow(mikser) === '>= 10',
            { timeout: BOOT_TIMEOUT_MS, mikser })
        assert.ok(booted, `the first cycle never finished with the row\n--- mikser output ---\n${mikser.log}`)

        const restartsBefore = restarts(mikser.log)
        edge.serve(B)
        const landed = await waitFor(async () => await lastLow(mikser) === '>= 6',
            { timeout: 4 * SLOW_MS + 10_000, mikser })
        assert.ok(landed,
            `the catalog still says ${JSON.stringify(await lastLow(mikser))} for a row the URL serves as ">= 6"; `
            + `${restarts(mikser.log) - restartsBefore} cycles were cancelled meanwhile`
            + `\n--- mikser output ---\n${mikser.log}`)
        assert.equal(restarts(mikser.log) - restartsBefore, 0,
            `a poll cancelled the cycle that was applying the change\n--- mikser output ---\n${mikser.log}`)

        // Settled: two more polls find what the parent now carries and start
        // nothing.
        const cycles = (await mikser.reads()).length
        const servedAt = edge.served
        assert.ok(await waitFor(() => edge.served >= servedAt + 2, { mikser }),
            `the poll stopped fetching\n--- mikser output ---\n${mikser.log}`)
        assert.equal((await mikser.reads()).length, cycles, 'a quiet poll started a cycle')
    })
})

describe('a process killed between the fanout and persist', () => {
    let edge, dir, killed
    after(async () => {
        // Still sleeping through its cycle if an assertion stopped the test
        // before the kill.
        await killed?.kill()
        await edge?.close()
        if (dir) await rm(dir, { recursive: true, force: true })
    })

    it('diffs the change again after the restart', async () => {
        edge = await startEdge([], A)
        dir = await workingFolder(config(edge.url))

        const first = startMikser(dir, { watch: false })
        assert.equal(await first.exited(), 0, `the first build failed\n--- mikser output ---\n${first.log}`)
        assert.equal(await lastLow(first), '>= 10', 'precondition: the first build put the row in the catalog')

        // The sheet changes, and the cycle that diffs it is killed during the
        // work that follows — a deploy restarting the process, an OOM kill.
        edge.serve(B)
        killed = startMikser(dir, { env: { CSV_TEST_SLOW_MS: '600000' } })
        const diffed = await waitFor(() => /readings\.tsv — .*; diff /.test(killed.log),
            { timeout: BOOT_TIMEOUT_MS, mikser: killed })
        assert.ok(diffed, `precondition: the fanout diffed the change\n--- mikser output ---\n${killed.log}`)
        await killed.kill()

        const restarted = startMikser(dir, { watch: false })
        assert.equal(await restarted.exited(), 0, `the build after the kill failed\n--- mikser output ---\n${restarted.log}`)
        assert.equal(await lastLow(restarted), '>= 6',
            'the catalog kept the row the killed cycle never persisted, because the diff after the restart '
            + `found nothing to change\n--- mikser output ---\n${restarted.log}`)
        // And diffed it against the row the first build committed, not against
        // nothing: the state that waits for persist does reach its table.
        assert.match(restarted.log, /readings\.tsv — .* 0 create \+ 1 update/,
            `the row from the first build was not in the row state\n--- mikser output ---\n${restarted.log}`)
    })
})
