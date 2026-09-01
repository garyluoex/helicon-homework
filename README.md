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
| Home | `/` | four KPIs over a selectable window, plus jobs with open blocks and every unit that is not operational |
| Jobs | `/jobs` | three tabs with counts, nine sortable columns, filter by job, customer or part |
| Job | `/jobs/[id]` | six KPIs, lifecycle strip, unit and phase bars, and the job's full event timeline |
| Customers | `/customers` | six KPIs and a sortable book of accounts |
| Customer | `/customers/[id]` | one account's stats, its parts and its jobs |
| Parts | `/parts` | 25 parts with scrap rate and median cycle gap |
| Part | `/parts/[id]` | one part's stats, real defect codes, and its jobs |
| Equipment | `/equipment` | presses, inspection stations and tooling cells, one row per physical unit (location + machine), each in one of three states |

### Machine status

A unit is a **location plus a machine code**, never a code on its own. All ten
codes appear at both `la_01` and `la_02`, so `press_01` names two different
presses and the screen carries twenty rows, not ten. Everything below is scoped
to the unit: one site's press going down says nothing about the other's.

Three states, in precedence order:

| State | Means |
|---|---|
| **Non-operational** | the unit's latest `machine_fault` block still stands |
| **Degraded** | the unit is running, but the job it was last put on threw a sensor glitch |
| **Operational** | everything else |

Two rules run through both.

**Attribution.** A signal names its unit as location plus code. 8 of the 16
sensor glitches and 2 of the 7 machine faults name no machine at all, and those
fall back to the press their job started on. A job never leaves its site, so the
location is the event's own either way.

**Assignment.** "Seen working again" is the unit's next assignment: a press
takes `job_started`, a QC station an inspection, a tooling cell `tool_ready`.
Cycles are deliberately not in that list. A fault lifts when the unit is trusted
with work, not when the blocked job squeezes out one more part, and that
distinction is the whole reason `press_03` reads operational: `job_0125`'s fault
is never unblocked, but the press takes `job_0166` three hours later and runs to
the end of the feed. The stale block belongs to the job, not to the equipment.

On this feed that leaves **one unit flagged**: `press_05` at `la_01` is
degraded, because `job_0119`, the last job it was given, threw a `temp` glitch
and no job has been put on the press since. Nothing is non-operational.

The fold lives in one place, the `machine_state` view (`@state` in
`scripts/schema.sql`). Equipment reads it, Home's attention table reads it, and
the verify harness reads it, so the rule cannot drift between screens. Glitches
stay a column of their own beside the state: the tally is history, the state is
now.

### Job alerts (Future Idea)

Customizable rules that flag a job at risk of delay, delivery failure or bad data:

1. No update for too long
2. Unlikely to meet its deadline
3. Inspected units exceed pressed units (note: the feed runs the other way, cycles overshoot inspections by 1.48x on median)
4. Events arrive out of order
5. Lifecycle order broken: created -> tool ready -> started
