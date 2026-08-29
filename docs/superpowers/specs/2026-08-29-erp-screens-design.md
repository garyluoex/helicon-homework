# Helicon ERP screens: design

Covers the seven screens of the Helicon ERP design that follow Login and Home.
Written after the design conversation of 2026-08-29; stage 1 is approved and
built against it, stages 2 and 3 inherit its decisions.

Source of truth for the visuals is `Helicon ERP.dc.html` in the shared Claude
Design project, rendered against the "Industry" design system already ported to
`app/globals.css`.

## Staging

The seven screens ship in three stages so each is reviewable running.

| Stage | Screens | Why here |
|---|---|---|
| 1 | Jobs, Job | Highest value per the README's priority order, and where the shared machinery is built |
| 2 | Customers, Customer, Parts, Part | Reuse stage 1's tables and formatters; add aggregate queries |
| 3 | Equipment | Smallest, and the only screen whose design data is partly unanswerable |

## Cross-cutting decisions

**All interaction state lives in the URL.** The design holds tab, sort and
filter in client state. Here they are search params, matching the range control
already on Home: `/jobs?tab=completed&sort=due&dir=asc&q=orbit`. Every view is
shareable and survives a refresh, and no screen needs client JavaScript.

**Sorting happens in SQL, before any row cap.** A table declares its sortable
columns as a map from URL key to SQL expression. `lib/table.ts` validates the
requested key against that map and builds the `ORDER BY`; an unknown key falls
back to the table's default. User input never reaches the query text. This
matters because the design sorts the full set and then slices, so sorting the
already-capped page would mean something different.

**The filter applies on submit, not per keystroke.** A plain GET form, so no
client component and no debounce. A deliberate small departure from the design.

**Row caps follow the design.** Jobs sections cap at 25 with a footnote. With
281 completed jobs this cap only bites on that tab, where sorting is what makes
the rest reachable.

## Where real data replaces the design's fiction

The design's script generates its data with a seeded RNG. Most of what it
invents, the ledger actually holds, and the real value is used instead:

| Design invents | We source from |
|---|---|
| The job's QC station | `machine_id` on the job's inspection events (281 jobs have one) |
| The job's tooling cell | `machine_id` on `tool_ready` (`tooling_01`, `tooling_02`) |
| Defect split per job | `metadata ->> 'defect_code'` on `inspection_failed`, 6 real codes |
| Inspector list | `metadata ->> 'inspector_id'` |
| The event timeline | The ledger itself. Max 166 events on a job, p95 137 |
| Per-machine event counts (stage 3) | `count(*)` over `events` |

Three of the design's Equipment figures have no honest source: per-machine
"Events" is `400 + random x 2300`, QC "Units judged" and Tooling "Tools
prepared" are similar. Stage 3 replaces them with real counts rather than
reproducing invented ones.

**Gaps are rendered, not hidden.** `unit_price_estimate` is present on 150 of
312 jobs, so estimated value reads "not supplied" on the rest. A job with no
completion event shows an em dash for yield, good and scrap, never a zero.

## Stage 1

### Files

```
app/jobs/page.tsx           Jobs list
app/jobs/[jobId]/page.tsx   Job detail
lib/format.ts               num / money / date / duration, STATUS and priority palettes
lib/table.ts                sort whitelist to ORDER BY, and the Th header-link component
app/_components/header.tsx  Jobs stops being inert
```

### Jobs

Three tabs rendered as `seg` links, sized from the data: In progress 24
(`in_progress`, `blocked`, `on_hold`), Pending 7 (`created`, `tooling_ready`),
Completed 281. Each section carries the design's three metrics and its
footnote. Nine sortable columns: Job, Customer, Part, Facility, Priority,
Order, Pass / fail, Due, and a date column whose heading changes per tab
(Last event, Created, Completed). Rows link to the job.

### Job

Header kicker of customer, part and material, then six tags: Status, Priority,
Press, QC, Tooling, Facility. Six KPIs computed from the milestone columns on
`jobs`: lead time, tool wait, press queue, run span, yield, vs. due date. Then
the six-point lifecycle strip, the stacked unit bar with a dashed band for
units pressed beyond the order, the seven-segment phase bar, the facts table,
and the full event timeline.

### Tag palette

Taken from the design verbatim, since these are load-bearing for status
legibility:

| Status | Background | Ink |
|---|---|---|
| created, tooling_ready | `--color-neutral-200` | `--color-neutral-800` |
| in_progress | `--color-accent-100` | `--color-accent-800` |
| blocked | `#f7dcda` | `#7d2a22` |
| on_hold | `#fbe6cd` | `#7d4f14` |
| completed | `#dcefe2` | `#26603f` |

High priority reuses the blocked pair, low priority the neutral pair, normal
the accent pair.

### Verification

Each tab shows the right count; sorting a column reorders the whole section and
the arrow follows; the filter narrows and the "N of 312" label tracks it; a
completed job, a blocked job and a created-only job all render with no `NaN` or
`undefined`; the timeline row count equals that job's `event_count`; an unknown
job id 404s.

## Stage 2

Four screens on stage 1's machinery, no new dependencies:
`app/customers/page.tsx`, `app/customers/[customerId]/page.tsx`,
`app/parts/page.tsx`, `app/parts/[partId]/page.tsx`.

### Default sort direction is part of a table's design

`orderBy` takes a fallback direction alongside the fallback column, and honours
an explicit `dir` only when it arrives with a valid column. Landing on a page
with no parameters therefore gives each table the order it is meant to have:

| Table | Default |
|---|---|
| Jobs, In progress and Pending | date ascending, so the stalest work surfaces first |
| Jobs, Completed | completion descending, newest first |
| Customers | estimated revenue descending |
| A customer's parts | units descending; their jobs, created descending |
| Parts | units ordered descending |
| A part's jobs | created descending |

### Reachability

The design's nav is Home, Jobs, Equipment, Customers, so Parts has no entry
point: a part is only reachable from a customer, and the Parts list only from a
part's back link. Rather than add a nav item the design does not have, part and
customer ids became links wherever they already appeared as text, on the Jobs
table and in the Job details facts.

### Figures the design hardcodes, confirmed against the ledger

"16 accounts, 15 of them placing work at both sites" and "25 parts across 8
materials" are both exactly right. The Customers KPIs come out 312 jobs booked
with 31 open, 97,588 ordered, 78,555 good across 281 completions, 73% on time,
and $9,725,133 estimated revenue from the 150 priced jobs.

Median cycle gap is per job `(last_cycle_at - first_cycle_at) / cycle_count`,
then the median across a part's jobs, rendered in hours. The Part page's defect
breakdown groups that part's real `inspection_failed` events by `defect_code`
rather than the design's random split.
