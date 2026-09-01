// Runs the console's own queries against Neon and prints the numbers each
// screen renders, so truth.py's figures can be diffed against them.
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const q = async (sql, values = []) => (await pool.query(sql, values)).rows;
const one = async (sql, values = []) => (await q(sql, values))[0];
const out = {};

// ---- feed shape -------------------------------------------------------
out.feed = await one(`
  select (select count(*) from events)::int    as ledger_events,
         (select count(*) from jobs)::int      as jobs,
         (select count(*) from customers)::int as customers,
         (select count(*) from parts)::int     as parts,
         (select count(*) from machines)::int  as machines,
         to_char(min(occurred_at), 'YYYY-MM-DD') as feed_start,
         to_char(max(occurred_at), 'YYYY-MM-DD') as feed_end
  from events`);
out.event_types = Object.fromEntries(
  (await q("select event_type, count(*)::int as n from events group by 1 order by 2 desc"))
    .map((r) => [r.event_type, r.n]));

// ---- home (app/page.tsx) ---------------------------------------------
const FROM = "(select max(occurred_at) from events) - make_interval(days => $1::int)";
out.home = {};
for (const days of [7, 30, 42]) {
  out.home[days] = await one(`
    select to_char(max(occurred_at), 'YYYY-MM-DD') as feed_end,
           to_char(greatest(min(occurred_at), ${FROM}), 'YYYY-MM-DD') as window_start,
           ceil(extract(epoch from (max(occurred_at) - greatest(min(occurred_at), ${FROM}))) / 86400)::int as window_days,
           (select count(*) from jobs where status <> 'completed')::int as in_progress,
           (select count(*) from jobs where created_event_at >= ${FROM})::int as created_in_range,
           (select count(*) from jobs where completed_at >= ${FROM})::int as done_in_range,
           (select count(*) from events where event_type = 'tool_ready' and occurred_at >= ${FROM})::int as tools,
           (select coalesce(sum(quantity), 0) from events where event_type = 'cycle_completed' and occurred_at >= ${FROM})::int as pressed,
           (select coalesce(sum(quantity), 0) from events where event_type = 'inspection_passed' and occurred_at >= ${FROM})::int as pass_units,
           (select coalesce(sum(quantity), 0) from events where event_type = 'inspection_failed' and occurred_at >= ${FROM})::int as fail_units,
           (select count(*) from (
              select job_id from events where event_type in ('job_blocked', 'job_unblocked')
              group by 1 having count(*) filter (where event_type = 'job_blocked')
                         > count(*) filter (where event_type = 'job_unblocked')) b)::int as open_blocks,
           (select count(*) from events where event_type = 'sensor_glitch')::int as glitch_events,
           (select count(*) from machines)::int as units,
           (select count(*) from machine_state where state <> 'operational')::int as flagged_units
    from events`, [days]);
}

out.home_open_block_rows = await q(`
  with feed as (select max(occurred_at) as hi from events),
  b as (select job_id,
               count(*) filter (where event_type = 'job_blocked')   as blocks,
               count(*) filter (where event_type = 'job_unblocked') as unblocks
        from events where event_type in ('job_blocked', 'job_unblocked') group by 1)
  select b.job_id,
         (select e.metadata ->> 'reason' from events e
          where e.job_id = b.job_id and e.event_type = 'job_blocked'
          order by e.occurred_at desc limit 1) as cause,
         coalesce(j.machine_id, j.facility_id) as where_at,
         to_char(j.last_event_at, 'YYYY-MM-DD') as when_at,
         floor(extract(epoch from (feed.hi - j.last_event_at)) / 86400)::int as silent_days
  from b join jobs j using (job_id), feed
  where b.blocks > b.unblocks order by b.job_id`);

out.home_state_rows = await q(`
  with feed as (select max(occurred_at) as hi from events)
  select s.machine_id || ' · ' || s.facility_id as where_at,
         s.state,
         case when s.state = 'non_operational' then 'machine_fault'
              else s.last_job_signals end as problem,
         to_char(s.last_event_at, 'YYYY-MM-DD') as when_at,
         floor(extract(epoch from (feed.hi - s.last_event_at)) / 86400)::int as silent_days
  from machine_state s, feed
  where s.state <> 'operational' order by 1`);

// ---- jobs (app/jobs/page.tsx) ----------------------------------------
const TABS = {
  "in-progress": ["in_progress", "blocked", "on_hold"],
  pending: ["created", "tooling_ready"],
  completed: ["completed"],
};
out.jobs_tabs = {};
for (const [tab, statuses] of Object.entries(TABS)) {
  out.jobs_tabs[tab] = await one(`
    select count(*)::int as jobs,
           coalesce(sum(j.cycle_units), 0)::int             as units_pressed,
           coalesce(sum(j.target_quantity), 0)::int         as units_booked,
           coalesce(sum(j.good_quantity), 0)::int           as good_units,
           count(*) filter (where j.status = 'blocked')::int as blocked,
           count(*) filter (where j.status = 'created')::int as awaiting_tooling,
           count(*) filter (where j.completed_at <= j.target_due_at)::int as on_time
    from jobs j where j.status = any($1)`, [statuses]);
}
out.jobs_total = (await one("select count(*)::int as n from jobs")).n;
out.status_counts = Object.fromEntries(
  (await q("select status::text, count(*)::int as n from jobs group by 1 order by 1"))
    .map((r) => [r.status, r.n]));

// ---- customers (app/customers/page.tsx) ------------------------------
const REVENUE = "coalesce(sum(unit_price_estimate * coalesce(good_quantity, target_quantity)), 0)";
out.customers_kpis = await one(`
  select count(distinct customer_id)::int                              as customers,
         count(distinct customer_id) filter (where status <> 'completed')::int as customers_open,
         count(*)::int                                                 as jobs,
         count(*) filter (where status <> 'completed')::int            as open_jobs,
         sum(target_quantity)::int                                     as ordered,
         coalesce(sum(good_quantity), 0)::int                          as good,
         count(*) filter (where completed_at is not null)::int         as done,
         count(*) filter (where completed_at <= target_due_at)::int    as on_time,
         count(*) filter (where unit_price_estimate is not null)::int  as priced,
         round(${REVENUE})::int                                        as revenue,
         (select count(*) from (select customer_id from jobs
            group by 1 having count(distinct facility_id) = 2) x)::int as both_sites
  from jobs`);
out.customer_rows = await q(`
  select customer_id, count(*)::int as jobs,
         count(*) filter (where status <> 'completed')::int as open_jobs,
         sum(target_quantity)::int as ordered,
         coalesce(sum(good_quantity), 0)::int as good,
         count(*) filter (where completed_at is not null)::int as done,
         count(*) filter (where completed_at <= target_due_at)::int as on_time,
         round(${REVENUE})::int as revenue
  from jobs group by customer_id order by customer_id`);

// ---- parts (app/parts/page.tsx, app/parts/[partId]/page.tsx) ---------
const GAP = "extract(epoch from (j.last_cycle_at - j.first_cycle_at)) / nullif(j.cycle_count, 0)";
const SCRAP = "coalesce(sum(j.scrap_quantity), 0)::numeric / nullif(coalesce(sum(j.good_quantity), 0) + coalesce(sum(j.scrap_quantity), 0), 0)";
const MEDIAN = `percentile_disc(0.5) within group (order by ${GAP})`;
out.parts_kpis = await one(
  "select count(*)::int as parts, count(distinct material_id)::int as materials from parts");
out.part_rows = await q(`
  select p.part_id, p.material_id,
         count(j.job_id)::int                     as jobs,
         count(distinct j.customer_id)::int       as customers,
         coalesce(sum(j.target_quantity), 0)::int as ordered,
         coalesce(sum(j.good_quantity), 0)::int   as good,
         coalesce(sum(j.scrap_quantity), 0)::int  as scrap,
         coalesce(sum(j.inspection_fail_units), 0)::int as fail_units,
         round(100 * ${SCRAP}, 1)::float8         as scrap_rate,
         round((${MEDIAN} / 3600.0)::numeric, 1)::float8 as median_gap_h
  from parts p left join jobs j using (part_id)
  group by p.part_id, p.material_id order by p.part_id`);

// ---- equipment (app/equipment/page.tsx) ------------------------------
const METRIC = {
  press: "count(distinct e.job_id) filter (where e.event_type = 'job_started')",
  qc: "coalesce(sum(e.quantity) filter (where e.event_type in ('inspection_passed','inspection_failed')), 0)",
  tooling: "count(*) filter (where e.event_type = 'tool_ready')",
};
// Equipment reads machine_state; so does this, so the two cannot disagree by
// construction. What is checked here is that the view's fold and truth.py's
// fold of the same raw feed land on the same unit states.
out.equipment_rows = [];
for (const [kind, metric] of Object.entries(METRIC)) {
  const rows = await q(`
    with feed as (select max(occurred_at) as hi from events)
    select s.facility_id, s.machine_id, s.kind::text as kind,
           count(e.event_id)::int as events,
           s.glitches::int        as glitches,
           ${metric}::int         as metric,
           s.state,
           to_char(s.last_fault_at, 'YYYY-MM-DD') as last_fault,
           s.last_job_id,
           s.last_job_signals as signal,
           to_char(s.last_event_at, 'YYYY-MM-DD') as last_event_at,
           floor(extract(epoch from (feed.hi - s.last_event_at)) / 86400)::int as silent_days
    from machine_state s
      left join events e on e.facility_id = s.facility_id and e.machine_id = s.machine_id
      cross join feed
    where s.kind = $1::machine_kind
    group by s.facility_id, s.machine_id, s.kind, s.glitches, s.state,
             s.last_fault_at, s.last_job_id, s.last_job_signals, s.last_event_at, feed.hi
    order by s.facility_id, s.machine_id`, [kind]);
  out.equipment_rows.push(...rows);
}
out.equipment_kpis = await one(`
  select count(*)::int                    as units,
         count(distinct machine_id)::int  as codes,
         count(distinct facility_id)::int as locations,
         (select count(*) from machine_state where state <> 'operational')::int as flagged
  from machines`);

// ---- machine detail (app/equipment/[facilityId]/[machineId]/page.tsx) -
// The page's own two queries, run for every unit. truth.py folds the same
// figures out of the raw JSONL, so the diff catches a run list that drifts.
const UNIT_SQL = `
  select s.kind::text as kind, s.state, s.glitches::int as glitches,
         to_char(s.last_fault_at, 'YYYY-MM-DD') as last_fault,
         s.last_fault_job_id, s.last_job_id,
         to_char(s.last_job_at, 'YYYY-MM-DD') as last_job_at,
         s.last_job_signals as signal,
         (select count(*) from events e
           where e.facility_id = s.facility_id
             and e.machine_id = s.machine_id)::int as events,
         (select count(distinct e.job_id) from events e
           where e.facility_id = s.facility_id
             and e.machine_id = s.machine_id)::int as jobs
  from machine_state s
  where s.facility_id = $1 and s.machine_id = $2`;

const RUNS_SQL = `
  with feed as (select max(occurred_at) as hi from events),
  visit as (
    select job_id, max(occurred_at) as last_on_unit
    from events
    where facility_id = $1 and machine_id = $2 and job_id is not null
    group by job_id),
  glitch as (
    select coalesce(e.facility_id, j.facility_id) as facility_id,
           coalesce(e.machine_id, j.machine_id)   as machine_id,
           e.job_id,
           count(*)                                          as glitches,
           string_agg(distinct e.metadata ->> 'signal', ', ') as signals
    from events e left join jobs j using (job_id)
    where e.event_type = 'sensor_glitch'
    group by 1, 2, 3)
  select j.job_id, j.status::text,
         to_char(v.last_on_unit, 'YYYY-MM-DD') as when_at,
         coalesce(g.glitches, 0)::int as glitches,
         g.signals,
         replace(j.customer_id, 'cust_', '') || ' · ' || j.part_id || ' · ' || j.material_id as subtitle,
         j.target_quantity, j.cycle_units, j.cycle_count,
         j.inspection_pass_units as pass_units,
         j.inspection_fail_units as fail_units,
         (select count(*) from events b
          where b.job_id = j.job_id and b.event_type = 'job_blocked')::int   as blocks,
         (select count(*) from events b
          where b.job_id = j.job_id and b.event_type = 'job_unblocked')::int as unblocks,
         to_char(j.target_due_at, 'YYYY-MM-DD') as due,
         (j.status <> 'completed' and j.target_due_at < feed.hi) as overdue,
         (j.inspection_pass_units + j.inspection_fail_units > 0
          and j.inspection_fail_units::numeric
              / (j.inspection_pass_units + j.inspection_fail_units) > 0.15) as failing
  from visit v
       join jobs j using (job_id)
       left join glitch g on g.facility_id = $1 and g.machine_id = $2
                         and g.job_id = v.job_id
       cross join feed
  order by v.last_on_unit desc, j.job_id desc
  limit 10`;

out.machine_detail = {};
for (const u of await q("select facility_id, machine_id from machine_state order by 1, 2")) {
  const key = `${u.facility_id}/${u.machine_id}`;
  const args = [u.facility_id, u.machine_id];
  out.machine_detail[key] = { ...(await one(UNIT_SQL, args)), runs: await q(RUNS_SQL, args) };
}

// ---- job detail (app/jobs/[jobId]/page.tsx) --------------------------
out.job_detail = {};
for (const jobId of ["job_0001", "job_0080", "job_0166", "job_0189", "job_0216", "job_0293"]) {
  const j = await one(`
    select status::text, target_quantity, cycle_count, cycle_units,
           inspection_pass_units, inspection_fail_units,
           good_quantity, scrap_quantity, event_count,
           unit_price_estimate::text, machine_id, tool_id, operator_id,
           created_event_at, completed_at, last_event_at
    from jobs where job_id = $1`, [jobId]);
  const f = await one(`
    select (select count(*) from events where job_id = $1 and event_type = 'job_blocked')::int   as blocks,
           (select count(*) from events where job_id = $1 and event_type = 'job_unblocked')::int as unblocks,
           (select count(*) from events where job_id = $1)::int as timeline_events`, [jobId]);
  out.job_detail[jobId] = { ...j, ...f };
}

process.stdout.write(JSON.stringify(out, null, 1));
await pool.end();
