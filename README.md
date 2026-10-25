# mikser-io-csv

CSV-as-source for [mikser-io](https://github.com/almero-digital-marketing/mikser-io). One row → one queryable entity in the catalog. Local files, Google Sheets exported as CSV, public HTTP URLs — all pass through the same dispatch.

```
CSV file or URL
  │
  ▼
csv()  → parse → coerce → filter → three-way diff → emit row entities
  │
  ▼
catalog now has one entity per row
  │
  ▼
layouts/products.hbs renders each → /products/sku-123.html
vector embeds each → semantic search
schemas validates each meta → typed catalog
mcp tools query them → "find products under $20 in stock"
```

This is the "spreadsheet-as-CMS" story for non-technical operators: marketing drops a CSV of products, mikser renders 200 product pages. Edit a cell, the corresponding page updates seconds later.

## Install

```bash
npm install mikser-io-csv
```

Peer dep on `mikser-io ^11`. Hard deps: `csv-parse` (the parser), `sift` (filter dispatch), `minimatch` (glob match).

## Two operating modes — one factory

Each entry in `match` is either a **catalog glob** or an **HTTP URL**:

```js
import { csv } from 'mikser-io-csv'

csv({
    match: {
        // Glob mode: parent CSV is already in the catalog. Whatever
        // plugin emitted it (documents, files, gdrive, …) handles the
        // sync; csv plugin watches for its inputHash to drift and
        // re-fans rows.
        'documents/data/products.csv': {
            idColumn:   'sku',
            collection: 'documents',
            prefix:     '/products/',
            coerce:     true,
        },
        '/drive/sales/**/*.csv': {
            idColumn:   'order_id',
            collection: 'documents',
            prefix:     '/sales/',
            coerce:     { amount: 'number', placedAt: 'date' },
        },

        // URL mode: csv plugin owns the parent entity. Creates it at
        // onLoaded with the URL as `uri`, schedules polling, lets the
        // built-in http provider handle the fetch + ETag caching.
        'https://api.example.com/exports/products.csv': {
            idColumn:       'sku',
            collection:     'documents',
            prefix:         '/products/',
            pollIntervalMs: 300_000,                       // optional per-URL
            headers: {
                Authorization: `Bearer ${process.env.EXAMPLE_API_TOKEN}`,
                Accept:        'text/csv',
            },
            filter: { status: 'published', inStock: true },
        },
    },
    pollIntervalMs: 60_000,                                // default for URL entries
})
```

Detection: a key starting with `http://` or `https://` is URL mode; anything else is a glob.

## Required per-entry config

| Field | Why |
|---|---|
| `idColumn` | Picks the column whose value uniquely identifies a row. Stable identifier → mikser sees row edits as `updateEntity`, not delete+recreate. Hard-error if missing. |
| `prefix` | Mikser-side id prefix for row entities. Row id = `<prefix><slugified-idColumn-value>`. |
| `collection` | Catalog collection the row entities live in (`documents`, `files`, etc.). |

## Optional per-entry config

| Field | Default | Effect |
|---|---|---|
| `coerce` | `false` | `true` → auto-detect numbers / booleans / ISO dates per cell. Object → explicit per-column types (`{ price: 'number', placedAt: 'date' }`). Conservative — leading-zero strings stay strings. |
| `filter` | none | Sift query object OR `(row, ctx) => boolean`. Compile-once; rows that fail are excluded from the catalog (and treated as deletes if they were previously present). |
| `delimiter` | `,` | `'\t'` for TSV, `';'` for European CSV. |
| `quote` | `"` | `false` turns quoting off. TSV has no quoting convention — a tab separates fields and a `"` is literal — but csv-parse still defaults to `"`, so a cell a spreadsheet exports as `"BRAND"()` fails the whole file with `Invalid Closing Quote`. |
| `relaxColumnCount` | `false` | Tolerate a row whose field count differs from the header's; missing columns come back `null`. Off by default because in a real CSV a length mismatch usually means the delimiter is wrong, and that should be loud. |
| `parseOptions` | none | Escape hatch: merged last over the fields above, for a csv-parse option this plugin has no opinion about. |
| `headerless` | `false` | `true` → first row is data; you must also pass `columns: [...]`. |
| `columns` | — | Required when `headerless: true`. |
| `headerRow` | `1` | The line (1-based) that names the columns; lines above it are not read. For a sheet with a row of readable titles over the row of keys, set `2`. |
| `lineColumn` | none | Adds a column of this name to every row, holding the line the row starts on (1-based, as the spreadsheet numbers rows). Use it as `idColumn` when no column identifies a row on its own. Refused if the csv already has a column of that name. |
| `parentId` | derived from URL | (URL mode only) Override the auto-derived parent entity id. |
| `pollIntervalMs` | plugin-level default (60s) | (URL mode only) How often to poll this URL. |
| `headers` | none | (URL mode only) HTTP headers passed through to the built-in http provider (Authorization tokens, custom Accept, etc.). |
| `httpTimeoutMs` | 30000 | (URL mode only) Request timeout. |

## Filter — sift queries (same syntax as `findEntities`)

```js
filter: { status: 'published', price: { $gt: 0 } }
filter: { category: { $in: ['gadgets', 'widgets'] } }
filter: { $and: [
    { placedAt: { $gte: '2026-01-01' } },
    { placedAt: { $lt:  '2026-04-01' } },
]}
filter: { email: { $exists: true, $regex: '@(example|acme)\\.com$' } }
```

For predicates sift can't express, pass a function. It receives `(row, ctx)` where `ctx = { parent, key, columnNames }`:

```js
filter: (row, { columnNames }) =>
    row.amount * row.quantity > 100 && row.region !== 'TEST'
```

Both filter forms compile once at config load. A 100k-row CSV evaluates the matcher 100k times, not 100k sift-parse round-trips.

## Coercion — opt-in, conservative

By default, every CSV cell is a string. Three opt-in shapes:

```js
coerce: true                                    // auto-detect per cell
coerce: { price: 'number', launchedAt: 'date' } // per-column directives
coerce: false                                   // explicit no-coerce (default)
```

Auto-detection rules:

| Pattern | Result |
|---|---|
| `"19.99"`, `"100"`, `"-3.14"` | number |
| `"01234"`, `"0042"` (leading zero, > 1 digit, not decimal) | **string** (SKUs preserved) |
| `"true"` / `"false"` (case-insensitive) | boolean |
| `"2026-06-15"`, `"2026-06-15T09:30:00Z"` (ISO 8601) | ISO string |
| empty cell | `null` |
| anything else | string |

Per-column types:

| Type | Behaviour |
|---|---|
| `'number'` | `Number(value)` — `NaN` falls back to original string |
| `'boolean'` | `true`/`false`/`1`/`0`/`yes`/`no`/`y`/`n` (case-insensitive); else original |
| `'date'` | Parsed via `Date.parse`; output as ISO 8601; unparseable falls back to original |
| `'string'` | Verbatim (useful for forcing leading-zero preservation) |

For stricter handling, pair with [mikser-io-schemas](https://github.com/almero-digital-marketing/mikser-io-schemas) + zod's `.coerce.*` chain.

## How it works

```
parent CSV entity in catalog (uri = local path / gdrive://... / https://...)
   │
   ▼ entity drifts (file edited / Drive sheet changed / poll bump for URL)
   │ csv plugin's onProcess sees it in the journal
   │
   ▼ pickMatchingKey(entity) finds the config entry
   │
   ▼ fanoutParent:
   │   1. readEntityContent(parent) — substrate-side provider dispatch
   │      (fs / gdrive / http — whichever scheme the URI has)
   │   2. sha256 the body → compare against parent.checksum → skip if equal
   │   3. parseCsv + coerce
   │   4. filter (sift) → keep / drop rows
   │   5. indexByKey by idColumn → Map<rowKey, {row, rowHash}>
   │   6. threeWayDiff against mikser_csv_rows
   │   7. emit createEntity / updateEntity / deleteEntity per delta
   │   8. mutate parent.checksum + parent.meta.csvColumns
   │      (auto-persist via useJournal carries it to mikser_entities)
   │   9. upsert row_hash entries
   │
   ▼ row entities now in the catalog
```

Filtered-out rows look indistinguishable from removed rows — they just aren't in the post-filter set. The diff emits a delete for them. Add `{status: {$ne: 'archived'}}` to your filter and previously-emitted archived rows disappear from the catalog on the next sync.

## URL mode in detail

When a match key is an HTTP/HTTPS URL:

1. **At `onLoaded`:** csv plugin creates a parent entity (or updates if it already exists) with `uri = <the URL>`, `meta.httpHeaders = <your headers>`, `meta.httpTimeoutMs = <yours>`. The id is derived from the URL hash (or `parentId` if you set it). On warm restart, the previous run's `parent.checksum` is preserved so the next cycle stays silent when the upstream hasn't drifted.
2. **At `onProcess` (cold + warm runs):** the CREATE/UPDATE journal entry from `onLoaded` is yielded; `fanoutParent` runs and ingests rows. No separate `onImport` pass — `onProcess` is the single fanout entrypoint for both startup and steady-state.
3. **In watch mode:** a `setInterval(pollIntervalMs)` does a **cheap change check at the source** — fetches via the http provider (304 inside the upstream's cache window), checksums the body, compares with the entity's `checksum`. Unchanged → silent return. Changed → bump `parent.time`, call `triggeredHook` to wake the watch loop, and the same `onProcess` path runs fanout. The gate at the poll means an unchanged URL produces zero process cycles.
4. **Fetching:** `readEntityContent(parent)` routes to the **built-in `http` provider** (ships in `mikser-io`, no separate package), which sends conditional GETs with `If-None-Match` from its in-memory ETag cache. A 304 reuses the cached body → checksum unchanged → poll returns silent.

Effectively: a poll on an unchanged URL costs **one 304 round-trip + a checksum compare** and does not start a process cycle. Polling a 50MB CSV at 60s intervals is nearly free as long as the server sets ETags (S3, GCS, Cloudflare, Netlify, raw.githubusercontent.com all do).

## End-to-end demo: Google Sheets → product pages

1. Operator publishes a Google Sheet as "anyone with the link can view → CSV" (`File → Share → Publish to web → CSV`). Copy the URL.
2. mikser config:
   ```js
   csv({
       match: {
           'https://docs.google.com/spreadsheets/d/.../pub?output=csv': {
               idColumn:   'sku',
               collection: 'documents',
               prefix:     '/products/',
               coerce:     true,
               filter:     { status: 'published' },
               pollIntervalMs: 120_000,         // 2-minute lag
           },
       },
   })
   ```
3. Layouts:
   ```js
   layouts({ match: { '/products/**': 'product' } })
   ```
4. `layouts/product.hbs`:
   ```hbs
   <h1>{{document.meta.name}}</h1>
   <p>SKU {{document.meta.sku}}</p>
   <p>${{document.meta.price}}</p>
   ```
5. Run:
   ```bash
   mikser --watch
   ```

Each row in the sheet renders to `/products/<sku>.html`. Edit a cell in Google Sheets, ~2 minutes later the corresponding page updates. Marketing team never touches mikser; their workflow is "edit the sheet."

### A sheet written for people: titles over keys, no key column

A table someone edits by hand often has a row of readable titles above the row of keys, and rows that no single column tells apart: a rule table where two rows share every value that names them and differ only in their conditions. Publish it as TSV, take the keys from row 2, and key the rows by the line they are on:

```js
'https://docs.google.com/spreadsheets/d/e/.../pub?gid=0&single=true&output=tsv': {
    delimiter:  '\t',
    quote:      false,     // TSV has no quoting; a `"` in a cell is a character
    headerRow:  2,         // row 1: titles for people; row 2: the keys
    lineColumn: 'row',     // every row gets `row`: 3, 4, 5 … as the sheet numbers them
    idColumn:   'row',
    collection: 'documents',
    prefix:     '/rules/',
},
```

A row inserted in the middle moves every row below it down by one line, which reaches the catalog as an update to each of them rather than as a delete and a create. That fits a table read as a whole. For pages addressed by their id, use a real key column.

## State persistence

Parent-level state lives **on the parent entity itself** — `parent.checksum` (sha256 of the last successfully-parsed CSV body; the fast skip-if-unchanged gate) and `parent.meta.csvColumns` (column-order snapshot, diagnostic). Both ride on `mikser_entities` via the standard catalog write path, so there's one schema to evolve and one place to look when investigating why a poll didn't pick something up.

Per-row state has its own table because there can be many rows per parent and the diff needs them keyed:

```sql
mikser_csv_rows (
    parent_id, row_key,
    entity_id, row_hash, last_seen_at,
    PRIMARY KEY (parent_id, row_key)
);
```

Lives in `runtime/mikser.sqlite` via `registerSchema`. No FK to `mikser_entities`: `onProcess` runs while the parent's own CREATE journal entry may still be pending, and a FK would block the row-state writes that fanout is producing in the same iteration. Cleanup-on-parent-delete is handled explicitly in the `onProcess` `DELETE` branch (`dropAllForParent` walks the row state and emits `deleteEntity` for each row entity).

`--clear` wipes the catalog (and with it the entity-borne checksum + columns) and forces a fresh fanout regardless of any previous state.

## What v1 does NOT cover

- **Multi-table CSVs.** One CSV file = one table = N rows.
- **CSV write-back.** Read-only. CSV-as-output is `mikser-io-render-csv`'s job (planned).
- **JSON / JSONL / XLSX.** Separate plugins; conceptually identical mechanism. (`mikser-io-jsonl`, `mikser-io-xlsx` would each follow this shape.)
- **GitHub Apps / OAuth on URL sources.** Operator-supplied headers cover Bearer / Basic auth.
- **Real-time push.** Polling only — Drive sheets and most public CSV endpoints don't offer webhooks. Native push notifications are a v2 concern when v9 actually has one in production.

## Troubleshooting

### `csv: match[…] requires an idColumn`

Pick a column whose values uniquely identify a row (SKU, email, ID, order_number). Without it, every row edit would look like wholesale delete-and-recreate.

### URLs in match but plugin doesn't poll

`pollIntervalMs` defaults apply only in watch mode (`mikser --watch`). One-shot builds (`mikser`) ingest once at `onImport` and exit. If you need polling on a non-watch build, set up an external cron that runs `mikser` periodically.

### `csv: <id> — readEntityContent failed: HTTP 401`

URL endpoint requires auth, but `headers` is missing or wrong. Check that the Authorization token has access to the CSV resource — try `curl -H "Authorization: Bearer …" <url>` first.

### Rows appearing then disappearing on next cycle

Filter is excluding them on second sync. Common causes:
- A `$exists: true` rule failing because a column has `null` after coercion (empty cell).
- An ISO date that doesn't quite match (`'2026-6-15'` lacks the zero-padded month → `Date.parse` returns NaN → coerce returns the original string → comparison vs `$gte: '2026-01-01'` is a string compare, not a date compare).

Run `mikser --debug` and check the "csv: <id> — N parsed, M passed filter (K excluded)" line to confirm what got dropped.

### Same row gets repeatedly updated even when source hasn't changed

`parent.checksum` differs from the previous run's even though the data didn't really change. Causes:
- Trailing whitespace or BOM differences between exports.
- Date columns where the export changes timezone (e.g. `2026-06-15T00:00:00+00:00` vs `2026-06-15T00:00:00Z`).
- Empty trailing rows added/removed by the exporting tool.

For a one-off, `mikser --clear` resets the state. For chronic cases, normalize at export time, OR set `coerce: { the_problem_column: 'date' }` to stabilize the format.

### `csv:` log line absent — plugin doesn't see the parent at all

Glob mode: confirm the parent CSV entity exists. Run `mikser_query_entities` via MCP, or check via the catalog API endpoint. The `match` glob pattern is matched against `entity.id`, not against the filesystem path.

URL mode: confirm `urlToParentId` produced an id mikser saved. Look for `csv: registered URL source <url> → <parent-id>` at startup.

## License

MIT
