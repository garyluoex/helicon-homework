# Helicon Homework

## Tech Stack

- Claude Code & Claude Design for development
- Vercel deployment, https://helicon-homework.vercel.app, auto-deployed from `main`
- TypeScript Next.js app
- Neon (Postgres), free plan, provisioned through the Vercel marketplace

## Data Exploration 

Refer to `designs/manufacturing_events_profile.html` and `designs/job_histories.html`

## Assumptions checked

| Field | Finding |
|---|---|
| `event_id` | **Not unique.** See below |
| `timestamp` | File order matches timestamp order, globally and within all 312 jobs. Nothing in the future. 297 timestamps are shared by more than one event, and 32 of those collisions are inside a single job, so replay needs a tie-break (`occurred_at, event_id`) |
| `job_id` | A job never changes its `part_id`, `customer_id`, `material` or facility. All four are safe on the job |
| `machine_id` | Null on 704 events: all 312 `job_created`, 158 completions, 98 cycles, 49 inspections. Present on 96.4% overall |
| `machine_id` + `facility` | **Not unique on its own.** All 10 codes appear at both `la_01` and `la_02`, so the sites number their own equipment: 20 physical units, not 10. Location + machine is the key. Every event carries a facility, and all 312 jobs stay at one site, so no job's press straddles the two |
| `material` | A part maps to exactly one material across all 19,519 events |

## The event_id problem

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

**Decided: keep the last record received in file order.** No perfect solution here unless have more context on why this happens.

## Database Schema design

Refer to schema design in `designs/schema_proposal.html`.

### Tables
1. `events`
2. `jobs`
3. `parts`
4. `machines`
5. `customers`
6. `users`

`scripts/schema.sql` is the database DDL containing the schema with all the columns for each table.

## Product

### What "most useful" means

1. Deliver parts that meet the **quality**
2. Deliver parts within **time** constraint
3. Be efficient to reduce **cost**

### Pages

| Page | Route | What it shows |
|---|---|---|
| Login | `/login` | one shared credential in env quick hack, gated by middleware |
| Home | `/` | four KPIs over a selectable window, plus jobs with open blocks and sensor glitches by machine |
| Jobs | `/jobs` | three tabs with counts, nine sortable columns, filter by job, customer or part |
| Job | `/jobs/[id]` | six KPIs, lifecycle strip, unit and phase bars, and the job's full event timeline |
| Customers | `/customers` | six KPIs and a sortable book of accounts |
| Customer | `/customers/[id]` | one account's stats, its parts and its jobs |
| Parts | `/parts` | 25 parts with scrap rate and median cycle gap |
| Part | `/parts/[id]` | one part's stats, real defect codes, and its jobs |
| Equipment | `/equipment` | presses, inspection stations and tooling cells, one row per physical unit (location + machine), with operational status from machine faults |

### Machine status

A unit is a **location plus a machine code**, never a code on its own. All ten
codes appear at both `la_01` and `la_02`, so `press_01` names two different
presses and the screen carries twenty rows, not ten. Everything below is scoped
to the unit: one site's press going down says nothing about the other's.

A unit reads **Non-operational** when its most recent `job_blocked` carrying
`reason = machine_fault` is still standing. Seven faults appear in the feed; two
name no `machine_id`, so they fall back to the press their job started on.

A fault stands until the unit is seen working again, either the job's own
`job_unblocked` or any job started on that unit since. That second clause
matters: `job_0125`'s fault on `press_03` is never unblocked, but `press_03`
takes `job_0166` three hours later and presses through to the end of the feed.
The stale block belongs to the job, not to the equipment, so **every unit reads
Operational at the end of this feed** and the table carries the date of each
unit's last fault beside it.

Sensor glitches stay a separate count. They are noise on a signal, not a stop.

### Job alerts (Future Idea)

Customizable rules that flag a job at risk of delay, delivery failure or bad data:

1. No update for too long
2. Unlikely to meet its deadline
3. Inspected units exceed pressed units (note: the feed runs the other way, cycles overshoot inspections by 1.48x on median)
4. Events arrive out of order
5. Lifecycle order broken: created -> tool ready -> started
