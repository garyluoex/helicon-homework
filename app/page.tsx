import Header from "@/app/_components/header";
import { chrome } from "@/lib/chrome";
import { one, query } from "@/lib/db";
import ClickRow from "@/lib/row";
import { orderBy, Th, type Column, type SortSpec } from "@/lib/table";

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
  // Totals for the attention notes. Kept as their own counts rather than read
  // off the rendered rows, so the heading stays right whatever the tables show.
  open_blocks: string; glitch_events: string; glitch_machines: string;
};
type JobRow = { job_id: string; cause: string | null; where_at: string; when_at: string; silent_days: string };
type EquipRow = { where_at: string; signals: string; alerts: string; when_at: string; silent_days: string };

const n = (v: string | number | null) =>
  v === null ? "—" : Number(v).toLocaleString("en-US");

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; jsort?: string; jdir?: string; esort?: string; edir?: string }>;
}) {
  const sp = await searchParams;
  const asked = Number(sp.range);
  const rangeDays = RANGES.some((r) => r.days === asked) ? asked : 42;

  // Both attention tables sort independently, so each owns its own pair of
  // params. Days since update is the default on both: the stalest first.
  const jobSpec: SortSpec = {
    job_id: "job_id", what: "cause", where: "where_at",
    when: "last_event_at", silent: "silent_days",
  };
  const equipSpec: SortSpec = {
    where: "where_at", signals: "signals", count: "alerts",
    when: "last_at", silent: "silent_days",
  };
  const jobSort = orderBy(jobSpec, sp.jsort, sp.jdir, "silent", "desc");
  const equipSort = orderBy(equipSpec, sp.esort, sp.edir, "silent", "desc");
  // The feed ends before today, so every window is measured back from the last
  // event rather than from now.
  const from = `(select max(occurred_at) from events) - make_interval(days => $1::int)`;

  const [k, jobRows, equipRows, top] = await Promise.all([
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
       select * from (
         select b.job_id,
                (select e.metadata ->> 'reason' from events e
                 where e.job_id = b.job_id and e.event_type = 'job_blocked'
                 order by e.occurred_at desc limit 1) as cause,
                coalesce(j.machine_id, j.facility_id) as where_at,
                to_char(j.last_event_at, 'YYYY-MM-DD') as when_at,
                j.last_event_at,
                floor(extract(epoch from (feed.hi - j.last_event_at)) / 86400) as silent_days
         from b join jobs j using (job_id), feed
         where b.blocks > b.unblocks) r
       order by ${jobSort.sql} nulls last, job_id`),

    query<EquipRow>(
      `with feed as (select max(occurred_at) as hi from events)
       select * from (
         select coalesce(e.machine_id, 'press unassigned') as where_at,
                string_agg(distinct e.metadata ->> 'signal', ', ') as signals,
                count(*) as alerts,
                to_char(max(e.occurred_at), 'YYYY-MM-DD') as when_at,
                max(e.occurred_at) as last_at,
                floor(extract(epoch from (feed.hi - max(e.occurred_at))) / 86400) as silent_days
         from events e, feed where e.event_type = 'sensor_glitch'
         group by 1, feed.hi) r
       order by ${equipSort.sql} nulls last, where_at`),

    chrome(),
  ]);

  const inspected = Number(k.pass_units) + Number(k.fail_units);
  const kpis = [
    { label: "In progress jobs", value: n(k.in_progress), note: `not yet completed · ${n(k.done_in_range)} completed in range` },
    { label: "Tools prepared", value: n(k.tools), note: "tool_ready events in range" },
    { label: "Units pressed", value: n(k.pressed), note: "cycle throughput, not order progress" },
    { label: "Units inspected", value: n(inspected), note: `${n(k.pass_units)} passed, ${n(k.fail_units)} failed` },
  ];

  const jobCols: Column[] = [
    { key: "job_id", label: "Job" }, { key: "what", label: "Cause" }, { key: "where", label: "Where" },
    { key: "when", label: "Last event", num: true }, { key: "silent", label: "Days since update", num: true },
  ];
  const equipCols: Column[] = [
    { key: "where", label: "Equipment" }, { key: "signals", label: "Problem" },
    { key: "count", label: "Unresolved alerts", num: true },
    { key: "when", label: "Last event", num: true }, { key: "silent", label: "Days since update", num: true },
  ];

  // Every control on the page writes its own params and carries the others
  // through, so the range, the jobs sort and the equipment sort are independent.
  const carry = (drop: string[]) => {
    const p = new URLSearchParams();
    const all: Record<string, string | undefined> = {
      range: rangeDays === 42 ? undefined : String(rangeDays),
      jsort: sp.jsort, jdir: sp.jdir, esort: sp.esort, edir: sp.edir,
    };
    for (const [key, value] of Object.entries(all)) if (value && !drop.includes(key)) p.set(key, value);
    return p;
  };
  const nextDir = (same: boolean, dir: string, num?: boolean) =>
    same ? (dir === "asc" ? "desc" : "asc") : num ? "desc" : "asc";
  const rangeHref = (days: number) => {
    const p = carry(["range"]);
    if (days !== 42) p.set("range", String(days));
    const qs = p.toString();
    return qs ? `/?${qs}` : "/";
  };
  const jobHref = (key: string, num?: boolean) => {
    const p = carry(["jsort", "jdir"]);
    p.set("jsort", key);
    p.set("jdir", nextDir(key === jobSort.key, jobSort.dir, num));
    return "?" + p.toString();
  };
  const equipHref = (key: string, num?: boolean) => {
    const p = carry(["esort", "edir"]);
    p.set("esort", key);
    p.set("edir", nextDir(key === equipSort.key, equipSort.dir, num));
    return "?" + p.toString();
  };

  const muted = { fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" };
  const numeric = { textAlign: "right" as const, fontVariantNumeric: "tabular-nums" };

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <Header current="home" feedEnd={top.feed_end} userName={top.user_name} />
      <main style={{ flex: 1, padding: "32px 28px 72px", maxWidth: 1560, width: "100%", margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", marginBottom: 24 }}>
          <h2 style={{ margin: 0 }}>Factory overview</h2>
          <span style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
            {k.window_start} to {k.feed_end} &middot; {k.window_days} days
          </span>
          <div className="seg" style={{ marginLeft: "auto" }}>
            {RANGES.map((r) => (
              <a key={r.days} className="seg-opt" href={rangeHref(r.days)}
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
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>{jobCols.map((c) => <Th key={c.key} col={c} active={c.key === jobSort.key} dir={jobSort.dir} href={jobHref} />)}</tr>
                </thead>
                <tbody>
                  {jobRows.map((r) => (
                    <ClickRow key={r.job_id} href={`/jobs/${r.job_id}`}>
                      <td style={{ fontVariantNumeric: "tabular-nums" }}><a href={`/jobs/${r.job_id}`}>{r.job_id}</a></td>
                      <td>{r.cause ?? "unstated cause"}</td>
                      <td style={{ fontVariantNumeric: "tabular-nums" }}>{r.where_at}</td>
                      <td style={numeric}>{r.when_at}</td>
                      <td style={numeric}>{r.silent_days}</td>
                    </ClickRow>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: "var(--space-4)" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
              <div style={{ fontFamily: "var(--font-heading)", fontSize: 16, letterSpacing: ".02em" }}>Equipments</div>
              <span style={muted}>
                {n(k.glitch_events)} anomalies across {n(k.glitch_machines)} machines
              </span>
            </div>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>{equipCols.map((c) => <Th key={c.key} col={c} active={c.key === equipSort.key} dir={equipSort.dir} href={equipHref} />)}</tr>
                </thead>
                <tbody>
                  {equipRows.map((r) => (
                    <tr key={r.where_at}>
                      <td style={{ fontVariantNumeric: "tabular-nums" }}>{r.where_at}</td>
                      <td>{r.signals}</td>
                      <td style={numeric}>{r.alerts}</td>
                      <td style={numeric}>{r.when_at}</td>
                      <td style={numeric}>{r.silent_days}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
