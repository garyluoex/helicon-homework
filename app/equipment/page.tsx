import Header from "@/app/_components/header";
import { chrome } from "@/lib/chrome";
import { one, query } from "@/lib/db";
import { num } from "@/lib/format";
import { orderBy, sortHref, Th, type Column, type SortSpec } from "@/lib/table";

export const dynamic = "force-dynamic";

// Each group's fourth column asks a different question of the same ledger.
const GROUPS = {
  presses: {
    kind: "press", kicker: "Press", label: "Presses", title: "Presses", metricHead: "Jobs run",
    metric: "count(distinct e.job_id) filter (where e.event_type = 'job_started')",
  },
  qc: {
    kind: "qc", kicker: "QC", label: "Inspection stations", title: "Inspection stations", metricHead: "Units judged",
    metric: "coalesce(sum(e.quantity) filter (where e.event_type in ('inspection_passed','inspection_failed')), 0)",
  },
  tooling: {
    kind: "tooling", kicker: "Tooling", label: "Tooling cells", title: "Tooling cells", metricHead: "Tools prepared",
    metric: "count(*) filter (where e.event_type = 'tool_ready')",
  },
} as const;

type GroupKey = keyof typeof GROUPS;
const GLITCHES = "count(*) filter (where e.event_type = 'sensor_glitch')";

type Row = { machine_id: string; events: string; glitches: string; metric: string };

export default async function EquipmentPage({
  searchParams,
}: { searchParams: Promise<{ tab?: string; sort?: string; dir?: string }> }) {
  const sp = await searchParams;
  const tab: GroupKey = sp.tab && sp.tab in GROUPS ? (sp.tab as GroupKey) : "presses";
  const g = GROUPS[tab];

  const spec: SortSpec = {
    machine_id: "m.machine_id", health: GLITCHES, events: "count(e.event_id)",
    metric: g.metric, glitches: GLITCHES,
  };
  const sort = orderBy(spec, sp.sort, sp.dir, "machine_id");

  const [top, k, rows] = await Promise.all([
    chrome(),
    one<{ machines: string; both_sites: string }>(
      `select (select count(*) from machines)::text as machines,
              (select count(*) from (select machine_id from events where machine_id is not null
                 group by 1 having count(distinct metadata ->> 'facility') = 2) x)::text as both_sites`),
    query<Row>(
      `select m.machine_id,
              count(e.event_id)::text as events,
              ${GLITCHES}::text       as glitches,
              ${g.metric}::text       as metric
       from machines m left join events e using (machine_id)
       where m.kind = $1
       group by m.machine_id
       order by ${sort.sql} nulls last, m.machine_id`, [g.kind]),
  ]);

  const cols: Column[] = [
    { key: "machine_id", label: "Machine" }, { key: "health", label: "Health" },
    { key: "events", label: "Events", num: true }, { key: "metric", label: g.metricHead, num: true },
    { key: "glitches", label: "Glitches", num: true },
  ];
  const href = sortHref({ tab }, sort.key, sort.dir);
  const tabHref = (key: string) => `?tab=${key}`;
  const numeric = { textAlign: "right" as const, fontVariantNumeric: "tabular-nums" };

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <Header current="equipment" feedEnd={top.feed_end} userName={top.user_name} />
      <main style={{ flex: 1, padding: "32px 28px 72px", maxWidth: 1560, width: "100%", margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 16, marginBottom: 24 }}>
          <h2 style={{ margin: 0 }}>Equipment</h2>
          <span style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
            {num(k.machines)} machine codes, {Number(k.both_sites) === Number(k.machines) ? "each" : `${num(k.both_sites)}`} seen under both facilities. Kind is read off the code prefix.
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <div className="seg" style={{ alignSelf: "flex-start" }}>
            {(Object.keys(GROUPS) as GroupKey[]).map((key) => (
              <a key={key} className="seg-opt" href={tabHref(key)} aria-current={key === tab}>
                {GROUPS[key].label}
              </a>
            ))}
          </div>

          <section className="card" style={{ padding: "var(--space-6)", gap: "var(--space-4)" }}>
            <div className="card-kicker">{g.kicker}</div>
            <h4 style={{ margin: 0 }}>{g.title}</h4>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>{cols.map((c) => <Th key={c.key} col={c} active={c.key === sort.key} dir={sort.dir} href={href} />)}</tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const unhealthy = Number(r.glitches) > 1;
                    return (
                      <tr key={r.machine_id}>
                        <td style={{ fontVariantNumeric: "tabular-nums" }}>{r.machine_id}</td>
                        <td>
                          <span className="tag" style={{
                            background: unhealthy ? "#f7dcda" : "var(--color-accent-2-100)",
                            color: unhealthy ? "#7d2a22" : "var(--color-accent-2-800)",
                          }}>
                            {unhealthy ? "Unhealthy" : "Healthy"}
                          </span>
                        </td>
                        <td style={numeric}>{num(r.events)}</td>
                        <td style={numeric}>{num(r.metric)}</td>
                        <td style={numeric}>{num(r.glitches)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
