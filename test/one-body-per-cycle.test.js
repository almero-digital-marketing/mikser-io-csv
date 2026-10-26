// Every reader of a polled URL sees the body the fanout checksummed.
//
// An integration test on purpose: the defect was in the gap between three
// things that each worked. The fanout fetched the URL and stamped the parent
// with that body's checksum; a consumer later in the same cycle fetched the
// same URL again and got different bytes; and every poll after that compared
// against the fanout's checksum, found it equal, and stayed silent. Nothing
// re-triggered, so the consumer kept the other copy until the sheet changed
// again or someone restarted.
//
// A published Google Sheet does exactly this right after a publish: its edges
// disagree for a while and it sends no ETag or Last-Modified, so the http
// provider has nothing to revalidate against and every read is a fresh fetch.
// The stub below is that edge — A, then B, then A for good.
//
// So the run is real: real mikser under --watch, the real http provider, the
// real journal carrying the parent from the csv walk to the consumer's walk,
// and the real catalog the poll reads the parent back from.

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const MIKSER_ROOT = path.dirname(require.resolve('mikser-io/package.json'))
const MIKSER_APP = path.join(MIKSER_ROOT, 'app.js')

const A = 'id\tlow\n17\t>= 10\n'
const B = 'id\tlow\n17\t>= 6\n'
const PARENT = '/readings.tsv'

// Longer than the engine's 1s trigger debounce, so each changed poll gets a
// cycle of its own before the next poll fires.
const POLL_MS = 1500
const BOOT_TIMEOUT_MS = 60_000

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

// The edge: answers each request with the next of `bodies`, then `rest` for
// every request after those.
function startEdge(bodies, rest) {
    let served = 0
    const server = createServer((req, res) => {
        const body = bodies[served] ?? rest
        served++
        // What Google sends for a published tab: no validators at all.
        res.writeHead(200, {
            'content-type': 'text/tab-separated-values; charset=utf-8',
            'cache-control': 'private, max-age=300',
        })
        res.end(body)
    })
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        url: `http://127.0.0.1:${server.address().port}/pub?gid=571713490&single=true&output=tsv`,
        get served() { return served },
        close: () => new Promise((done) => server.close(done)),
    })))
}

// A consumer registered after csv, reading the parent in the cycle the fanout
// ran in — the shape of gpoint's findings plugin, which reads the clinic's
// tables this way because the process phase cannot see the row entities yet.
// It records what it read beside the checksum the fanout left on the parent.
const config = (url, records) => `
import { appendFileSync } from 'node:fs'
import { readEntityContent } from 'mikser-io'
import { csv } from 'mikser-io-csv'

const consumer = () => ({ onProcess, useJournal, constants: { OPERATION } }) => {
    onProcess(async (signal) => {
        for await (const { entity } of useJournal('Consumer', [OPERATION.CREATE, OPERATION.UPDATE], signal)) {
            if (entity?.id !== ${JSON.stringify(PARENT)}) continue
            const { content, contentError } = await readEntityContent(entity)
            appendFileSync(${JSON.stringify(records)},
                JSON.stringify({ content, contentError, checksum: entity.checksum }) + '\\n')
        }
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
        consumer(),
    ],
}
`

async function workingFolder(url) {
    const dir = await mkdtemp(path.join(tmpdir(), 'mikser-csv-one-body-'))
    await writeFile(path.join(dir, 'mikser.config.js'), config(url, path.join(dir, 'records.ndjson')))

    // The config imports the packages by name from outside any node_modules
    // tree, and ESM resolution walks up from the importing file, so they are
    // linked in beside it.
    const modules = path.join(dir, 'node_modules')
    await mkdir(modules, { recursive: true })
    await symlink(MIKSER_ROOT, path.join(modules, 'mikser-io'), 'dir')
    await symlink(path.resolve(import.meta.dirname, '..'), path.join(modules, 'mikser-io-csv'), 'dir')
    return dir
}

function startMikser(dir, { watch = true } = {}) {
    const records = path.join(dir, 'records.ndjson')
    const args = ['--no-warnings', MIKSER_APP, '--working-folder', dir]
    if (watch) args.push('--watch')
    const proc = spawn(process.execPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1' },
    })
    let log = ''
    proc.stdout.on('data', (d) => { log += d.toString() })
    proc.stderr.on('data', (d) => { log += d.toString() })

    return {
        dir, proc,
        get log() { return log },
        reads: async () => {
            const text = await readFile(records, 'utf8').catch(() => '')
            return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
        },
        exited: () => new Promise((resolve) => {
            if (proc.exitCode != null) return resolve(proc.exitCode)
            proc.once('exit', resolve)
        }),
        stop: () => new Promise((resolve) => {
            if (proc.exitCode != null) return resolve()
            proc.once('exit', resolve)
            proc.kill('SIGTERM')
            setTimeout(() => { proc.kill('SIGKILL'); resolve() }, 5000).unref()
        }),
    }
}

// Waits for a condition rather than a duration: when a cycle lands depends on
// the debounce and on how cold the machine is, not on a fixed offset.
async function waitFor(predicate, { timeout = 30_000, mikser } = {}) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
        if (await predicate()) return true
        if (mikser?.proc.exitCode != null) return false
        await new Promise((r) => setTimeout(r, 100))
    }
    return false
}

const describeRead = ({ content, contentError, checksum }) => content === A ? 'A'
    : content === B ? 'B'
    : `${JSON.stringify(content ?? contentError)} (parent checksum ${checksum})`

describe('a polled URL whose edges disagree', () => {
    let edge, mikser
    after(async () => {
        await mikser?.stop()
        await edge?.close()
        if (mikser) await rm(mikser.dir, { recursive: true, force: true })
    })

    it('hands every reader in a cycle the body the fanout checksummed', async () => {
        edge = await startEdge([A, B], A)
        mikser = startMikser(await workingFolder(edge.url))

        const booted = await waitFor(async () => (await mikser.reads()).length > 0,
            { timeout: BOOT_TIMEOUT_MS, mikser })
        assert.ok(booted, `the consumer never read the parent\n--- mikser output ---\n${mikser.log}`)

        const [first] = await mikser.reads()
        assert.equal(first.checksum, sha256(A), 'precondition: the fanout read A and checksummed it')
        assert.equal(first.content, A,
            `the consumer read ${describeRead(first)} in the cycle the fanout parsed A — `
            + 'a second fetch of the same URL, and the edge answered it differently')

        // The edge now says B once and then A for good. Each change reaches the
        // consumer in a cycle of its own, and every read agrees with its cycle.
        const followed = await waitFor(async () => {
            const reads = await mikser.reads()
            const sawB = reads.findIndex((read) => read.content === B)
            return sawB >= 0 && reads.slice(sawB + 1).some((read) => read.content === A)
        }, { mikser })
        const reads = await mikser.reads()
        assert.ok(followed,
            `the consumer did not follow the edge to B and back to A; it read ${reads.map(describeRead).join(', ')}`
            + `\n--- mikser output ---\n${mikser.log}`)

        // Settled: two more polls find what the parent already carries, so
        // nothing new reaches the consumer and it stays on what the edge serves.
        const settledAt = reads.length
        const servedAt = edge.served
        assert.ok(await waitFor(() => edge.served >= servedAt + 2, { mikser }),
            `the poll stopped fetching\n--- mikser output ---\n${mikser.log}`)
        const final = await mikser.reads()
        assert.equal(final.length, settledAt,
            `quiet polls started cycles: ${final.slice(settledAt).map(describeRead).join(', ')}`)

        for (const [index, read] of final.entries()) {
            assert.equal(sha256(read.content ?? ''), read.checksum,
                `read ${index + 1} was ${describeRead(read)}, not the body its cycle's fanout checksummed`)
        }
        assert.equal(final.at(-1).content, A, 'the consumer ends on what the edge serves')
    })
})

describe('a restart over a catalog that carries the body', () => {
    let edge, dir
    after(async () => {
        await edge?.close()
        if (dir) await rm(dir, { recursive: true, force: true })
    })

    it('fetches the URL again rather than reusing what the catalog carried', async () => {
        // The parent keeps its body in the catalog, so a restart could read
        // that and never ask the URL — and a one-shot build, which has no
        // poll, would then never see a change at all.
        edge = await startEdge([A], B)
        dir = await workingFolder(edge.url)

        const first = startMikser(dir, { watch: false })
        assert.equal(await first.exited(), 0, `the first build failed\n--- mikser output ---\n${first.log}`)
        const second = startMikser(dir, { watch: false })
        assert.equal(await second.exited(), 0, `the second build failed\n--- mikser output ---\n${second.log}`)

        const reads = await second.reads()
        assert.equal(reads.length, 2, `expected one read per build, got ${reads.map(describeRead).join(', ')}`)
        assert.equal(reads[0].content, A, 'precondition: the first build read A')
        assert.equal(reads[1].content, B,
            `the second build read ${describeRead(reads[1])} while the URL served B\n--- mikser output ---\n${second.log}`)
        assert.equal(reads[1].checksum, sha256(B), 'and its fanout checksummed B')
    })
})
