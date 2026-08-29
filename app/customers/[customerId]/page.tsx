import { notFound } from "next/navigation";
import Header from "@/app/_components/header";
import { chrome } from "@/lib/chrome";
import { one, query } from "@/lib/db";
import { customerLabel, money, num, STATUS } from "@/lib/format";
import ClickRow from "@/lib/row";
import { orderBy, Th, type Column, type SortSpec } from "@/lib/table";

export const dynamic = "force-dynamic";

const REVENUE = "coalesce(sum(unit_price_estimate * coalesce(good_quantity, target_quantity)), 0)";

type PartRow = { part_id: string; material_id: string; jobs: string; units: string };
type JobRow = {
  job_id: string; part_id: string; status: string; target_quantity: string | null;
  good_quantity: string | null; due: string | null; late: boolean;
};

export default async function CustomerPage({
  params, searchParams,
}: {
  params: Promise<{ customerId: string }>;
  searchParams: Promise<{ psort?: string; pdir?: string; jsort?: string; jdir?: string }>;
}) {
  const { customerId } = await params;
  const sp = await searchParams;

  const partSpec: SortSpec = { part_id: "j.part_id", material: "max(p.material_id)", jobs: "count(*)", units: "sum(j.target_quantity)" };
  const jobSpec: SortSpec = {
    job_id: "job_id", part: "part_id", status: "status", target: "target_quantity",
    good: "good_quantity", due: "target_due_at", created: "created_event_at",
  };
  const partSort = orderBy(partSpec, sp.psort, sp.pdir, "units", "desc");
  const jobSort = orderBy(jobSpec, sp.jsort, sp.jdir, "created", "desc");

  const [top, stats, parts, jobs] = await Promise.all([
    chrome(),
    one<Record<string, string>>(
      `select count(*)::text                                              as jobs,
              count(*) filter (where status <> 'completed')::text         as open_jobs,
              sum(target_quantity)::text                                  as ordered,
              count(distinct part_id)::text                               as parts,
              coalesce(sum(good_quantity), 0)::text                       as good,
              count(*) filter (where completed_at is not null)::text      as done,
              count(*) filter (where completed_at <= target_due_at)::text as on_time,
              round(${REVENUE})::text                                     as revenue,
              (select round(100.0 * count(*) filter (where unit_price_estimate is not null)
                            / nullif(count(*), 0)) from jobs)::text       as priced_pct
       from jobs where customer_id = $1`, [customerId]),
    query<PartRow>(
      `select j.part_id, max(p.material_id) as material_id,
              count(*)::text as jobs, sum(j.target_quantity)::text as units
       from jobs j join parts p using (part_id) where j.customer_id = $1
       group by j.part_id order by ${partSort.sql} nulls last, j.part_id`, [customerId]),
    query<JobRow>(
      `select job_id, part_id, status, target_quantity::text, good_quantity::text,
              to_char(target_due_at, 'YYYY-MM-DD') as due,
              coalesce(completed_at > target_due_at,
                       target_due_at < (select max(occurred_at) from events)) as late
       from jobs where customer_id = $1
       order by ${jobSort.sql} nulls last, job_id`, [customerId]),
  ]);

  if (Number(stats.jobs) === 0) notFound();

  const kpis = [
    { label: "Jobs", value: num(stats.jobs), note: `${num(stats.open_jobs)} open` },
    { label: "Units ordered", value: num(stats.ordered), note: `across ${num(stats.parts)} parts` },
    { label: "Good delivered", value: num(stats.good), note: `${num(stats.done)} completed jobs` },
    { label: "On time", value: Number(stats.done) ? Math.round((Number(stats.on_time) / Number(stats.done)) * 100) + "%" : "—", note: "against target date" },
    { label: "Est. revenue", value: money(stats.revenue), note: `price on ${stats.priced_pct}% of jobs` },
  ];

  const partCols: Column[] = [
    { key: "part_id", label: "Part" }, { key: "material", label: "Material" },
    { key: "jobs", label: "Jobs", num: true }, { key: "units", label: "Units", num: true },
  ];
  const jobCols: Column[] = [
    { key: "job_id", label: "Job" }, { key: "part", label: "Part" }, { key: "status", label: "Status" },
    { key: "target", label: "Order", num: true }, { key: "good", label: "Good", num: true },
    { key: "due", label: "Due", num: true },
  ];
  const base = { psort: sp.psort, pdir: sp.pdir, jsort: sp.jsort, jdir: sp.jdir };
  // Two tables on one page, so each carries its own pair of params and leaves
  // the other's alone. Direction follows the same rule as sortHref.
  const nextDir = (same: boolean, dir: string, num?: boolean) =>
    same ? (dir === "asc" ? "desc" : "asc") : num ? "desc" : "asc";
  const partHref = (key: string, num?: boolean) => {
    const p = new URLSearchParams();
    if (base.jsort) p.set("jsort", base.jsort);
    if (base.jdir) p.set("jdir", base.jdir);
    p.set("psort", key);
    p.set("pdir", nextDir(key === partSort.key, partSort.dir, num));
    return "?" + p.toString();
  };
  const jobHref = (key: string, num?: boolean) => {
    const p = new URLSearchParams();
    if (base.psort) p.set("psort", base.psort);
    if (base.pdir) p.set("pdir", base.pdir);
    p.set("jsort", key);
    p.set("jdir", nextDir(key === jobSort.key, jobSort.dir, num));
    return "?" + p.toString();
  };
  const numeric = { textAlign: "right" as const, fontVariantNumeric: "tabular-nums" };
  const muted = { fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" };

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <Header current="customers" feedEnd={top.feed_end} userName={top.user_name} />
      <main style={{ flex: 1, padding: "32px 28px 72px", maxWidth: 1560, width: "100%", margin: "0 auto" }}>
        <a href="/customers" style={{ fontSize: 12, letterSpacing: ".1em", textTransform: "uppercase" }}>&larr; Customers</a>
        <h2 style={{ margin: "12px 0 26px" }}>{customerLabel(customerId)}</h2>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 20, marginBottom: 28 }}>
          {kpis.map((c) => (
            <div key={c.label} className="card" style={{ padding: "var(--space-6)", gap: 4 }}>
              <div className="card-kicker">{c.label}</div>
              <div style={{ fontFamily: "var(--font-heading)", fontSize: 32, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{c.value}</div>
              <div style={muted}>{c.note}</div>
            </div>
          ))}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr", gap: 28, alignItems: "start" }}>
          <section className="card" style={{ padding: "var(--space-6)", gap: "var(--space-4)" }}>
            <h4 style={{ margin: 0 }}>Parts built for this customer</h4>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>{partCols.map((c) => <Th key={c.key} col={c} active={c.key === partSort.key} dir={partSort.dir} href={partHref} />)}</tr>
                </thead>
                <tbody>
                  {parts.map((p) => (
                    <ClickRow key={p.part_id} href={`/parts/${p.part_id}`}>
                      <td><a href={`/parts/${p.part_id}`}>{p.part_id}</a></td>
                      <td style={{ fontSize: 12 }}>{p.material_id}</td>
                      <td style={numeric}>{num(p.jobs)}</td>
                      <td style={numeric}>{num(p.units)}</td>
                    </ClickRow>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card" style={{ padding: "var(--space-6)", gap: "var(--space-4)" }}>
            <h4 style={{ margin: 0 }}>Jobs</h4>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>{jobCols.map((c) => <Th key={c.key} col={c} active={c.key === jobSort.key} dir={jobSort.dir} href={jobHref} />)}</tr>
                </thead>
                <tbody>
                  {jobs.map((j) => {
                    const s = STATUS[j.status] ?? STATUS.created;
                    return (
                      <ClickRow key={j.job_id} href={`/jobs/${j.job_id}`}>
                        <td style={{ fontVariantNumeric: "tabular-nums" }}><a href={`/jobs/${j.job_id}`}>{j.job_id}</a></td>
                        <td style={{ fontVariantNumeric: "tabular-nums" }}><a href={`/parts/${j.part_id}`}>{j.part_id}</a></td>
                        <td><span className="tag" style={{ background: s.bg, color: s.ink }}>{s.label}</span></td>
                        <td style={numeric}>{num(j.target_quantity)}</td>
                        <td style={numeric}>{num(j.good_quantity)}</td>
                        <td style={{ ...numeric, color: j.late && j.status !== "completed" ? "var(--color-accent-800)" : "inherit" }}>{j.due ?? "—"}</td>
                      </ClickRow>
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
