import Header from "@/app/_components/header";
import { chrome } from "@/lib/chrome";
import { one, query } from "@/lib/db";
import { dash, MACHINE_STATE, num } from "@/lib/format";
import ClickRow from "@/lib/row";
import { orderBy, sortHref, Th, type Column, type SortSpec } from "@/lib/table";

export const dynamic = "force-dynamic";

// Each group's own column asks a different question of the same ledger.
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

// A row is a physical unit, not a machine code: the sites number their own
// equipment, so press_01 exists once at each location and reports separately.
// The three states, the signal behind one and the glitch tally all come from
// the machine_state view, which is where the rule lives: see @state in
// scripts/schema.sql. Home reads the same view, so the screens cannot drift.
type Row = {
  facility_id: string; machine_id: string; state: string; signal: string | null;
  last_fault: string | null; events: string; metric: string; glitches: string;
};

export default async function EquipmentPage({
  searchParams,
}: { searchParams: Promise<{ tab?: string; sort?: string; dir?: string }> }) {
  const sp = await searchParams;
  const tab: GroupKey = sp.tab && sp.tab in GROUPS ? (sp.tab as GroupKey) : "presses";
  const g = GROUPS[tab];

  const spec: SortSpec = {
    location: "s.facility_id", machine_id: "s.machine_id",
    status: "s.state_rank", signal: "s.last_job_signals", fault: "s.last_fault_at",
    events: "count(e.event_id)", metric: g.metric, glitches: "s.glitches",
  };
  const sort = orderBy(spec, sp.sort, sp.dir, "location");

  const [top, k, rows] = await Promise.all([
    chrome(),
    one<{ units: string; codes: string; locations: string; flagged: string }>(
      `select (select count(*) from machines)::text                    as units,
              (select count(distinct machine_id) from machines)::text  as codes,
              (select count(distinct facility_id) from machines)::text as locations,
              (select count(*) from machine_state
                where state <> 'operational')::text                    as flagged`),
    query<Row>(
      `select s.facility_id, s.machine_id, s.state,
              s.last_job_signals as signal,
              to_char(s.last_fault_at, 'YYYY-MM-DD') as last_fault,
              count(e.event_id)::text as events,
              ${g.metric}::text       as metric,
              s.glitches::text        as glitches
       from machine_state s
            left join events e on e.facility_id = s.facility_id and e.machine_id = s.machine_id
       where s.kind = $1
       group by s.facility_id, s.machine_id, s.state, s.state_rank,
                s.last_job_signals, s.last_fault_at, s.glitches
       order by ${sort.sql} nulls last, s.facility_id, s.machine_id`, [g.kind]),
  ]);

  const cols: Column[] = [
    { key: "location", label: "Location" }, { key: "machine_id", label: "Machine" },
    { key: "status", label: "Status" }, { key: "signal", label: "Signal" },
    { key: "fault", label: "Last fault", num: true },
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
            Location + machine identifies a physical unit. {num(k.codes)} machine codes across{" "}
            {num(k.locations)} locations, {num(k.units)} units in all, {num(k.flagged)} not operational.
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
                    const state = MACHINE_STATE[r.state] ?? MACHINE_STATE.operational;
                    const unit = `/equipment/${r.facility_id}/${r.machine_id}`;
                    return (
                      <ClickRow key={unit} href={unit}>
                        <td style={{ fontVariantNumeric: "tabular-nums" }}>{r.facility_id}</td>
                        <td style={{ fontVariantNumeric: "tabular-nums" }}><a href={unit}>{r.machine_id}</a></td>
                        <td>
                          <span className="tag" style={{ background: state.bg, color: state.ink }}>
                            {state.label}
                          </span>
                        </td>
                        <td>{dash(r.signal)}</td>
                        <td style={numeric}>{dash(r.last_fault)}</td>
                        <td style={numeric}>{num(r.events)}</td>
                        <td style={numeric}>{num(r.metric)}</td>
                        <td style={numeric}>{num(r.glitches)}</td>
                      </ClickRow>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
              Non-operational means the unit&rsquo;s last machine_fault block is still standing: no
              unblock on that job, and no job given to the unit since. Degraded means it is running,
              but the job it was last put on threw a sensor glitch, named under Signal. Glitches
              counts every anomaly the unit ever reported, the ones the feed left unattributed
              included, since the job hands those back to the press that ran it.
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
