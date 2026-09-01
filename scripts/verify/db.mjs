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
           (select count(distinct (facility_id, coalesce(machine_id, 'press unassigned')))
            from events where event_type = 'sensor_glitch')::int as glitch_units
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

out.home_glitch_rows = await q(`
  with feed as (select max(occurred_at) as hi from events)
  select coalesce(e.machine_id, 'press unassigned') || ' · ' || e.facility_id as where_at,
         string_agg(distinct e.metadata ->> 'signal', ', ') as signals,
         count(*)::int as alerts,
         to_char(max(e.occurred_at), 'YYYY-MM-DD') as when_at,
         floor(extract(epoch from (feed.hi - max(e.occurred_at))) / 86400)::int as silent_days
  from events e, feed where e.event_type = 'sensor_glitch'
  group by 1, feed.hi order by 1`);

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
// Operational state, mirroring the page: latest machine_fault per unit, still
// standing unless the job was unblocked or the unit took another job since.
const STATE = `
  fault as (
    select distinct on (facility_id, machine_id)
           facility_id, machine_id, job_id, occurred_at, event_id
    from (select coalesce(e.facility_id, j.facility_id) as facility_id,
                 coalesce(e.machine_id, j.machine_id) as machine_id,
                 e.job_id, e.occurred_at, e.event_id
          from events e left join jobs j using (job_id)
          where e.event_type = 'job_blocked'
            and e.metadata ->> 'reason' = 'machine_fault') f
    where machine_id is not null
    order by facility_id, machine_id, occurred_at desc, event_id desc
  ),
  state as (
    select f.facility_id, f.machine_id, f.occurred_at as last_fault_at,
           not (exists (select 1 from events u
                        where u.job_id = f.job_id and u.event_type = 'job_unblocked'
                          and (u.occurred_at, u.event_id) > (f.occurred_at, f.event_id))
             or exists (select 1 from events s
                        where s.facility_id = f.facility_id and s.machine_id = f.machine_id
                          and s.event_type = 'job_started'
                          and (s.occurred_at, s.event_id) > (f.occurred_at, f.event_id))) as down
    from fault f
  )`;
out.equipment_rows = [];
for (const [kind, metric] of Object.entries(METRIC)) {
  const rows = await q(`
    with ${STATE}
    select m.facility_id, m.machine_id, m.kind::text as kind,
           count(e.event_id)::int as events,
           count(*) filter (where e.event_type = 'sensor_glitch')::int as glitches,
           ${metric}::int as metric,
           to_char(max(s.last_fault_at), 'YYYY-MM-DD') as last_fault,
           coalesce(bool_or(s.down), false)            as down
    from machines m
      left join events e on e.facility_id = m.facility_id and e.machine_id = m.machine_id
      left join state s  on s.facility_id = m.facility_id and s.machine_id = m.machine_id
    where m.kind = $1::machine_kind
    group by m.facility_id, m.machine_id, s.down
    order by m.facility_id, m.machine_id`, [kind]);
  out.equipment_rows.push(...rows);
}
out.equipment_kpis = await one(`
  select count(*)::int                    as units,
         count(distinct machine_id)::int  as codes,
         count(distinct facility_id)::int as locations
  from machines`);

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
