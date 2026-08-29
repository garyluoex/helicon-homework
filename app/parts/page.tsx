import Header from "@/app/_components/header";
import { chrome } from "@/lib/chrome";
import { one, query } from "@/lib/db";
import { num } from "@/lib/format";
import ClickRow from "@/lib/row";
import { orderBy, sortHref, Th, type Column, type SortSpec } from "@/lib/table";

export const dynamic = "force-dynamic";

// Cycle gap is wall clock between consecutive cycles on one job, so it is the
// job's run span divided by its cycle count. The part's figure is the median
// across its jobs.
const GAP_SECONDS =
  "extract(epoch from (j.last_cycle_at - j.first_cycle_at)) / nullif(j.cycle_count, 0)";
const SCRAP_RATE =
  "coalesce(sum(j.scrap_quantity), 0)::numeric / nullif(coalesce(sum(j.good_quantity), 0) + coalesce(sum(j.scrap_quantity), 0), 0)";
const MEDIAN_GAP = `percentile_disc(0.5) within group (order by ${GAP_SECONDS})`;

type Row = {
  part_id: string; material_id: string; jobs: string; customers: string;
  ordered: string; scrap_rate: string | null; median_gap_h: string | null;
};

export default async function PartsPage({
  searchParams,
}: { searchParams: Promise<{ sort?: string; dir?: string }> }) {
  const sp = await searchParams;
  const spec: SortSpec = {
    part_id: "p.part_id", material: "p.material_id", jobs: "count(j.job_id)",
    customers: "count(distinct j.customer_id)", ordered: "coalesce(sum(j.target_quantity), 0)",
    scrap: SCRAP_RATE, cycle: MEDIAN_GAP,
  };
  const sort = orderBy(spec, sp.sort, sp.dir, "ordered", "desc");

  const [top, k, rows] = await Promise.all([
    chrome(),
    one<{ parts: string; materials: string }>(
      "select count(*)::text as parts, count(distinct material_id)::text as materials from parts"),
    query<Row>(
      `select p.part_id, p.material_id,
              count(j.job_id)::text                    as jobs,
              count(distinct j.customer_id)::text      as customers,
              coalesce(sum(j.target_quantity), 0)::text as ordered,
              round(100 * ${SCRAP_RATE}, 1)::text      as scrap_rate,
              round((${MEDIAN_GAP} / 3600.0)::numeric, 1)::text as median_gap_h
       from parts p left join jobs j using (part_id)
       group by p.part_id, p.material_id
       order by ${sort.sql} nulls last, p.part_id`),
  ]);

  const cols: Column[] = [
    { key: "part_id", label: "Part" }, { key: "material", label: "Material" },
    { key: "jobs", label: "Jobs", num: true }, { key: "customers", label: "Customers", num: true },
    { key: "ordered", label: "Units ordered", num: true },
    { key: "scrap", label: "Scrap rate", num: true }, { key: "cycle", label: "Median cycle gap", num: true },
  ];
  const href = sortHref({}, sort.key, sort.dir);
  const numeric = { textAlign: "right" as const, fontVariantNumeric: "tabular-nums" };

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <Header current="parts" feedEnd={top.feed_end} userName={top.user_name} />
      <main style={{ flex: 1, padding: "32px 28px 72px", maxWidth: 1560, width: "100%", margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 16, marginBottom: 24 }}>
          <h2 style={{ margin: 0 }}>Parts</h2>
          <span style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
            {num(k.parts)} parts across {num(k.materials)} materials. A part states exactly one material in the feed.
          </span>
        </div>
        <section className="card" style={{ padding: "var(--space-6)", gap: "var(--space-4)" }}>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>{cols.map((c) => <Th key={c.key} col={c} active={c.key === sort.key} dir={sort.dir} href={href} />)}</tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <ClickRow key={r.part_id} href={`/parts/${r.part_id}`}>
                    <td style={{ fontVariantNumeric: "tabular-nums" }}><a href={`/parts/${r.part_id}`}>{r.part_id}</a></td>
                    <td>{r.material_id}</td>
                    <td style={numeric}>{num(r.jobs)}</td>
                    <td style={numeric}>{num(r.customers)}</td>
                    <td style={numeric}>{num(r.ordered)}</td>
                    <td style={numeric}>{r.scrap_rate === null ? "—" : r.scrap_rate + "%"}</td>
                    <td style={numeric}>{r.median_gap_h === null ? "—" : r.median_gap_h + " h"}</td>
                  </ClickRow>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
