import { cookies } from "next/headers";
import Header from "@/app/_components/header";
import { one, query } from "@/lib/db";
import { COOKIE_NAME, verify } from "@/lib/session";

export const dynamic = "force-dynamic";

const RANGES = [
  { days: 7, label: "Past 7 days" },
  { days: 30, label: "Past 30 days" },
  { days: 42, label: "Full" },
];

type Kpis = {
  feed_end: string; window_start: string; window_days: string;
  in_progress: string; done_in_range: string; tools: string;
  pressed: string; pass_units: string; fail_units: string;
  // Totals for the attention notes. The tables below show at most 8 rows, so
  // counting what is rendered would understate the real backlog.
  open_blocks: string; glitch_events: string; glitch_machines: string;
};
type JobRow = { job_id: string; cause: string | null; where_at: string; when_at: string; silent: string };
type EquipRow = { where_at: string; signals: string; alerts: string; when_at: string; silent: string };

const n = (v: string | number | null) =>
  v === null ? "—" : Number(v).toLocaleString("en-US");

export default async function Home({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const asked = Number((await searchParams).range);
  const rangeDays = RANGES.some((r) => r.days === asked) ? asked : 42;
  // The feed ends before today, so every window is measured back from the last
  // event rather than from now.
  const from = `(select max(occurred_at) from events) - make_interval(days => $1::int)`;

  // Middleware already rejected an invalid cookie; this reads who it belongs to.
  const userId = await verify((await cookies()).get(COOKIE_NAME)?.value);

  const [k, jobRows, equipRows, user] = await Promise.all([
    one<Kpis>(
      `select to_char(max(occurred_at), 'YYYY-MM-DD') as feed_end,
              to_char(greatest(min(occurred_at), ${from}), 'YYYY-MM-DD') as window_start,
              ceil(extract(epoch from (max(occurred_at) - greatest(min(occurred_at), ${from}))) / 86400)::text as window_days,
              (select count(*) from jobs where status <> 'completed')::text as in_progress,
              (select count(*) from jobs where completed_at >= ${from})::text as done_in_range,
              (select count(*) from events where event_type = 'tool_ready' and occurred_at >= ${from})::text as tools,
              (select coalesce(sum(quantity), 0) from events where event_type = 'cycle_completed' and occurred_at >= ${from})::text as pressed,
              (select coalesce(sum(quantity), 0) from events where event_type = 'inspection_passed' and occurred_at >= ${from})::text as pass_units,
              (select coalesce(sum(quantity), 0) from events where event_type = 'inspection_failed' and occurred_at >= ${from})::text as fail_units,
              (select count(*) from (
                 select job_id from events where event_type in ('job_blocked', 'job_unblocked')
                 group by 1 having count(*) filter (where event_type = 'job_blocked')
                            > count(*) filter (where event_type = 'job_unblocked')) b)::text as open_blocks,
              (select count(*) from events where event_type = 'sensor_glitch')::text as glitch_events,
              (select count(distinct coalesce(machine_id, 'press unassigned'))
               from events where event_type = 'sensor_glitch')::text as glitch_machines
       from events`, [rangeDays]),

    // A job with more blocks than unblocks never had its stop lifted. Three of
    // these kept cycling afterwards, so they still read in_progress.
    query<JobRow>(
      `with feed as (select max(occurred_at) as hi from events),
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
              floor(extract(epoch from (feed.hi - j.last_event_at)) / 86400)::text as silent
       from b join jobs j using (job_id), feed
       where b.blocks > b.unblocks
       order by j.last_event_at limit 8`),

    query<EquipRow>(
      `with feed as (select max(occurred_at) as hi from events)
       select coalesce(e.machine_id, 'press unassigned') as where_at,
              string_agg(distinct e.metadata ->> 'signal', ', ') as signals,
              count(*)::text as alerts,
              to_char(max(e.occurred_at), 'YYYY-MM-DD') as when_at,
              floor(extract(epoch from (feed.hi - max(e.occurred_at))) / 86400)::text as silent
       from events e, feed where e.event_type = 'sensor_glitch'
       group by 1, feed.hi order by max(e.occurred_at) limit 8`),

    one<{ display_name: string | null; email: string }>(
      "select display_name, email from users where user_id = $1", [userId]),
  ]);

  const inspected = Number(k.pass_units) + Number(k.fail_units);
  const kpis = [
    { label: "In progress jobs", value: n(k.in_progress), note: `not yet completed · ${n(k.done_in_range)} completed in range` },
    { label: "Tools prepared", value: n(k.tools), note: "tool_ready events in range" },
    { label: "Units pressed", value: n(k.pressed), note: "cycle throughput, not order progress" },
    { label: "Units inspected", value: n(inspected), note: `${n(k.pass_units)} passed, ${n(k.fail_units)} failed` },
  ];

  const muted = { fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" };
  const numeric = { textAlign: "right" as const, fontVariantNumeric: "tabular-nums" };

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <Header current="home" feedEnd={k.feed_end} userName={user?.display_name ?? user?.email ?? "Signed in"} />
      <main style={{ flex: 1, padding: "32px 28px 72px", maxWidth: 1560, width: "100%", margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", marginBottom: 24 }}>
          <h2 style={{ margin: 0 }}>Factory overview</h2>
          <span style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
            {k.window_start} to {k.feed_end} &middot; {k.window_days} days
          </span>
          <div className="seg" style={{ marginLeft: "auto" }}>
            {RANGES.map((r) => (
              <a key={r.days} className="seg-opt" href={r.days === 42 ? "/" : `/?range=${r.days}`}
                 aria-current={r.days === rangeDays}>
                {r.label}
              </a>
            ))}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))", gap: 20, marginBottom: 32 }}>
          {kpis.map((kpi) => (
            <div key={kpi.label} className="card" style={{ padding: "var(--space-6)", gap: 6 }}>
              <div className="card-kicker">{kpi.label}</div>
              <div style={{ fontFamily: "var(--font-heading)", fontSize: 38, lineHeight: 1 }}>{kpi.value}</div>
              <div style={muted}>{kpi.note}</div>
            </div>
          ))}
        </div>

        <section className="card" style={{ padding: "var(--space-6)", gap: "var(--space-4)" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
            <h4 style={{ margin: 0 }}>Needs attention</h4>
            <span style={muted}>
              {n(Number(k.open_blocks) + Number(k.glitch_events))} items &middot; open blocks and sensor anomalies
            </span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: "var(--space-4)" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
              <div style={{ fontFamily: "var(--font-heading)", fontSize: 16, letterSpacing: ".02em" }}>Jobs</div>
              <span style={muted}>{n(k.open_blocks)} jobs with more blocks than unblocks</span>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Job</th><th>Cause</th><th>Where</th>
                  <th style={numeric}>Last event</th><th style={numeric}>Days since update</th>
                </tr>
              </thead>
              <tbody>
                {jobRows.map((r) => (
                  <tr key={r.job_id}>
                    <td style={{ fontVariantNumeric: "tabular-nums" }}>{r.job_id}</td>
                    <td>{r.cause ?? "unstated cause"}</td>
                    <td style={{ fontVariantNumeric: "tabular-nums" }}>{r.where_at}</td>
                    <td style={numeric}>{r.when_at}</td>
                    <td style={numeric}>{r.silent}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: "var(--space-4)" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
              <div style={{ fontFamily: "var(--font-heading)", fontSize: 16, letterSpacing: ".02em" }}>Equipments</div>
              <span style={muted}>
                {n(k.glitch_events)} anomalies across {n(k.glitch_machines)} machines
              </span>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Equipment</th><th>Problem</th><th style={numeric}>Unresolved alerts</th>
                  <th style={numeric}>Last event</th><th style={numeric}>Days since update</th>
                </tr>
              </thead>
              <tbody>
                {equipRows.map((r) => (
                  <tr key={r.where_at}>
                    <td style={{ fontVariantNumeric: "tabular-nums" }}>{r.where_at}</td>
                    <td>{r.signals}</td>
                    <td style={numeric}>{r.alerts}</td>
                    <td style={numeric}>{r.when_at}</td>
                    <td style={numeric}>{r.silent}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
