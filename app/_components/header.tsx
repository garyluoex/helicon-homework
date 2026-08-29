const NAV = [
  { id: "home", label: "Home", href: "/" },
  { id: "jobs", label: "Jobs" },
  { id: "equipment", label: "Equipment" },
  { id: "customers", label: "Customers" },
];

// Only Home is built, so the other three render in place but do not navigate.
export default function Header({ current, feedEnd }: { current: string; feedEnd: string }) {
  return (
    <header
      className="nav"
      style={{ borderBottom: "1px solid var(--color-divider)", padding: "14px 28px", gap: 28, position: "sticky", top: 0, background: "var(--color-bg)", zIndex: 5 }}
    >
      <a className="nav-brand" href="/" style={{ letterSpacing: ".14em", textTransform: "uppercase", marginRight: 32, color: "inherit", textDecoration: "none" }}>
        Helicon
      </a>
      <nav style={{ display: "flex", gap: 22, marginRight: "auto" }}>
        {NAV.map((item) => {
          const active = item.id === current;
          const style = {
            fontSize: 13,
            letterSpacing: ".1em",
            textTransform: "uppercase" as const,
            paddingBottom: 2,
            borderBottom: `2px solid ${active ? "var(--color-accent)" : "transparent"}`,
            color: active ? "var(--color-accent-700)" : "inherit",
            opacity: item.href ? 1 : 0.45,
            cursor: item.href ? "pointer" : "default",
          };
          return item.href ? (
            <a key={item.id} href={item.href} aria-current={active ? "page" : undefined} style={style}>
              {item.label}
            </a>
          ) : (
            <span key={item.id} style={style} title="Not built yet">
              {item.label}
            </span>
          );
        })}
      </nav>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <span className="tag tag-neutral" style={{ letterSpacing: ".08em" }}>Read only</span>
        <span style={{ fontSize: 12, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>Feed to {feedEnd}</span>
      </div>
    </header>
  );
}
