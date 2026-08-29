import { one } from "@/lib/db";
import LoginForm from "./form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const stats = await one<{ events: string; jobs: string; facilities: string }>(
    `select (select count(*) from events)::text                   as events,
            (select count(*) from jobs)::text                     as jobs,
            (select count(distinct facility_id) from jobs)::text  as facilities`
  );
  const n = (v: string) => Number(v).toLocaleString("en-US");

  return (
    <div style={{ minHeight: "100vh", display: "grid", gridTemplateColumns: "1.15fr 1fr", background: "var(--color-bg)" }}>
      <div style={{ background: "var(--color-accent-900)", color: "var(--color-bg)", padding: "64px 56px", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
        <div style={{ fontFamily: "var(--font-heading)", fontSize: 19, letterSpacing: ".16em", textTransform: "uppercase" }}>Helicon</div>
        <div>
          <div style={{ fontSize: 11, letterSpacing: ".14em", textTransform: "uppercase", opacity: 0.65, marginBottom: 14 }}>Composites manufacturing</div>
          <h1 style={{ fontSize: 64, lineHeight: 0.98, margin: "0 0 18px", maxWidth: "11ch" }}>Event ledger viewer</h1>
          <p style={{ fontSize: 15, lineHeight: 1.6, maxWidth: "44ch", opacity: 0.8, margin: 0, textWrap: "pretty" }}>
            A read-only window on the shop floor feed. Nothing here writes back: every number on every
            screen is a projection of the events the presses, QC stations and tooling cells reported.
          </p>
        </div>
        <div style={{ display: "flex", gap: 44, fontSize: 12, letterSpacing: ".08em", textTransform: "uppercase", opacity: 0.7 }}>
          <div>{n(stats.events)} events</div>
          <div>{n(stats.jobs)} jobs</div>
          <div>{n(stats.facilities)} facilities</div>
        </div>
      </div>
      <div style={{ display: "grid", placeItems: "center", padding: 40 }}>
        <LoginForm />
      </div>
    </div>
  );
}
