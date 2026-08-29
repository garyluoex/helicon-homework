# Gary Helicon Homework

Analysis of a composites manufacturing event feed, and the design for a small ERP
built on top of it.

## Stack

- Vercel deployment, https://helicon-homework.vercel.app, auto-deployed from `main`
- TypeScript Next.js app
- Tailwind UI
- Neon (Postgres), free plan, provisioned through the Vercel marketplace
- Zod model validation

## Setup

Requires Node 20.6+ (for `node --env-file`), and the [Vercel CLI](https://vercel.com/docs/cli) logged in
(`vercel login`) for anything touching the deployment or the database.

```bash
npm install
npm run dev          # http://localhost:3000
```

### Deployment

The Vercel project `helicon-homework` is connected to this GitHub repo, so a push
to `main` deploys to production and any other branch gets a preview URL. To
reproduce the wiring from scratch:

```bash
vercel link --yes                # create and link the project
vercel git connect               # deploy on push (needs the Vercel GitHub app
                                 # authorised on the repo, which for a private
                                 # repo means approving it in the browser)
vercel deploy --prod             # manual deploy, no git needed
```

### Database

Neon is provisioned as a Vercel marketplace resource, so the connection strings
arrive as project environment variables rather than being managed by hand:

```bash
vercel integration add neon --name helicon-db   # accept the marketplace terms in
                                                # a real terminal first, once:
                                                # vercel integration accept-terms neon
vercel env pull                                 # writes .env.local, gitignored
npm run db:schema                               # runs scripts/schema.sql, prints the tables
npm run db:load                                 # loads the event feed, ~10s
```

`db:schema` connects on `DATABASE_URL_UNPOOLED`, the direct connection rather than
the pooler, because it is DDL. It expects an empty database: the file is plain
`CREATE`, not `CREATE IF NOT EXISTS`, so a second run fails on the first object
that already exists. To start over:

```sql
drop schema public cascade; create schema public;
```

## Data

`data/manufacturing_events.jsonl`

| | |
|---|---|
| Events | 19,519 |
| Window | 2026-07-03 to 2026-08-13 (42 days) |
| Jobs | 312 |
| Facilities | 2 (`la_01` 17,986 events, `la_02` 1,533) |
| Customers / parts / materials | 16 / 25 / 8 |
| Machines / tools / badges | 10 / 25 / 36 (24 operators, 12 inspectors) |

Every record has the same 10 top-level fields (`event_id`, `timestamp`,
`event_type`, `job_id`, `part_id`, `customer_id`, `machine_id`, `material`,
`quantity`, `metadata`) plus a `metadata` object carrying 15 different keys
depending on the event type.

### Event types

| Type | Count | Meaning |
|---|---|---|
| `cycle_completed` | 12,965 | One press cycle finished. Carries units out and cycle time |
| `inspection_passed` | 2,765 | QC accepted a batch |
| `inspection_failed` | 2,388 | QC rejected a batch, with a defect code |
| `job_created` | 312 | Order booked: priority, target quantity, due date, price |
| `tool_ready` | 302 | Tooling prepared and available for the job |
| `job_started` | 302 | Job goes on a press, with an operator |
| `job_completed` | 282 | Order closed, with good and scrap totals |
| `job_blocked` | 68 | Work stopped for a named cause |
| `job_unblocked` | 59 | Work resumed |
| `shift_handoff` | 17 | Shift boundary marker |
| `maintenance_ping` | 16 | Machine maintenance heartbeat |
| `sensor_glitch` | 16 | Sensor anomaly: pressure, temp or platen |
| `material_lot_scan` | 14 | A material lot id recorded against a job |
| `job_hold` | 13 | Work paused, no reason given |

### Assumptions checked

| Field | Finding |
|---|---|
| `event_id` | **Not unique.** See below |
| `timestamp` | File order matches timestamp order, globally and within all 312 jobs. Nothing in the future. 297 timestamps are shared by more than one event, and 32 of those collisions are inside a single job, so replay needs a tie-break (`occurred_at, event_id`) |
| `job_id` | A job never changes its `part_id`, `customer_id`, `material` or facility. All four are safe on the job |
| `machine_id` | Null on 704 events: all 312 `job_created`, 158 completions, 98 cycles, 49 inspections. Present on 96.4% overall |
| `material` | A part maps to exactly one material across all 19,519 events |
| `quantity` | Means three different things: a batch on cycles, the whole order on created and completed, and a constant 0 on the nine marker types |
| `metadata.facility` | On every event, the only universal metadata key |
| `metadata.priority` | `job_created` only. low / normal / high |
| `metadata.target_due_at` | `job_created` only |
| `metadata.target_quantity` | `job_created` only |
| `metadata.unit_price_estimate` | `job_created` only, and on just 150 of 312 (48%). Any revenue total silently omits half the work |

### The event_id problem

19 ids appear twice. 14 pairs are byte-identical, so dropping the second copy is
free. The other 5 differ in exactly one field, `quantity`, always by 1, always a
`cycle_completed` repeated on the very next line with an identical timestamp:

| Event | Job | Quantity |
|---|---|---|
| `evt_005087` | job_0216 | 5 -> 4 |
| `evt_009610` | job_0252 | 14 -> 13 |
| `evt_009935` | job_0104 | 9 -> 8 |
| `evt_014575` | job_0189 | 5 -> 6 |
| `evt_014986` | job_0166 | 13 -> 12 |

Nothing distinguishes a correction from producer noise: no sequence number, no
revision flag, identical timestamps, so file order is the only signal.
Cross-referencing does not settle it either. On the 4 of those jobs that
completed, inspected units, good + scrap and `target_quantity` are all the same
number, while cycle units overshoot the order by 85 to 238 (median 1.48x
feed-wide). Nothing downstream reconciles against a cycle quantity, so a +/-1
there is unverifiable. job_0166 never completed and has no inspections at all.

**Decided: keep the last, as a restatement.** The stake is only 3 net units
against 126,168, but the rule also governs the next conflict, which may not be
this harmless, and a producer that sends a row twice is more likely correcting
itself than duplicating at random.

The cost is real. The ledger is no longer strictly append-only for a repeated
id, and a rewritten payload invalidates counters already accumulated from the
old one. Rather than teach `apply_event` to subtract, which every event would
then pay for, `process_event` calls `rebuild_job` and replays that one job from
the ledger. So a repeated `event_id` has three outcomes:

| Outcome | When | What happens |
|---|---|---|
| `applied` | new id | insert, then `apply_event` |
| `restated` | id seen, payload differs | overwrite the row, then `rebuild_job` |
| `unchanged` | id seen, payload identical | nothing at all |

The 14 identical repeats cost nothing. Only the 5 real restatements trigger a
rebuild. Loading the feed reports all 19 by id.

## Database design

`scripts/schema.sql` is the executable DDL, applied to Neon with
`npm run db:schema`. `designs/schema_proposal.html` is the writeup, including a
decision log of every fork and what was chosen.

Six tables, 48 columns. `events` is an append-only ledger with `event_id` as its
primary key and no other constraint, so it accepts whatever the shop reported.
`jobs` is a 29-column projection maintained forward by the ingest. `customers`,
`parts` and `machines` are registries created on sight, and each earns its table
by carrying something beyond the code: a part states its material, a machine code
states its kind. Facility, tool, material and badge stay as values on the events.
`users` is a login and writes nothing.

Five functions: `apply_event` (the projection, the only thing that moves a
counter), `process_event` (registries, then the ledger write, then apply or
repair), `process_events` (one round trip per batch, in order), `rebuild_job`
(replay one job) and `rebuild_jobs` (replay all of them). Eight `dq_` views, one
per anomaly found in the data.

## Product

### What "most useful" means

1. Deliver parts that meet the quality requirement inside the time constraint
2. Be efficient in time and cost, to maximise revenue
3. Surface the high-importance, revenue-impacting things first

### Pages

- **Login**
- **Home** - key metrics across factory operations, plus a list of events needing attention
- **Jobs** - list sectioned by created, in progress and completed, each line a job with key metadata, plus per-section metrics
- **Job** - key metadata and metrics for one job
- **Customers** - customers with their parts and revenue
- **Customer** - one customer's metadata, metrics and parts
- **Parts** - key metadata and metrics
- **Part** - one part's metadata and metrics
- **Equipment** - machines by facility and kind (press, tooling, QC), showing glitches and sensors

### Job alerts

Rules that flag a job at risk of delay, delivery failure or bad data:

1. No update for too long
2. Unlikely to meet its deadline
3. Inspected units exceed pressed units (note: the feed runs the other way, cycles overshoot inspections by 1.48x on median)
4. Events arrive out of order
5. Lifecycle order broken: created -> tool ready -> started

### Priority order

1. Database schema
2. Jobs page
3. Job page
4. Home page

## Loading the feed

`npm run db:load` runs `scripts/load-events.mjs`: one transaction that truncates,
then sends the 19,519 lines through `process_events` in batches of 500, about 10
seconds against Neon. Every line goes through the same `process_event` the live
path would use, so the run reports what the database actually did with it:

```
19519 events in 40 batches, 10.3s
  applied   19500
  restated  5   evt_005087 evt_009610 evt_009935 evt_014575 evt_014986
  unchanged 14  evt_001846 evt_001862 ...
  events    19500
  jobs      312
  customers 16
  parts     25
  machines  10
```

Verified after loading: the 5 restated events hold the second copy's quantity,
and `rebuild_jobs()` replays the ledger to a projection identical to the one the
incremental path built, so the repair path and the live path agree.

One finding came out of the load. `job_0293` was recorded as the feed's double
completion, two `job_completed` events for one order. Both lines carry the id
`evt_001862`, so it was never a double completion, only the duplicate-id problem
in different clothing. `dq_double_completions` now correctly returns nothing and
stays as the guard for a job that really does complete twice under two ids.

## Next

- Pages, starting with the jobs list

## Deliverables

| File | What it is |
|---|---|
| `scripts/schema.sql` | The schema, executable |
| `scripts/load-events.mjs` | Loads the event feed into the database |
| `designs/schema_proposal.html` | Schema writeup and decision log |
| `designs/manufacturing_events_profile.html` | Every field, its distinct values and their frequencies |
| `designs/job_histories.html` | Full event timeline for ten representative jobs |
| `designs/field_profile.json` | Complete value counts, including fields truncated in the HTML |
