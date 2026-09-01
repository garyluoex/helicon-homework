import Header from "@/app/_components/header";
import { chrome } from "@/lib/chrome";
import { one, query } from "@/lib/db";
import { dash, num } from "@/lib/format";
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

/**
 * Operational state, from the ledger's only machine-level stoppage: a
 * job_blocked carrying reason 'machine_fault'. Two of the seven name no
 * machine, so the fault falls back to the press the job started on.
 *
 * A machine reads by its latest fault alone, and that fault stands until the
 * machine is seen working again: the job's own job_unblocked, or any job
 * started on the machine since. job_0125's fault on press_03 is never
 * unblocked, but press_03 takes job_0166 three hours later, so the press is
 * running and the stale block belongs to the job, not to the equipment.
 *
 * All of it keys on the unit, never on the code alone: press_03 at la_01 and
 * press_03 at la_02 are two presses, and one going down says nothing about
 * the other. A job never leaves its site, so the fallback facility is the
 * event's own either way.
 */
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

// A row is a physical unit, not a machine code: the sites number their own
// equipment, so press_01 exists once at each location and reports separately.
type Row = {
  facility_id: string; machine_id: string; events: string; glitches: string; metric: string;
  last_fault: string | null; down: boolean;
};

export default async function EquipmentPage({
  searchParams,
}: { searchParams: Promise<{ tab?: string; sort?: string; dir?: string }> }) {
  const sp = await searchParams;
  const tab: GroupKey = sp.tab && sp.tab in GROUPS ? (sp.tab as GroupKey) : "presses";
  const g = GROUPS[tab];

  const spec: SortSpec = {
    location: "m.facility_id", machine_id: "m.machine_id",
    status: "coalesce(s.down, false)", fault: "max(s.last_fault_at)",
    events: "count(e.event_id)", metric: g.metric, glitches: GLITCHES,
  };
  const sort = orderBy(spec, sp.sort, sp.dir, "location");

  const [top, k, rows] = await Promise.all([
    chrome(),
    one<{ units: string; codes: string; locations: string }>(
      `select count(*)::text                     as units,
              count(distinct machine_id)::text   as codes,
              count(distinct facility_id)::text  as locations
       from machines`),
    query<Row>(
      `with ${STATE}
       select m.facility_id, m.machine_id,
              count(e.event_id)::text as events,
              ${GLITCHES}::text       as glitches,
              ${g.metric}::text       as metric,
              to_char(max(s.last_fault_at), 'YYYY-MM-DD') as last_fault,
              coalesce(bool_or(s.down), false)            as down
       from machines m
            left join events e on e.facility_id = m.facility_id and e.machine_id = m.machine_id
            left join state s  on s.facility_id = m.facility_id and s.machine_id = m.machine_id
       where m.kind = $1
       group by m.facility_id, m.machine_id, s.down
       order by ${sort.sql} nulls last, m.facility_id, m.machine_id`, [g.kind]),
  ]);

  const cols: Column[] = [
    { key: "location", label: "Location" }, { key: "machine_id", label: "Machine" },
    { key: "status", label: "Status" },
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
            {num(k.locations)} locations, {num(k.units)} units in all; kind is read off the code prefix.
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
                  {rows.map((r) => (
                    <tr key={`${r.facility_id}/${r.machine_id}`}>
                      <td style={{ fontVariantNumeric: "tabular-nums" }}>{r.facility_id}</td>
                      <td style={{ fontVariantNumeric: "tabular-nums" }}>{r.machine_id}</td>
                      <td>
                        <span className="tag" style={{
                          background: r.down ? "#f7dcda" : "var(--color-accent-2-100)",
                          color: r.down ? "#7d2a22" : "var(--color-accent-2-800)",
                        }}>
                          {r.down ? "Non-operational" : "Operational"}
                        </span>
                      </td>
                      <td style={numeric}>{dash(r.last_fault)}</td>
                      <td style={numeric}>{num(r.events)}</td>
                      <td style={numeric}>{num(r.metric)}</td>
                      <td style={numeric}>{num(r.glitches)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
              Non-operational means the unit&rsquo;s last machine_fault block is still standing:
              no unblock on that job, and no job started on that unit since. Glitches are sensor
              noise, counted but not a stoppage.
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
