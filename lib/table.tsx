// Sortable table headers. A page declares which columns may be sorted and the
// SQL each one orders by; nothing the visitor types reaches the query text.

export type SortSpec = Record<string, string>;

export function orderBy(spec: SortSpec, sort: string | undefined, dir: string | undefined, fallback: string) {
  const key = sort && sort in spec ? sort : fallback;
  const descending = dir === "desc";
  return { key, dir: descending ? "desc" : "asc", sql: `${spec[key]} ${descending ? "desc" : "asc"}` };
}

export type Column = { key: string; label: string; num?: boolean };

/** Header cells as links carrying the next sort state. */
export function Th({ col, active, dir, href }: { col: Column; active: boolean; dir: string; href: (key: string) => string }) {
  const next = active && dir === "asc" ? "↑" : active ? "↓" : "";
  return (
    <th style={{ textAlign: col.num ? "right" : "left" }}>
      <a
        href={href(col.key)}
        style={{ color: active ? "var(--color-accent-700)" : "inherit", textDecoration: "none", whiteSpace: "nowrap" }}
      >
        {col.label}
        {next && <span style={{ marginLeft: 4 }}>{next}</span>}
      </a>
    </th>
  );
}

/** Builds the querystring for clicking a header: same column flips direction. */
export function sortHref(base: Record<string, string | undefined>, activeKey: string, activeDir: string) {
  return (key: string) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(base)) if (v) params.set(k, v);
    params.set("sort", key);
    params.set("dir", key === activeKey && activeDir === "asc" ? "desc" : "asc");
    return "?" + params.toString();
  };
}
