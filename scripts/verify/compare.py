"""Diffs truth.py (raw JSONL) against db.mjs (Neon, the console's own SQL)."""
import json, sys

truth = json.load(open(sys.argv[1]))
db = json.load(open(sys.argv[2]))
rows, fails = [], 0


def norm(v):
    if isinstance(v, str) and len(v) >= 20 and v[4] == "-" and "T" in v:
        return v.replace("+00:00", "Z").replace(".000Z", "Z")[:19]
    if isinstance(v, str):
        try:
            return float(v) if "." in v else int(v)
        except ValueError:
            return v
    return v


def check(page, metric, t, d):
    global fails
    ok = norm(t) == norm(d)
    fails += not ok
    rows.append((page, metric, t, d, "PASS" if ok else "FAIL"))


# feed shape
for k in ("ledger_events", "jobs", "customers", "parts", "machines", "feed_start", "feed_end"):
    check("Feed / ledger", k, truth["feed"][k], db["feed"][k])
for k, v in truth["event_types"].items():
    check("Feed / event types", k, v, db["event_types"].get(k))

# home
for days in ("7", "30", "42"):
    for k, v in truth["home"][days].items():
        check(f"Home ({days}d)", k, v, db["home"][days].get(k))
tb = {r["job_id"]: r for r in truth["home_open_block_rows"]}
db_b = {r["job_id"]: r for r in db["home_open_block_rows"]}
check("Home / open blocks", "row count", len(tb), len(db_b))
for jid in sorted(tb):
    for f in ("cause", "where_at", "when_at", "silent_days"):
        check("Home / open blocks", f"{jid}.{f}", tb[jid][f], db_b.get(jid, {}).get(f))
tg = {r["where_at"]: r for r in truth["home_glitch_rows"]}
db_g = {r["where_at"]: r for r in db["home_glitch_rows"]}
check("Home / glitches", "row count", len(tg), len(db_g))
for m in sorted(tg):
    for f in ("signals", "alerts", "when_at", "silent_days"):
        check("Home / glitches", f"{m}.{f}", tg[m][f], db_g.get(m, {}).get(f))

# jobs
check("Jobs", "jobs total", truth["jobs_total"], db["jobs_total"])
for s, n in truth["status_counts"].items():
    check("Jobs / status fold", s, n, db["status_counts"].get(s))
for tab, m in truth["jobs_tabs"].items():
    for k, v in m.items():
        check(f"Jobs / {tab}", k, v, db["jobs_tabs"][tab].get(k))

# customers
for k, v in truth["customers_kpis"].items():
    check("Customers / KPIs", k, v, db["customers_kpis"].get(k))
dc = {r["customer_id"]: r for r in db["customer_rows"]}
check("Customers / rows", "row count", len(truth["customer_rows"]), len(dc))
for r in truth["customer_rows"]:
    for f in ("jobs", "open_jobs", "ordered", "good", "done", "on_time", "revenue"):
        check("Customers / rows", f"{r['customer_id']}.{f}", r[f], dc.get(r["customer_id"], {}).get(f))

# parts
for k, v in truth["parts_kpis"].items():
    check("Parts / KPIs", k, v, db["parts_kpis"].get(k))
dp = {r["part_id"]: r for r in db["part_rows"]}
check("Parts / rows", "row count", len(truth["part_rows"]), len(dp))
for r in truth["part_rows"]:
    for f in ("material_id", "jobs", "customers", "ordered", "good", "scrap",
              "fail_units", "scrap_rate", "median_gap_h"):
        check("Parts / rows", f"{r['part_id']}.{f}", r[f], dp.get(r["part_id"], {}).get(f))

# equipment
for k, v in truth["equipment_kpis"].items():
    check("Equipment / KPIs", k, v, db["equipment_kpis"].get(k))
# Keyed on the unit, since a machine code alone names two machines.
de = {(r["facility_id"], r["machine_id"]): r for r in db["equipment_rows"]}
check("Equipment / rows", "row count", len(truth["equipment_rows"]), len(de))
for r in truth["equipment_rows"]:
    unit = (r["facility_id"], r["machine_id"])
    for f in ("kind", "events", "glitches", "metric", "last_fault", "down"):
        check("Equipment / rows", f"{unit[0]}/{unit[1]}.{f}", r[f], de.get(unit, {}).get(f))

# job detail
for jid, t in truth["job_detail"].items():
    d = db["job_detail"][jid]
    for f in ("status", "target_quantity", "cycle_count", "cycle_units",
              "inspection_pass_units", "inspection_fail_units", "good_quantity",
              "scrap_quantity", "event_count", "unit_price_estimate", "blocks",
              "unblocks", "machine_id", "tool_id", "operator_id",
              "created_event_at", "completed_at", "last_event_at"):
        check(f"Job / {jid}", f, t[f], d.get(f))
    check(f"Job / {jid}", "timeline_events", t["event_count"], d.get("timeline_events"))

w = [max(len(str(r[i])) for r in rows + [("Page", "Metric", "JSONL", "Neon", "Result")]) for i in range(5)]
hdr = ("Page", "Metric", "JSONL (python)", "Neon (app SQL)", "Result")
w = [max(w[i], len(hdr[i])) for i in range(5)]
line = lambda c: "| " + " | ".join(str(c[i]).ljust(w[i]) for i in range(5)) + " |"
print(line(hdr))
print("|" + "|".join("-" * (w[i] + 2) for i in range(5)) + "|")
for r in rows:
    print(line(r))
print(f"\n{len(rows)} numbers compared, {len(rows) - fails} pass, {fails} fail")
