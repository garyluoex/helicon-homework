import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import Header from "@/app/_components/header";
import { one, query } from "@/lib/db";
import { COOKIE_NAME, verify } from "@/lib/session";
import { customerLabel, dur, hoursBetween, money, num, PRIORITY, STATUS } from "@/lib/format";

export const dynamic = "force-dynamic";

type Job = {
  job_id: string; customer_id: string; part_id: string; material_id: string;
  facility_id: string; status: string; priority: string;
  target_quantity: string | null; unit_price_estimate: string | null;
  good_quantity: string | null; scrap_quantity: string | null;
  machine_id: string | null; tool_id: string | null; operator_id: string | null;
  cycle_count: string; cycle_units: string;
  inspection_pass_units: string; inspection_fail_units: string; event_count: string;
  created_event_at: string | null; tool_ready_at: string | null; started_at: string | null;
  first_cycle_at: string | null; last_cycle_at: string | null;
  first_inspection_at: string | null; last_inspection_at: string | null;
  completed_at: string | null; last_event_at: string | null;
  due_at: string | null;
};
type Facets = {
  qc_station: string | null; tooling_cell: string | null;
  inspectors: string | null; blocks: string; unblocks: string; feed_end: string;
};
type Event = { when_at: string; event_type: string; machine_id: string | null; quantity: string | null; metadata: Record<string, string> };

const PHASES: [string, keyof Job, keyof Job, "wait" | "run" | "qc"][] = [
  ["Tooling", "created_event_at", "tool_ready_at", "wait"],
  ["Press queue", "tool_ready_at", "started_at", "wait"],
  ["Setup", "started_at", "first_cycle_at", "wait"],
  ["Pressing", "first_cycle_at", "last_cycle_at", "run"],
  ["QC queue", "last_cycle_at", "first_inspection_at", "wait"],
  ["Inspection", "first_inspection_at", "last_inspection_at", "qc"],
  ["Closeout", "last_inspection_at", "completed_at", "wait"],
];
const FILLS = { wait: "var(--color-neutral-300)", run: "var(--color-accent)", qc: "var(--color-accent-300)" };

const EVENT_INK: Record<string, string> = {
  job_created: "var(--color-accent-700)", job_completed: "#26603f",
  job_blocked: "#7d2a22", job_hold: "#7d4f14", inspection_failed: "#7d2a22",
};

export default async function JobPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;

  const job = await one<Job>(
    `select job_id, customer_id, part_id, material_id, facility_id, status, priority,
            target_quantity::text, unit_price_estimate::text,
            good_quantity::text, scrap_quantity::text,
            machine_id, tool_id, operator_id,
            cycle_count::text, cycle_units::text,
            inspection_pass_units::text, inspection_fail_units::text, event_count::text,
            created_event_at::text, tool_ready_at::text, started_at::text,
            first_cycle_at::text, last_cycle_at::text,
            first_inspection_at::text, last_inspection_at::text,
            completed_at::text, last_event_at::text, target_due_at::text as due_at
     from jobs where job_id = $1`, [jobId]);
  if (!job) notFound();

  const [userRow, facets, timeline, defects] = await Promise.all([
    one<{ display_name: string | null; email: string }>(
      "select display_name, email from users where user_id = $1",
      [await verify((await cookies()).get(COOKIE_NAME)?.value)]),

    one<Facets>(
      `select (select machine_id from events
               where job_id = $1 and machine_id like 'qc%' limit 1)      as qc_station,
              (select machine_id from events
               where job_id = $1 and event_type = 'tool_ready' limit 1)  as tooling_cell,
              (select string_agg(distinct metadata ->> 'inspector_id', ', ')
               from events where job_id = $1
                 and metadata ->> 'inspector_id' is not null)            as inspectors,
              (select count(*) from events
               where job_id = $1 and event_type = 'job_blocked')::text    as blocks,
              (select count(*) from events
               where job_id = $1 and event_type = 'job_unblocked')::text  as unblocks,
              to_char((select max(occurred_at) from events), 'YYYY-MM-DD') as feed_end`, [jobId]),

    query<Event>(
      `select to_char(occurred_at, 'YYYY-MM-DD HH24:MI') as when_at,
              event_type, machine_id, quantity::text, metadata
       from events where job_id = $1 order by occurred_at, event_id`, [jobId]),

    query<{ code: string; units: string }>(
      `select metadata ->> 'defect_code' as code, sum(quantity)::text as units
       from events where job_id = $1 and event_type = 'inspection_failed'
       group by 1 order by sum(quantity) desc`, [jobId]),
  ]);

  const n = (k: keyof Job) => Number(job[k] ?? 0);
  const status = STATUS[job.status] ?? STATUS.created;
  const priority = PRIORITY[job.priority] ?? PRIORITY.normal;
  const target = n("target_quantity");
  const inspected = n("inspection_pass_units") + n("inspection_fail_units");
  const completed = job.good_quantity !== null;

  const leadHours = completed
    ? hoursBetween(job.created_event_at, job.completed_at)
    : hoursBetween(job.created_event_at, job.last_event_at);
  const vsDueDays =
    (Date.parse((completed ? job.completed_at : `${facets.feed_end}T23:59:59Z`) ?? "") - Date.parse(job.due_at ?? "")) / 86400000;

  const kpis = [
    { label: "Lead time", value: dur(leadHours), note: completed ? "created to completion" : "created to last event, still open" },
    { label: "Tool wait", value: dur(hoursBetween(job.created_event_at, job.tool_ready_at)), note: "created to tool_ready" },
    { label: "Press queue", value: dur(hoursBetween(job.tool_ready_at, job.started_at)), note: "tool_ready to job_started" },
    { label: "Run span", value: dur(hoursBetween(job.first_cycle_at, job.last_cycle_at)), note: `${num(job.cycle_count)} cycles, first to last` },
    { label: "Yield", value: completed ? ((n("good_quantity") / (n("good_quantity") + n("scrap_quantity"))) * 100).toFixed(1) + "%" : "—",
      note: completed ? `${num(job.good_quantity)} good, ${num(job.scrap_quantity)} scrap` : "no completion event" },
    { label: "Vs. due date", value: (vsDueDays > 0 ? "+" : "") + vsDueDays.toFixed(1) + " d",
      note: completed ? (vsDueDays > 0 ? "late" : "early") : (vsDueDays > 0 ? "overdue, open" : "still inside the window") },
  ];

  const milestones: [string, string | null][] = [
    ["Created", job.created_event_at], ["Tool ready", job.tool_ready_at], ["Started", job.started_at],
    ["First cycle", job.first_cycle_at], ["Last cycle", job.last_cycle_at], ["Completed", job.completed_at],
  ];

  const segs = PHASES
    .map(([label, a, b, kind]) => ({ label, kind, h: hoursBetween(job[a] as string | null, job[b] as string | null) }))
    .filter((s): s is { label: string; kind: keyof typeof FILLS; h: number } => s.h !== null);
  const totalH = segs.reduce((a, s) => a + s.h, 0) || 1;

  const scale = Math.max(target, n("cycle_units")) || 1;
  const pct = (v: number) => ((v / scale) * 100).toFixed(2);
  const extra = Math.max(0, n("cycle_units") - target);

  const facts: [string, string][] = [
    ["Customer", job.customer_id], ["Part", job.part_id], ["Material", job.material_id],
    ["Tool", job.tool_id ?? "not assigned"], ["Operator", job.operator_id ?? "not assigned"],
    ["Unit price estimate", job.unit_price_estimate ? "$" + Number(job.unit_price_estimate).toFixed(2) : "not supplied"],
    ["Estimated value", job.unit_price_estimate ? money(Number(job.unit_price_estimate) * target) : "—"],
    ["Due", job.due_at?.slice(0, 16) ?? "—"],
    ["Blocks / unblocks", `${facets.blocks} / ${facets.unblocks}`],
    ["Last event", job.last_event_at?.slice(0, 16) ?? "—"],
    ["Inspectors", facets.inspectors ?? "none"],
  ];

  const maxDefect = Math.max(...defects.map((d) => Number(d.units)), 1);
  const kicker = { fontSize: 10, letterSpacing: ".1em", textTransform: "uppercase" as const, color: "color-mix(in srgb, var(--color-text) 50%, transparent)" };
  const muted = { fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" };

  const chip = (label: string, value: string, bg?: string, ink?: string) => (
    <div key={label} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={kicker}>{label}</span>
      <span className="tag" style={{ background: bg ?? "var(--color-neutral-100)", color: ink ?? "var(--color-neutral-800)", fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <Header current="jobs" feedEnd={facets.feed_end} userName={userRow?.display_name ?? userRow?.email ?? "Signed in"} />
      <main style={{ flex: 1, padding: "32px 28px 72px", maxWidth: 1560, width: "100%", margin: "0 auto" }}>
        <a href="/jobs" style={{ fontSize: 12, letterSpacing: ".1em", textTransform: "uppercase" }}>&larr; Jobs</a>

        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 24, margin: "12px 0 26px", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 320px", minWidth: 0 }}>
            <div className="card-kicker" style={{ lineHeight: 1.5 }}>
              {customerLabel(job.customer_id)} &middot; {job.part_id} &middot; {job.material_id}
            </div>
            <h2 style={{ margin: 0, fontVariantNumeric: "tabular-nums" }}>{job.job_id}</h2>
          </div>
          <div style={{ display: "flex", gap: 28, alignItems: "flex-end", flexWrap: "wrap" }}>
            {chip("Status", status.label, status.bg, status.ink)}
            {chip("Priority", priority.label, priority.bg, priority.ink)}
            {chip("Press", job.machine_id ?? "not assigned")}
            {chip("QC", facets.qc_station ?? "not inspected")}
            {chip("Tooling", facets.tooling_cell ?? "not prepared")}
            {chip("Facility", job.facility_id)}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 20, marginBottom: 28 }}>
          {kpis.map((k) => (
            <div key={k.label} className="card" style={{ padding: "var(--space-6)", gap: 4 }}>
              <div className="card-kicker">{k.label}</div>
              <div style={{ fontFamily: "var(--font-heading)", fontSize: 32, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{k.value}</div>
              <div style={muted}>{k.note}</div>
            </div>
          ))}
        </div>

        <section className="card" style={{ padding: "var(--space-6)", gap: "var(--space-6)", marginBottom: 28 }}>
          <h4 style={{ margin: 0 }}>Job lifecycle</h4>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${milestones.length},1fr)`, gap: 0 }}>
            {milestones.map(([label, at]) => {
              const rule = at ? "var(--color-accent)" : "var(--color-neutral-300)";
              return (
                <div key={label} style={{ borderTop: `2px solid ${rule}`, paddingTop: 12, paddingRight: 16 }}>
                  <div style={{ width: 9, height: 9, background: rule, margin: "-17px 0 12px" }} />
                  <div style={{ fontSize: 12, letterSpacing: ".08em", textTransform: "uppercase", color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>{label}</div>
                  <div style={{ fontSize: 14, fontVariantNumeric: "tabular-nums" }}>{at ? at.slice(0, 16) : "not reached"}</div>
                </div>
              );
            })}
          </div>
        </section>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(460px,1fr))", gap: 28, alignItems: "start" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
            <section className="card" style={{ padding: "var(--space-6)", gap: "var(--space-4)" }}>
              <h4 style={{ margin: 0 }}>Units</h4>
              <div style={{ position: "relative", height: 26, marginTop: 4 }}>
                <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${pct(target)}%`, background: "var(--color-neutral-300)" }} />
                <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${pct(n("inspection_pass_units"))}%`, background: "#4f9970" }} />
                <div style={{ position: "absolute", left: `${pct(n("inspection_pass_units"))}%`, top: 0, height: "100%", width: `${pct(n("inspection_fail_units"))}%`, background: "#c0655c" }} />
                {extra > 0 && (
                  <div title={`${num(extra)} pressed over order`} style={{ position: "absolute", top: 0, height: "100%", left: `${pct(target)}%`, width: `${pct(extra)}%`, border: "1px dashed color-mix(in srgb, var(--color-text) 45%, transparent)" }} />
                )}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px", fontSize: 12, color: "color-mix(in srgb, var(--color-text) 70%, transparent)" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 10, height: 10, background: "var(--color-neutral-300)", display: "block" }} />{num(target)} ordered</span>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 10, height: 10, background: "#4f9970", display: "block" }} />{num(job.inspection_pass_units)} passed</span>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 10, height: 10, background: "#c0655c", display: "block" }} />{num(job.inspection_fail_units)} failed</span>
                <span>{num(job.cycle_units)} pressed</span>
                {extra > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 10, height: 10, border: "1px dashed color-mix(in srgb, var(--color-text) 45%, transparent)", display: "block" }} />{num(extra)} pressed over order</span>
                )}
              </div>
            </section>

            <section className="card" style={{ padding: "var(--space-6)", gap: "var(--space-6)" }}>
              <h4 style={{ margin: 0 }}>Where the time went</h4>
              {segs.length === 0 ? (
                <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
                  No elapsed phases yet — the job is created and no later milestone has been reported.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", height: 20, gap: 1 }}>
                    {segs.map((s) => (
                      <div key={s.label} title={`${s.label} ${dur(s.h)}`} style={{ width: `${Math.max(1, Math.round((s.h / totalH) * 100))}%`, background: FILLS[s.kind] }} />
                    ))}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, fontVariantNumeric: "tabular-nums", color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
                    <span>{job.created_event_at?.slice(0, 16)}</span>
                    <span>{(job.completed_at ?? job.last_event_at)?.slice(0, 16)}</span>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px", fontSize: 12, color: "color-mix(in srgb, var(--color-text) 70%, transparent)" }}>
                    {segs.map((s) => (
                      <span key={s.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ width: 9, height: 9, background: FILLS[s.kind], display: "block" }} />
                        {s.label} {dur(s.h)} &middot; {Math.round((s.h / totalH) * 100)}%
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </section>

            <section className="card" style={{ padding: "var(--space-6)", gap: "var(--space-4)" }}>
              <h4 style={{ margin: 0 }}>Defects on this job</h4>
              {defects.length === 0 ? (
                <div style={muted}>No inspection failures recorded.</div>
              ) : (
                <>
                  <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                    {defects.map((d) => (
                      <div key={d.code} style={{ display: "grid", gridTemplateColumns: "130px 1fr 56px", alignItems: "center", gap: 12, fontSize: 13 }}>
                        <span>{d.code}</span>
                        <span style={{ height: 12, background: "var(--color-neutral-200)", display: "block" }}>
                          <span style={{ display: "block", height: "100%", width: `${Math.round((Number(d.units) / maxDefect) * 100)}%`, background: "var(--color-accent)" }} />
                        </span>
                        <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{num(d.units)}</span>
                      </div>
                    ))}
                  </div>
                  <div style={muted}>{num(job.inspection_fail_units)} units rejected across {defects.length} codes.</div>
                </>
              )}
            </section>

            <section className="card" style={{ padding: "var(--space-6)", gap: "var(--space-4)" }}>
              <h4 style={{ margin: 0 }}>Job details</h4>
              <table className="table">
                <tbody>
                  {facts.map(([label, value]) => (
                    <tr key={label}>
                      <td style={{ color: "color-mix(in srgb, var(--color-text) 60%, transparent)", width: "45%" }}>{label}</td>
                      <td style={{ fontVariantNumeric: "tabular-nums" }}>{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>

          <section className="card" style={{ padding: "var(--space-6)", gap: "var(--space-4)" }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
              <h4 style={{ margin: 0 }}>Event timeline</h4>
              <span style={muted}>{num(timeline.length)} events &middot; the whole ledger for this job</span>
            </div>
            <div style={{ maxHeight: 680, overflow: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
              {timeline.map((e, i) => {
                const fields: [string, string][] = [];
                if (e.quantity && e.quantity !== "0") fields.push(["qty", e.quantity]);
                if (e.machine_id) fields.push(["machine", e.machine_id]);
                for (const [k, v] of Object.entries(e.metadata ?? {})) {
                  if (k !== "facility" && v !== null) fields.push([k.replace(/_/g, " "), String(v)]);
                }
                return (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: "132px 1fr", gap: 14, padding: "8px 10px", background: i % 2 ? "transparent" : "color-mix(in srgb, var(--color-text) 3%, transparent)", fontSize: 13, alignItems: "baseline" }}>
                    <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>{e.when_at}</span>
                    <div style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0 }}>
                      <span style={{ color: EVENT_INK[e.event_type] ?? "inherit", fontFamily: "var(--font-heading)", fontSize: 15, letterSpacing: ".02em" }}>{e.event_type}</span>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 18px" }}>
                        {fields.map(([k, v]) => (
                          <span key={k} style={{ display: "flex", gap: 6, alignItems: "baseline", fontSize: 12 }}>
                            <span style={{ letterSpacing: ".06em", textTransform: "uppercase", fontSize: 10, color: "color-mix(in srgb, var(--color-text) 50%, transparent)" }}>{k}</span>
                            <span style={{ fontVariantNumeric: "tabular-nums" }}>{v}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
