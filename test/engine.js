// A real mikser process over a scratch working folder, for the tests whose
// defect lives between the engine's phases rather than inside this plugin:
// the journal carrying an entity from one walk to the next, a cycle cancelled
// by a trigger, persist putting the catalog in step. A harness stand-in for
// any of those would encode the very assumption under test.
//
// Not a *.test.js file, so the runner does not take it for a suite.

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const MIKSER_ROOT = path.dirname(require.resolve('mikser-io/package.json'))
const MIKSER_APP = path.join(MIKSER_ROOT, 'app.js')

// `config` is the source of mikser.config.js, given the path of the ndjson
// file its plugins may append records to.
export async function workingFolder(config) {
    const dir = await mkdtemp(path.join(tmpdir(), 'mikser-csv-engine-'))
    const records = path.join(dir, 'records.ndjson')
    await writeFile(path.join(dir, 'mikser.config.js'), config(records))

    // The config imports the packages by name from outside any node_modules
    // tree, and ESM resolution walks up from the importing file, so they are
    // linked in beside it.
    const modules = path.join(dir, 'node_modules')
    await mkdir(modules, { recursive: true })
    await symlink(MIKSER_ROOT, path.join(modules, 'mikser-io'), 'dir')
    await symlink(path.resolve(import.meta.dirname, '..'), path.join(modules, 'mikser-io-csv'), 'dir')
    return dir
}

export function startMikser(dir, { watch = true, env = {} } = {}) {
    const records = path.join(dir, 'records.ndjson')
    const args = ['--no-warnings', MIKSER_APP, '--working-folder', dir]
    if (watch) args.push('--watch')
    const proc = spawn(process.execPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1', ...env },
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
            if (proc.exitCode != null || proc.signalCode != null) return resolve(proc.exitCode)
            proc.once('exit', resolve)
        }),
        stop: () => new Promise((resolve) => {
            if (proc.exitCode != null || proc.signalCode != null) return resolve()
            proc.once('exit', resolve)
            proc.kill('SIGTERM')
            setTimeout(() => { proc.kill('SIGKILL'); resolve() }, 5000).unref()
        }),
        // What an OOM kill or a restart that ran out of patience leaves:
        // no hook gets to run.
        kill: () => new Promise((resolve) => {
            if (proc.exitCode != null || proc.signalCode != null) return resolve()
            proc.once('exit', resolve)
            proc.kill('SIGKILL')
        }),
    }
}

// A published Google Sheet as the plugin meets it: the URL answers 307 with
// the address of the copy to read, and that copy carries no ETag and no
// Last-Modified. Answers each request with the next of `bodies`, then `rest`
// for every request after those; `serve` replaces `rest`.
export function startEdge(bodies, rest) {
    let served = 0
    const server = createServer((req, res) => {
        if (req.url.startsWith('/pub')) {
            res.writeHead(307, { location: `/copy${req.url.slice('/pub'.length)}` })
            return res.end()
        }
        const body = bodies[served] ?? rest
        served++
        res.writeHead(200, {
            'content-type': 'text/tab-separated-values; charset=utf-8',
            'cache-control': 'private, max-age=300',
        })
        res.end(body)
    })
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        url: `http://127.0.0.1:${server.address().port}/pub?gid=571713490&single=true&output=tsv`,
        get served() { return served },
        serve: (body) => { rest = body },
        close: () => new Promise((done) => server.close(done)),
    })))
}

// Waits for a condition rather than a duration: when a cycle lands depends on
// the debounce and on how cold the machine is, not on a fixed offset.
export async function waitFor(predicate, { timeout = 30_000, mikser } = {}) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
        if (await predicate()) return true
        if (mikser && (mikser.proc.exitCode != null || mikser.proc.signalCode != null)) return false
        await new Promise((r) => setTimeout(r, 100))
    }
    return false
}
