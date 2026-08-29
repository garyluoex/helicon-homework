import Header from "@/app/_components/header";
import { chrome } from "@/lib/chrome";
import { one, query } from "@/lib/db";
import { customerLabel, money, num } from "@/lib/format";
import ClickRow from "@/lib/row";
import { orderBy, sortHref, Th, type Column, type SortSpec } from "@/lib/table";

export const dynamic = "force-dynamic";

// Revenue only exists where the feed supplied a price, which is 150 of 312
// jobs. Every total built from it understates the book, and the footnote says so.
const REVENUE = "coalesce(sum(unit_price_estimate * coalesce(good_quantity, target_quantity)), 0)";
const ON_TIME_RATE =
  "count(*) filter (where completed_at <= target_due_at)::numeric / nullif(count(*) filter (where completed_at is not null), 0)";

type Row = {
  customer_id: string; jobs: string; open_jobs: string; ordered: string;
  good: string; done: string; on_time: string; revenue: string;
};

export default async function CustomersPage({
  searchParams,
}: { searchParams: Promise<{ sort?: string; dir?: string }> }) {
  const sp = await searchParams;
  const spec: SortSpec = {
    label: "customer_id", jobs: "count(*)",
    open_jobs: "count(*) filter (where status <> 'completed')",
    ordered: "sum(target_quantity)", good: "coalesce(sum(good_quantity), 0)",
    onTime: ON_TIME_RATE, revenue: REVENUE,
  };
  const sort = orderBy(spec, sp.sort, sp.dir, "revenue", "desc");

  const [top, k, rows] = await Promise.all([
    chrome(),
    one<Record<string, string>>(
      `select count(distinct customer_id)::text                              as customers,
              count(distinct customer_id) filter
                (where status <> 'completed')::text                          as customers_open,
              count(*)::text                                                 as jobs,
              count(*) filter (where status <> 'completed')::text            as open_jobs,
              sum(target_quantity)::text                                     as ordered,
              coalesce(sum(good_quantity), 0)::text                          as good,
              count(*) filter (where completed_at is not null)::text         as done,
              count(*) filter (where completed_at <= target_due_at)::text    as on_time,
              count(*) filter (where unit_price_estimate is not null)::text  as priced,
              round(${REVENUE})::text                                        as revenue,
              (select count(*) from (select customer_id from jobs
                 group by 1 having count(distinct facility_id) = 2) x)::text as both_sites
       from jobs`),
    query<Row>(
      `select customer_id, count(*)::text as jobs,
              count(*) filter (where status <> 'completed')::text as open_jobs,
              sum(target_quantity)::text as ordered,
              coalesce(sum(good_quantity), 0)::text as good,
              count(*) filter (where completed_at is not null)::text as done,
              count(*) filter (where completed_at <= target_due_at)::text as on_time,
              round(${REVENUE})::text as revenue
       from jobs group by customer_id
       order by ${sort.sql} nulls last, customer_id`),
  ]);

  const onTimePct = (onTime: string, done: string) =>
    Number(done) ? Math.round((Number(onTime) / Number(done)) * 100) + "%" : "—";

  const kpis = [
    { label: "Customers", value: num(k.customers), note: `${num(k.customers_open)} with work open` },
    { label: "Jobs booked", value: num(k.jobs), note: `${num(k.open_jobs)} still open` },
    { label: "Units ordered", value: num(k.ordered), note: "across the window" },
    { label: "Good delivered", value: num(k.good), note: `${num(k.done)} completed jobs` },
    { label: "On time", value: onTimePct(k.on_time, k.done), note: "against target date" },
    { label: "Est. revenue", value: money(k.revenue), note: `price on ${num(k.priced)} of ${num(k.jobs)} jobs` },
  ];

  const cols: Column[] = [
    { key: "label", label: "Customer" }, { key: "jobs", label: "Jobs", num: true },
    { key: "open_jobs", label: "Open", num: true }, { key: "ordered", label: "Units ordered", num: true },
    { key: "good", label: "Good delivered", num: true }, { key: "onTime", label: "On time", num: true },
    { key: "revenue", label: "Est. revenue", num: true },
  ];
  const href = sortHref({}, sort.key, sort.dir);
  const numeric = { textAlign: "right" as const, fontVariantNumeric: "tabular-nums" };
  const muted = { fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" };

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <Header current="customers" feedEnd={top.feed_end} userName={top.user_name} />
      <main style={{ flex: 1, padding: "32px 28px 72px", maxWidth: 1560, width: "100%", margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 16, marginBottom: 24 }}>
          <h2 style={{ margin: 0 }}>Customers</h2>
          <span style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
            {num(k.customers)} accounts, {num(k.both_sites)} of them placing work at both sites
          </span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))", gap: 20, marginBottom: 28 }}>
          {kpis.map((c) => (
            <div key={c.label} className="card" style={{ padding: "var(--space-6)", gap: 4 }}>
              <div className="card-kicker">{c.label}</div>
              <div style={{ fontFamily: "var(--font-heading)", fontSize: 32, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>{c.value}</div>
              <div style={muted}>{c.note}</div>
            </div>
          ))}
        </div>

        <section className="card" style={{ padding: "var(--space-6)", gap: "var(--space-4)" }}>
          <table className="table">
            <thead>
              <tr>{cols.map((c) => <Th key={c.key} col={c} active={c.key === sort.key} dir={sort.dir} href={href} />)}</tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <ClickRow key={r.customer_id} href={`/customers/${r.customer_id}`}>
                  <td><a href={`/customers/${r.customer_id}`}>{customerLabel(r.customer_id)}</a></td>
                  <td style={numeric}>{num(r.jobs)}</td>
                  <td style={numeric}>{num(r.open_jobs)}</td>
                  <td style={numeric}>{num(r.ordered)}</td>
                  <td style={numeric}>{num(r.good)}</td>
                  <td style={numeric}>{onTimePct(r.on_time, r.done)}</td>
                  <td style={numeric}>{money(r.revenue)}</td>
                </ClickRow>
              ))}
            </tbody>
          </table>
          <div style={muted}>
            Revenue is estimated from unit_price_estimate, which the feed supplies on {num(k.priced)} of {num(k.jobs)} jobs. Totals understate the book.
          </div>
        </section>
      </main>
    </div>
  );
}
