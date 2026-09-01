import { notFound } from "next/navigation";
import Header from "@/app/_components/header";
import { chrome } from "@/lib/chrome";
import { one, query } from "@/lib/db";
import { customerLabel, MACHINE_STATE, num, STATUS } from "@/lib/format";

export const dynamic = "force-dynamic";

// One physical unit: a machine code under a location, which is how the registry
// keys them. Its state is read from machine_state, the same view the Equipment
// list and Home read, so the badge here cannot disagree with the badge on the
// row that was clicked to get here.
const KIND = {
  press: { label: "Press", tab: "presses" },
  qc: { label: "Inspection station", tab: "qc" },
  tooling: { label: "Tooling cell", tab: "tooling" },
} as const;

type Kind = keyof typeof KIND;
type Unit = {
  kind: Kind; state: string; glitches: string; events: string; jobs: string;
  last_fault: string | null; last_fault_job_id: string | null;
  last_job_id: string | null; last_job_at: string | null; signal: string | null;
};
type Run = {
  job_id: string; customer_id: string; part_id: string; material_id: string;
  status: string; when_at: string; glitches: string; signals: string | null;
  target_quantity: string | null; cycle_units: string; cycle_count: string;
  pass_units: string; fail_units: string;
  blocks: string; unblocks: string; due: string | null; overdue: boolean;
};

const RUNS_SHOWN = 10;
const FAIL_RATE_FLAGGED = 0.15;   // the share of judged units that reads as a bad run

const INK_BAD = "#7d2a22";
const TONES = {
  blocked: { bg: "#fbeceb", rule: "#c0655c" },
  warned: { bg: "#fdf3e6", rule: "#d08a3a" },
  done: { bg: "#eef6f1", rule: "#4f9970" },
  plain: { bg: "var(--color-neutral-100)", rule: "var(--color-neutral-400)" },
};

export default async function MachinePage({
  params,
}: { params: Promise<{ facilityId: string; machineId: string }> }) {
  const { facilityId, machineId } = await params;

  // The unit itself: its kind and its state from the view, its size from the
  // events this code reported at this location.
  const unit = await one<Unit>(
    `select s.kind::text as kind, s.state, s.glitches::text as glitches,
            to_char(s.last_fault_at, 'YYYY-MM-DD') as last_fault,
            s.last_fault_job_id, s.last_job_id,
            to_char(s.last_job_at, 'YYYY-MM-DD') as last_job_at,
            s.last_job_signals as signal,
            (select count(*) from events e
              where e.facility_id = s.facility_id
                and e.machine_id = s.machine_id)::text as events,
            (select count(distinct e.job_id) from events e
              where e.facility_id = s.facility_id
                and e.machine_id = s.machine_id)::text as jobs
     from machine_state s
     where s.facility_id = $1 and s.machine_id = $2`, [facilityId, machineId]);
  if (!unit) notFound();

  const [top, runs] = await Promise.all([
    chrome(),
    // The most recent runs, newest first. A run is one job's work on this unit,
    // dated by the last event the unit reported for it, so a job that came back
    // to the same press sorts by its latest visit.
    //
    // Glitches carry the view's own attribution rule rather than the raw stamp:
    // half the sensor glitches in the feed name no machine, and those fall back
    // to the press their job started on. Applying the same rule here is what
    // keeps a glitch flagged on a run one of the ones the unit's Glitches figure
    // counts -- every glitch that figure counts sits on a job in this list, though
    // only the last ten of them are shown.
    query<Run>(
      `with feed as (select max(occurred_at) as hi from events),
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
       select j.job_id, j.customer_id, j.part_id, j.material_id, j.status::text,
              to_char(v.last_on_unit, 'YYYY-MM-DD') as when_at,
              coalesce(g.glitches, 0)::text as glitches,
              g.signals,
              j.target_quantity::text, j.cycle_units::text, j.cycle_count::text,
              j.inspection_pass_units::text as pass_units,
              j.inspection_fail_units::text as fail_units,
              (select count(*) from events b
               where b.job_id = j.job_id and b.event_type = 'job_blocked')::text   as blocks,
              (select count(*) from events b
               where b.job_id = j.job_id and b.event_type = 'job_unblocked')::text as unblocks,
              to_char(j.target_due_at, 'YYYY-MM-DD') as due,
              (j.status <> 'completed' and j.target_due_at < feed.hi) as overdue
       from visit v
            join jobs j using (job_id)
            left join glitch g on g.facility_id = $1 and g.machine_id = $2
                              and g.job_id = v.job_id
            cross join feed
       order by v.last_on_unit desc, j.job_id desc
       limit ${RUNS_SHOWN}`, [facilityId, machineId]),
  ]);

  const kind = KIND[unit.kind] ?? KIND.press;
  const state = MACHINE_STATE[unit.state] ?? MACHINE_STATE.operational;

  // Why the badge reads the way it does, in the view's own terms. The date is
  // the assignment's, not the last event's: a unit can still be finishing the
  // job it was assigned days earlier, so this line and the newest run below are
  // answering two different questions.
  const why =
    unit.state === "non_operational"
      ? `Stopped since ${unit.last_fault}: the machine fault raised on ${unit.last_fault_job_id} still stands, and the unit has been assigned no job since.`
      : unit.state === "degraded"
      ? `Running, but the job it was last assigned, ${unit.last_job_id}, reported a ${unit.signal} glitch.`
      : unit.last_job_id
      ? `Running. Last assigned to ${unit.last_job_id} on ${unit.last_job_at}.`
      : "This unit has never been assigned a job in the feed.";

  const shown = runs.map((r) => {
    const openBlocks = Number(r.blocks) - Number(r.unblocks);
    const glitches = Number(r.glitches);
    const judged = Number(r.pass_units) + Number(r.fail_units);
    const failing = judged > 0 && Number(r.fail_units) / judged > FAIL_RATE_FLAGGED;
    const tone = r.status === "blocked" || openBlocks > 0 ? TONES.blocked
      : glitches || failing ? TONES.warned
      : r.status === "completed" ? TONES.done
      : TONES.plain;

    const flags: { label: string; bg: string; ink: string }[] = [];
    if (openBlocks > 0) {
      flags.push({ label: `${openBlocks} open block${openBlocks > 1 ? "s" : ""}`, bg: "#f7dcda", ink: INK_BAD });
    }
    if (glitches) {
      const signal = r.signals ? ` (${r.signals})` : "";
      flags.push({ label: `${glitches} sensor glitch${glitches > 1 ? "es" : ""}${signal}`, bg: "#fbe6cd", ink: "#7d4f14" });
    }
    if (!flags.length) {
      flags.push({ label: "No blocks or glitches", bg: "var(--color-neutral-200)", ink: "var(--color-neutral-700)" });
    }

    return {
      ...r, tone, flags, openBlocks, glitches,
      stopped: r.status === "blocked" || openBlocks > 0,
      status: STATUS[r.status] ?? STATUS.created,
      subtitle: `${customerLabel(r.customer_id)} · ${r.part_id} · ${r.material_id}`,
      fields: [
        { k: "order", v: `${num(r.target_quantity)} u`, ink: "inherit" },
        { k: "pressed", v: `${num(r.cycle_units)} u in ${num(r.cycle_count)} cycles`, ink: "inherit" },
        { k: "pass / fail", v: `${num(r.pass_units)} / ${num(r.fail_units)}`, ink: failing ? INK_BAD : "inherit" },
        { k: "blocks", v: Number(r.blocks) ? `${r.blocks} raised, ${r.unblocks} cleared` : "none", ink: openBlocks > 0 ? INK_BAD : "inherit" },
        { k: "due", v: r.due ?? "—", ink: r.overdue ? INK_BAD : "inherit" },
      ],
    };
  });

  const blockedShown = shown.filter((r) => r.stopped).length;
  const glitchesShown = shown.reduce((a, r) => a + r.glitches, 0);
  const note = shown.length
    ? `Newest first · ${shown.length} of ${num(unit.jobs)} jobs on this unit · shown here: ` +
      `${blockedShown} blocked, ${glitchesShown} sensor glitch${glitchesShown === 1 ? "" : "es"}`
    : "No jobs in the window";

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
      <Header current="equipment" feedEnd={top.feed_end} userName={top.user_name} />
      <main style={{ flex: 1, padding: "32px 28px 72px", maxWidth: 1560, width: "100%", margin: "0 auto" }}>
        <a href={`/equipment?tab=${kind.tab}`} style={{ fontSize: 12, letterSpacing: ".1em", textTransform: "uppercase" }}>&larr; Equipment</a>

        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 24, margin: "12px 0 8px", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 320px", minWidth: 0 }}>
            <div className="card-kicker" style={{ lineHeight: 1.5 }}>{kind.label} &middot; primary key: location + machine</div>
            <h2 style={{ margin: 0, fontVariantNumeric: "tabular-nums" }}>{facilityId} &middot; {machineId}</h2>
          </div>
          <div style={{ display: "flex", gap: 28, alignItems: "flex-end", flexWrap: "wrap" }}>
            {chip("Status", state.label, state.bg, state.ink)}
            {chip("Location", facilityId)}
            {chip("Machine", machineId)}
            {chip("Events", num(unit.events))}
            {chip("Glitches", num(unit.glitches))}
          </div>
        </div>
        <div style={{ ...muted, marginBottom: 26 }}>{why}</div>

        <section className="card" style={{ padding: "var(--space-6)", gap: "var(--space-4)" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
            <h4 style={{ margin: 0 }}>Last {RUNS_SHOWN} jobs on this unit</h4>
            <span style={muted}>{note}</span>
          </div>

          {shown.length === 0 ? (
            <div style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>
              No jobs reported on this unit inside the window.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {shown.map((r) => (
                <a key={r.job_id} href={`/jobs/${r.job_id}`}
                   style={{ display: "grid", gridTemplateColumns: "112px 1fr", gap: 14, padding: "10px 12px",
                            background: r.tone.bg, borderLeft: `3px solid ${r.tone.rule}`,
                            alignItems: "baseline", color: "inherit" }}>
                  <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>{r.when_at}</span>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
                    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 10 }}>
                      <span style={{ fontVariantNumeric: "tabular-nums", fontFamily: "var(--font-heading)", fontSize: 16, color: "var(--color-accent-700)" }}>{r.job_id}</span>
                      <span className="tag" style={{ background: r.status.bg, color: r.status.ink }}>{r.status.label}</span>
                      {r.flags.map((f) => (
                        <span key={f.label} className="tag" style={{ background: f.bg, color: f.ink }}>{f.label}</span>
                      ))}
                      <span style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 60%, transparent)" }}>{r.subtitle}</span>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 18px" }}>
                      {r.fields.map((f) => (
                        <span key={f.k} style={{ display: "flex", gap: 6, alignItems: "baseline", fontSize: 12 }}>
                          <span style={{ letterSpacing: ".06em", textTransform: "uppercase", fontSize: 10, color: "color-mix(in srgb, var(--color-text) 50%, transparent)" }}>{f.k}</span>
                          <span style={{ fontVariantNumeric: "tabular-nums", color: f.ink }}>{f.v}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                </a>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
