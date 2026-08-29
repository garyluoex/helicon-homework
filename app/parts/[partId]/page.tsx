import { notFound } from "next/navigation";
import Header from "@/app/_components/header";
import { chrome } from "@/lib/chrome";
import { one, query } from "@/lib/db";
import { customerLabel, num, STATUS } from "@/lib/format";
import ClickRow from "@/lib/row";
import { orderBy, sortHref, Th, type Column, type SortSpec } from "@/lib/table";

export const dynamic = "force-dynamic";

const GAP_SECONDS = "extract(epoch from (last_cycle_at - first_cycle_at)) / nullif(cycle_count, 0)";

type Stats = {
  material_id: string; jobs: string; customers: string; ordered: string;
  good: string; scrap: string; scrap_rate: string | null;
  median_gap_h: string | null; fail_units: string;
};
type JobRow = {
  job_id: string; customer_id: string; status: string; facility_id: string;
  target_quantity: string | null; cycle_units: string;
  pass_units: string; fail_units: string; due: string | null; late: boolean;
};

export default async function PartPage({
  params, searchParams,
}: {
  params: Promise<{ partId: string }>;
  searchParams: Promise<{ sort?: string; dir?: string }>;
}) {
  const { partId } = await params;
  const sp = await searchParams;

  const spec: SortSpec = {
    job_id: "j.job_id", customer: "j.customer_id", status: "j.status", facility: "j.facility_id",
    target: "j.target_quantity", cycles: "j.cycle_units", pass: "j.inspection_pass_units",
    due: "j.target_due_at", created: "j.created_event_at",
  };
  const sort = orderBy(spec, sp.sort, sp.dir, "created", "desc");

  const stats = await one<Stats>(
    `select p.material_id,
            count(j.job_id)::text                       as jobs,
            count(distinct j.customer_id)::text         as customers,
            coalesce(sum(j.target_quantity), 0)::text   as ordered,
            coalesce(sum(j.good_quantity), 0)::text     as good,
            coalesce(sum(j.scrap_quantity), 0)::text    as scrap,
            round(100 * coalesce(sum(j.scrap_quantity), 0)::numeric
                  / nullif(coalesce(sum(j.good_quantity), 0) + coalesce(sum(j.scrap_quantity), 0), 0), 1)::text as scrap_rate,
            round((percentile_disc(0.5) within group
                   (order by extract(epoch from (j.last_cycle_at - j.first_cycle_at)) / nullif(j.cycle_count, 0))
                   / 3600.0)::numeric, 1)::text          as median_gap_h,
            coalesce(sum(j.inspection_fail_units), 0)::text as fail_units
     from parts p left join jobs j using (part_id)
     where p.part_id = $1 group by p.material_id`, [partId]);
  if (!stats) notFound();

  const [top, defects, jobs] = await Promise.all([
    chrome(),
    query<{ code: string; units: string }>(
      `select e.metadata ->> 'defect_code' as code, sum(e.quantity)::text as units
       from events e where e.part_id = $1 and e.event_type = 'inspection_failed'
       group by 1 order by sum(e.quantity) desc`, [partId]),
    query<JobRow>(
      `select j.job_id, j.customer_id, j.status, j.facility_id,
              j.target_quantity::text, j.cycle_units::text,
              j.inspection_pass_units::text as pass_units,
              j.inspection_fail_units::text as fail_units,
              to_char(j.target_due_at, 'YYYY-MM-DD') as due,
              coalesce(j.completed_at > j.target_due_at,
                       j.target_due_at < (select max(occurred_at) from events)) as late
       from jobs j where j.part_id = $1
       order by ${sort.sql} nulls last, j.job_id`, [partId]),
  ]);

  const kpis = [
    { label: "Jobs", value: num(stats.jobs), note: `${num(stats.customers)} customers` },
    { label: "Units ordered", value: num(stats.ordered), note: "across the window" },
    { label: "Good delivered", value: num(stats.good), note: `${num(stats.scrap)} scrapped` },
    { label: "Scrap rate", value: stats.scrap_rate === null ? "—" : stats.scrap_rate + "%", note: "scrap against good + scrap" },
    { label: "Median cycle gap", value: stats.median_gap_h === null ? "—" : stats.median_gap_h + " h", note: "wall clock between consecutive cycles" },
  ];

  const cols: Column[] = [
    { key: "job_id", label: "Job" }, { key: "customer", label: "Customer" },
    { key: "status", label: "Status" }, { key: "facility", label: "Facility" },
    { key: "target", label: "Order", num: true }, { key: "cycles", label: "Pressed", num: true },
    { key: "pass", label: "Pass / fail", num: true }, { key: "due", label: "Due", num: true },
  ];
  const href = sortHref({}, sort.key, sort.dir);
  const maxDefect = Math.max(...defects.map((d) => Number(d.units)), 1);
  const numeric = { textAlign: "right" as const, fontVariantNumeric: "tabular-nums" };
  const muted = { fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" };

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <Header current="parts" feedEnd={top.feed_end} userName={top.user_name} />
      <main style={{ flex: 1, padding: "32px 28px 72px", maxWidth: 1560, width: "100%", margin: "0 auto" }}>
        <a href="/parts" style={{ fontSize: 12, letterSpacing: ".1em", textTransform: "uppercase" }}>&larr; Parts</a>
        <div style={{ margin: "12px 0 26px" }}>
          <div className="card-kicker">{stats.material_id}</div>
          <h2 style={{ margin: 0, fontVariantNumeric: "tabular-nums" }}>{partId}</h2>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 20, marginBottom: 28 }}>
          {kpis.map((c) => (
            <div key={c.label} className="card" style={{ padding: "var(--space-6)", gap: 4 }}>
              <div className="card-kicker">{c.label}</div>
              <div style={{ fontFamily: "var(--font-heading)", fontSize: 32, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{c.value}</div>
              <div style={muted}>{c.note}</div>
            </div>
          ))}
        </div>

        <section className="card" style={{ padding: "var(--space-6)", gap: "var(--space-4)", marginBottom: 28 }}>
          <h4 style={{ margin: 0 }}>Defects on this part</h4>
          {defects.length > 0 && (
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
          )}
          <div style={muted}>
            {defects.length
              ? `${num(stats.fail_units)} units rejected across ${num(stats.jobs)} jobs.`
              : "No inspection failures recorded for this part."}
          </div>
        </section>

        <section className="card" style={{ padding: "var(--space-6)", gap: "var(--space-4)" }}>
          <h4 style={{ margin: 0 }}>Jobs for this part</h4>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>{cols.map((c) => <Th key={c.key} col={c} active={c.key === sort.key} dir={sort.dir} href={href} />)}</tr>
              </thead>
              <tbody>
                {jobs.map((j) => {
                  const s = STATUS[j.status] ?? STATUS.created;
                  return (
                    <ClickRow key={j.job_id} href={`/jobs/${j.job_id}`}>
                      <td style={{ fontVariantNumeric: "tabular-nums" }}><a href={`/jobs/${j.job_id}`}>{j.job_id}</a></td>
                      <td><a href={`/customers/${j.customer_id}`}>{customerLabel(j.customer_id)}</a></td>
                      <td><span className="tag" style={{ background: s.bg, color: s.ink }}>{s.label}</span></td>
                      <td style={{ fontVariantNumeric: "tabular-nums" }}>{j.facility_id}</td>
                      <td style={numeric}>{num(j.target_quantity)}</td>
                      <td style={numeric}>{num(j.cycle_units)}</td>
                      <td style={numeric}>{num(j.pass_units)} / {num(j.fail_units)}</td>
                      <td style={{ ...numeric, color: j.late && j.status !== "completed" ? "var(--color-accent-800)" : "inherit" }}>{j.due ?? "—"}</td>
                    </ClickRow>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
