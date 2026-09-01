// Formatters and palettes taken from the Helicon ERP design, so the screens
// read the same way it does.

const DASH = "—";

export const num = (v: string | number | null | undefined) =>
  v === null || v === undefined ? DASH : Number(v).toLocaleString("en-US");

export const money = (v: string | number | null | undefined) =>
  v === null || v === undefined ? DASH : "$" + Math.round(Number(v)).toLocaleString("en-US");

export const dash = (v: string | null | undefined) => v ?? DASH;

/** Hours as the design renders them: days over a day, minutes under an hour. */
export function dur(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return DASH;
  if (hours >= 24) return (hours / 24).toFixed(1) + " d";
  if (hours >= 1) return hours.toFixed(1) + " h";
  return Math.round(hours * 60) + " m";
}

export const hoursBetween = (a: string | null, b: string | null): number | null => {
  if (!a || !b) return null;
  const h = (Date.parse(b) - Date.parse(a)) / 3600000;
  return h > 0 ? h : null;
};

type Swatch = { label: string; bg: string; ink: string };

export const STATUS: Record<string, Swatch> = {
  created:       { label: "Created",       bg: "var(--color-neutral-200)", ink: "var(--color-neutral-800)" },
  tooling_ready: { label: "Tooling ready", bg: "var(--color-neutral-200)", ink: "var(--color-neutral-800)" },
  in_progress:   { label: "In progress",   bg: "var(--color-accent-100)",  ink: "var(--color-accent-800)" },
  blocked:       { label: "Blocked",       bg: "#f7dcda",                  ink: "#7d2a22" },
  on_hold:       { label: "On hold",       bg: "#fbe6cd",                  ink: "#7d4f14" },
  completed:     { label: "Completed",     bg: "#dcefe2",                  ink: "#26603f" },
};

/**
 * Equipment state, the three-way fold the machine_state view computes. The
 * amber is the on-hold amber and the red is the blocked red: a unit running
 * with a warning on it reads like a job on hold, a unit stopped reads like a
 * job blocked.
 */
export const MACHINE_STATE: Record<string, Swatch> = {
  operational:     { label: "Operational",     bg: "var(--color-accent-2-100)", ink: "var(--color-accent-2-800)" },
  degraded:        { label: "Degraded",        bg: "#fbe6cd",                   ink: "#7d4f14" },
  non_operational: { label: "Non-operational", bg: "#f7dcda",                   ink: "#7d2a22" },
};

export const PRIORITY: Record<string, Swatch> = {
  high:   { label: "high",   bg: "#f7dcda",                 ink: "#7d2a22" },
  normal: { label: "normal", bg: "var(--color-accent-100)", ink: "var(--color-accent-800)" },
  low:    { label: "low",    bg: "var(--color-neutral-100)", ink: "var(--color-neutral-700)" },
};

export const customerLabel = (id: string) => id.replace("cust_", "");
