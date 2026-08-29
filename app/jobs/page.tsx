import Header from "@/app/_components/header";
import { chrome } from "@/lib/chrome";
import { one, query } from "@/lib/db";
import { customerLabel, num, PRIORITY } from "@/lib/format";
import ClickRow from "@/lib/row";
import { orderBy, sortHref, Th, type Column, type SortSpec } from "@/lib/table";

export const dynamic = "force-dynamic";

const TABS = {
  "in-progress": {
    label: "In progress", statuses: ["in_progress", "blocked", "on_hold"], dateDir: "asc",
    dateCol: "j.last_event_at", dateHead: "Last event",
    footnote: "A blocked job can keep cycling: status alone does not find them, blocks against unblocks does.",
  },
  pending: {
    label: "Pending", statuses: ["created", "tooling_ready"], dateDir: "asc",
    dateCol: "j.created_event_at", dateHead: "Created",
    footnote: "Booked and not yet on a press.",
  },
  completed: {
    label: "Completed", statuses: ["completed"], dateDir: "desc",
    dateCol: "j.completed_at", dateHead: "Completed",
    footnote: "Every completed job in the feed.",
  },
} as const;

type TabKey = keyof typeof TABS;

// The filter matches a job by its own id, its customer or its part. Written as
// a function so each query can place it at whatever parameter number it needs.
const filterOn = (p: number) =>
  `($${p}::text is null or j.job_id ilike $${p} or j.customer_id ilike $${p} or j.part_id ilike $${p})`;

type Row = {
  job_id: string; customer_id: string; part_id: string; facility_id: string;
  priority: string; status: string; target_quantity: string | null;
  pass_units: string; fail_units: string; due: string | null;
  section_date: string | null; late: boolean;
};

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; sort?: string; dir?: string; q?: string }>;
}) {
  const sp = await searchParams;
  const tab: TabKey = sp.tab && sp.tab in TABS ? (sp.tab as TabKey) : "in-progress";
  const t = TABS[tab];
  const q = (sp.q ?? "").trim();
  const like = q ? `%${q}%` : null;

  const spec: SortSpec = {
    job_id: "j.job_id", customer: "j.customer_id", part: "j.part_id",
    facility: "j.facility_id",
    priority: "array_position(array['high','normal','low'], j.priority)",
    target: "j.target_quantity", pass: "j.inspection_pass_units",
    due: "j.target_due_at", date: t.dateCol,
  };
  const sort = orderBy(spec, sp.sort, sp.dir, "date", t.dateDir);

  const [top, totals, metrics, rows] = await Promise.all([
    chrome(),

    one<{ matched: string; all_jobs: string } & Record<TabKey, string>>(
      `select count(*) filter (where ${filterOn(1)})::text as matched,
              count(*)::text as all_jobs,
              count(*) filter (where ${filterOn(1)}
                and j.status = any($2))::text as "in-progress",
              count(*) filter (where ${filterOn(1)}
                and j.status = any($3))::text as pending,
              count(*) filter (where ${filterOn(1)}
                and j.status = any($4))::text as completed
       from jobs j`,
      [like, TABS["in-progress"].statuses, TABS.pending.statuses, TABS.completed.statuses]),

    one<Record<string, string>>(
      `select count(*)::text as jobs,
              coalesce(sum(j.cycle_units), 0)::text              as units_pressed,
              coalesce(sum(j.target_quantity), 0)::text          as units_booked,
              coalesce(sum(j.good_quantity), 0)::text            as good_units,
              count(*) filter (where j.status = 'blocked')::text as blocked,
              count(*) filter (where j.status = 'created')::text as awaiting_tooling,
              count(*) filter (where j.completed_at <= j.target_due_at)::text as on_time
       from jobs j where j.status = any($1) and ${filterOn(2)}`, [t.statuses, like]),

    query<Row>(
      `select j.job_id, j.customer_id, j.part_id, j.facility_id, j.priority, j.status,
              j.target_quantity::text, j.inspection_pass_units::text as pass_units,
              j.inspection_fail_units::text as fail_units,
              to_char(j.target_due_at, 'YYYY-MM-DD') as due,
              to_char(${t.dateCol}, 'YYYY-MM-DD') as section_date,
              coalesce(j.completed_at > j.target_due_at,
                       j.target_due_at < (select max(occurred_at) from events)) as late
       from jobs j where j.status = any($1) and ${filterOn(2)}
       order by ${sort.sql} nulls last, j.job_id`, [t.statuses, like]),
  ]);

  const metricSets: Record<TabKey, { value: string; label: string }[]> = {
    "in-progress": [
      { value: num(metrics.jobs), label: "jobs" },
      { value: num(metrics.units_pressed), label: "units pressed" },
      { value: num(metrics.blocked), label: "blocked" },
    ],
    pending: [
      { value: num(metrics.jobs), label: "jobs" },
      { value: num(metrics.units_booked), label: "units booked" },
      { value: num(metrics.awaiting_tooling), label: "awaiting tooling" },
    ],
    completed: [
      { value: num(metrics.jobs), label: "jobs" },
      { value: num(metrics.good_units), label: "good units" },
      { value: num(metrics.on_time), label: "on time" },
    ],
  };

  const cols: Column[] = [
    { key: "job_id", label: "Job" }, { key: "customer", label: "Customer" },
    { key: "part", label: "Part" }, { key: "facility", label: "Facility" },
    { key: "priority", label: "Priority" }, { key: "target", label: "Order", num: true },
    { key: "pass", label: "Pass / fail", num: true }, { key: "due", label: "Due", num: true },
    { key: "date", label: t.dateHead, num: true },
  ];
  const href = sortHref({ tab, q: q || undefined }, sort.key, sort.dir);
  const tabHref = (key: string) => "?" + new URLSearchParams({ tab: key, ...(q ? { q } : {}) }).toString();
  const muted = { fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" };
  const numeric = { textAlign: "right" as const, fontVariantNumeric: "tabular-nums" };

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <Header current="jobs" feedEnd={top.feed_end} userName={top.user_name} />
      <main style={{ flex: 1, padding: "32px 28px 72px", maxWidth: 1560, width: "100%", margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 16, marginBottom: 20 }}>
          <h2 style={{ margin: 0 }}>Jobs</h2>
          <span style={{ fontSize: 13, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
            {num(totals.matched)} of {num(totals.all_jobs)} jobs
          </span>
        </div>

        <form style={{ display: "flex", gap: 16, alignItems: "center", marginBottom: 24 }}>
          <input type="hidden" name="tab" value={tab} />
          <input className="input" style={{ maxWidth: 280 }} name="q" defaultValue={q}
                 placeholder="Filter by job, customer or part" />
        </form>

        <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
          <div className="seg" style={{ alignSelf: "flex-start" }}>
            {(Object.keys(TABS) as TabKey[]).map((key) => (
              <a key={key} className="seg-opt" href={tabHref(key)} aria-current={key === tab}>
                {TABS[key].label} ({num(totals[key])})
              </a>
            ))}
          </div>

          <section className="card" style={{ padding: "var(--space-6)", gap: "var(--space-4)" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 20, flexWrap: "wrap" }}>
              <h4 style={{ margin: 0 }}>{t.label}</h4>
              {metricSets[tab].map((m) => (
                <div key={m.label} style={{ ...muted, whiteSpace: "nowrap" }}>
                  <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--color-text)", fontSize: 14 }}>{m.value}</span> {m.label}
                </div>
              ))}
            </div>

            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>{cols.map((c) => <Th key={c.key} col={c} active={c.key === sort.key} dir={sort.dir} href={href} />)}</tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const p = PRIORITY[r.priority] ?? PRIORITY.normal;
                    return (
                      <ClickRow key={r.job_id} href={`/jobs/${r.job_id}`}>
                        <td style={{ fontVariantNumeric: "tabular-nums" }}><a href={`/jobs/${r.job_id}`}>{r.job_id}</a></td>
                        <td><a href={`/customers/${r.customer_id}`}>{customerLabel(r.customer_id)}</a></td>
                        <td style={{ fontVariantNumeric: "tabular-nums" }}><a href={`/parts/${r.part_id}`}>{r.part_id}</a></td>
                        <td style={{ fontVariantNumeric: "tabular-nums" }}>{r.facility_id}</td>
                        <td><span className="tag" style={{ background: p.bg, color: p.ink }}>{p.label}</span></td>
                        <td style={numeric}>{num(r.target_quantity)}</td>
                        <td style={numeric}>{num(r.pass_units)} / {num(r.fail_units)}</td>
                        <td style={{ ...numeric, color: r.late && r.status !== "completed" ? "var(--color-accent-800)" : "inherit" }}>{r.due ?? "—"}</td>
                        <td style={numeric}>{r.section_date ?? "—"}</td>
                      </ClickRow>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={muted}>{t.footnote}</div>
          </section>
        </div>
      </main>
    </div>
  );
}
