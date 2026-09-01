"""
Reads the rendered console pages and diffs the numbers a person actually sees
against truth.py's figures. This is the layer the SQL comparison cannot reach:
the values the components derive in TSX (units inspected, on-time %, yield,
the attention count) and the formatting applied to everything else.
"""
import json, re, sys
from html import unescape

DIR, truth = sys.argv[1], json.load(open(sys.argv[2]))
rows, fails = [], 0

# A card's three lines. React splits text nodes with an HTML comment, so a
# segment is "anything but a tag, comments allowed".
SEG = r"((?:[^<]|<!--.*?-->)*?)"
KPI = re.compile(
    r'<div class="card-kicker">' + SEG + r'</div>'
    r'<div style="font-family:var\(--font-heading\);font-size:\d+px;line-height:1[^"]*">' + SEG + r'</div>'
    r'<div style="font-size:12px[^"]*">' + SEG + r'</div>', re.S)


def text(s):
    return unescape(re.sub(r"<[^>]+>", "", s)).strip()


def page(name):
    return open(f"{DIR}/{name}").read()


STRIP = re.compile(r'white-space:nowrap"><span[^>]*>([\d,]+)</span> <!-- -->([a-z ]+)</div>')


def strip_metrics(html):
    """The three figures beside a jobs tab heading."""
    return {label: value for value, label in STRIP.findall(html)}


def flat(html):
    """Visible page text: scripts dropped, tags and HTML comments stripped."""
    body = re.sub(r"<script.*?</script>", " ", html, flags=re.S)
    return re.sub(r"[ \t]+", " ", unescape(re.sub(r"<[^>]+>", "", body)))


def kpis(html):
    return {text(k): (text(v), text(n)) for k, v, n in KPI.findall(html)}


def tables(html):
    """Every <table> as a list of rows of cell text."""
    out = []
    for t in re.findall(r"<table class=\"table\">(.*?)</table>", html, re.S):
        out.append([[text(c) for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, re.S)]
                    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", t, re.S)])
    return out


def check(page_name, metric, expected, rendered):
    global fails
    ok = str(expected) == str(rendered)
    fails += not ok
    rows.append((page_name, metric, expected, rendered, "PASS" if ok else "FAIL"))


def n(v):
    return f"{int(v):,}"


# ---------------- Home -------------------------------------------------
for f, days in (("home.html", "42"), ("home7.html", "7"), ("home30.html", "30")):
    h, t = page(f), truth["home"][days]
    k = kpis(h)
    label = f"Home ({days}d)"
    check(label, "Created jobs", n(t["created_in_range"]), k["Created jobs"][0])
    check(label, "note: completed in range", f"new orders in this range · {n(t['done_in_range'])} completed", k["Created jobs"][1])
    check(label, "Tools prepared", n(t["tools"]), k["Tools prepared"][0])
    check(label, "note: tools prepared", "tooling made ready for a job", k["Tools prepared"][1])
    check(label, "Units pressed", n(t["pressed"]), k["Units pressed"][0])
    check(label, "note: units pressed", "total units out of the presses", k["Units pressed"][1])
    check(label, "Units inspected", n(t["pass_units"] + t["fail_units"]), k["Units inspected"][0])
    check(label, "note: pass / fail split", f"{n(t['pass_units'])} passed, {n(t['fail_units'])} failed by QC", k["Units inspected"][1])
    ft = flat(h)
    check(label, "window", f"{t['window_start']} to {t['feed_end']} · {t['window_days']} days",
          re.search(r"[\d-]{10} to [\d-]{10} · \d+ days", ft).group(0))
    check(label, "attention items", f"{n(t['open_blocks'] + t['glitch_events'])} items · open blocks and sensor anomalies",
          re.search(r"([\d,]+) items · open blocks and sensor anomalies", ft).group(0))
    check(label, "open blocks caption", f"{n(t['open_blocks'])} jobs with more blocks than unblocks",
          re.search(r"([\d,]+) jobs with more blocks than unblocks", ft).group(0))
    check(label, "glitch caption", f"{n(t['glitch_events'])} anomalies across {n(t['glitch_units'])} units",
          re.search(r"([\d,]+) anomalies across ([\d,]+) units", ft).group(0))

hb, hg = tables(page("home.html"))[:2]
tb = {r["job_id"]: r for r in truth["home_open_block_rows"]}
check("Home / open blocks", "row count", len(tb), len(hb) - 1)
for r in hb[1:]:
    t = tb[r[0]]
    check("Home / open blocks", f"{r[0]} row",
          [r[0], t["cause"] or "unstated cause", t["where_at"], t["when_at"], str(t["silent_days"])], r)
tg = {r["where_at"]: r for r in truth["home_glitch_rows"]}
check("Home / glitches", "row count", len(tg), len(hg) - 1)
for r in hg[1:]:
    t = tg[r[0]]
    check("Home / glitches", f"{r[0]} row",
          [r[0], t["signals"], str(t["alerts"]), t["when_at"], str(t["silent_days"])], r)

# ---------------- Jobs -------------------------------------------------
TAB_FILE = {"in-progress": "jobs_inprogress.html", "pending": "jobs_pending.html",
            "completed": "jobs_completed.html"}
METRICS = {"in-progress": [("jobs", "jobs"), ("units_pressed", "units pressed"), ("blocked", "blocked")],
           "pending": [("jobs", "jobs"), ("units_booked", "units booked"), ("awaiting_tooling", "awaiting tooling")],
           "completed": [("jobs", "jobs"), ("good_units", "good units"), ("on_time", "on time")]}
for tab, f in TAB_FILE.items():
    h, t = page(f), truth["jobs_tabs"][tab]
    for key, label in METRICS[tab]:
        check(f"Jobs / {tab}", label, n(t[key]), strip_metrics(h)[label])
    check(f"Jobs / {tab}", "tab count", n(t["jobs"]),
          re.search(re.escape({"in-progress": "In progress", "pending": "Pending", "completed": "Completed"}[tab]) + r" \(([\d,]+)\)", flat(h)).group(1))
    check(f"Jobs / {tab}", "table rows", t["jobs"], len(tables(h)[0]) - 1)
    check(f"Jobs / {tab}", "header count",
          f"{n(truth['jobs_total'])} of {n(truth['jobs_total'])} jobs",
          re.search(r"([\d,]+) of ([\d,]+) jobs", flat(h)).group(0))

# ---------------- Customers -------------------------------------------
h, t = page("customers.html"), truth["customers_kpis"]
k = kpis(h)
check("Customers", "Customers", n(t["customers"]), k["Customers"][0])
check("Customers", "note: with work open", f"{n(t['customers_open'])} with work still running", k["Customers"][1])
check("Customers", "Jobs booked", n(t["jobs"]), k["Jobs booked"][0])
check("Customers", "note: still open", f"{n(t['open_jobs'])} not yet completed", k["Jobs booked"][1])
check("Customers", "Units ordered", n(t["ordered"]), k["Units ordered"][0])
check("Customers", "Good delivered", n(t["good"]), k["Good delivered"][0])
check("Customers", "note: completed jobs", f"from {n(t['done'])} completed jobs", k["Good delivered"][1])
check("Customers", "On time", f"{round(100 * t['on_time'] / t['done'])}%", k["On time"][0])
check("Customers", "Est. revenue", "$" + n(t["revenue"]), k["Est. revenue"][0])
check("Customers", "note: priced jobs", f"a price is quoted on {n(t['priced'])} of {n(t['jobs'])} jobs", k["Est. revenue"][1])
check("Customers", "both sites caption",
      f"{n(t['customers'])} accounts, {n(t['both_sites'])} of them placing work at both sites",
      re.search(r"([\d,]+) accounts, ([\d,]+) of them placing work at both sites", flat(h)).group(0))
crows = {r[0]: r for r in tables(h)[0][1:]}
check("Customers / rows", "row count", len(truth["customer_rows"]), len(crows))
for r in truth["customer_rows"]:
    label = r["customer_id"].replace("cust_", "")
    on_time = f"{round(100 * r['on_time'] / r['done'])}%" if r["done"] else "—"
    check("Customers / rows", label,
          [label, n(r["jobs"]), n(r["open_jobs"]), n(r["ordered"]), n(r["good"]), on_time, "$" + n(r["revenue"])],
          crows[label])

# one customer detail page
cid = "cust_nimbus"
cr = next(r for r in truth["customer_rows"] if r["customer_id"] == cid)
k = kpis(page("customer_nimbus.html"))
check("Customer / nimbus", "Jobs", n(cr["jobs"]), k["Jobs"][0])
check("Customer / nimbus", "note: open", f"{n(cr['open_jobs'])} not yet completed", k["Jobs"][1])
check("Customer / nimbus", "Units ordered", n(cr["ordered"]), k["Units ordered"][0])
check("Customer / nimbus", "Good delivered", n(cr["good"]), k["Good delivered"][0])
check("Customer / nimbus", "On time", f"{round(100 * cr['on_time'] / cr['done'])}%", k["On time"][0])
check("Customer / nimbus", "Est. revenue", "$" + n(cr["revenue"]), k["Est. revenue"][0])

# ---------------- Parts ------------------------------------------------
h = page("parts.html")
check("Parts", "caption", f"{truth['parts_kpis']['parts']} parts across {truth['parts_kpis']['materials']} materials",
      re.search(r"(\d+) parts across (\d+) materials", flat(h)).group(0))
prows = {r[0]: r for r in tables(h)[0][1:]}
check("Parts / rows", "row count", len(truth["part_rows"]), len(prows))
for r in truth["part_rows"]:
    check("Parts / rows", r["part_id"],
          [r["part_id"], r["material_id"], n(r["jobs"]), n(r["customers"]), n(r["ordered"]),
           "—" if r["scrap_rate"] is None else f"{r['scrap_rate']:.1f}%",
           "—" if r["median_gap_h"] is None else f"{r['median_gap_h']:.1f} h"],
          prows[r["part_id"]])

pt = next(r for r in truth["part_rows"] if r["part_id"] == "part_1015")
k = kpis(page("part_1015.html"))
check("Part / part_1015", "Jobs", n(pt["jobs"]), k["Jobs"][0])
check("Part / part_1015", "note: customers", f"for {n(pt['customers'])} different customers", k["Jobs"][1])
check("Part / part_1015", "Units ordered", n(pt["ordered"]), k["Units ordered"][0])
check("Part / part_1015", "Good delivered", n(pt["good"]), k["Good delivered"][0])
check("Part / part_1015", "note: scrapped", f"{n(pt['scrap'])} units scrapped", k["Good delivered"][1])
check("Part / part_1015", "Scrap rate", f"{pt['scrap_rate']:.1f}%", k["Scrap rate"][0])
check("Part / part_1015", "Median cycle gap", f"{pt['median_gap_h']:.1f} h", k["Median cycle gap"][0])
check("Part / part_1015", "rejected units caption",
      f"{n(pt['fail_units'])} units rejected across {n(pt['jobs'])} jobs.",
      re.search(r">([\d,]+) units rejected across ([\d,]+) jobs\.<", page("part_1015.html")).group(0)[1:-1])

# ---------------- Equipment -------------------------------------------
EQ = {"press": "equip_press.html", "qc": "equip_qc.html", "tooling": "equip_tooling.html"}
for kind, f in EQ.items():
    h = page(f)
    # Location leads the row, so a rendered row is keyed on the pair.
    erows = {(r[0], r[1]): r for r in tables(h)[0][1:]}
    want = [r for r in truth["equipment_rows"] if r["kind"] == kind]
    check(f"Equipment / {kind}", "row count", len(want), len(erows))
    for r in want:
        unit = (r["facility_id"], r["machine_id"])
        check(f"Equipment / {kind}", f"{unit[0]}/{unit[1]}",
              [r["facility_id"], r["machine_id"],
               "Non-operational" if r["down"] else "Operational", r["last_fault"] or "—",
               n(r["events"]), n(r["metric"]), n(r["glitches"])],
              erows[unit])
    kp = truth["equipment_kpis"]
    check(f"Equipment / {kind}", "unit caption",
          f"{kp['codes']} machine codes across {kp['locations']} locations, {kp['units']} units in all",
          re.search(r"(\d+) machine codes across (\d+) locations, (\d+) units in all", flat(h)).group(0))

# ---------------- Job detail ------------------------------------------
for jid in ("job_0080", "job_0166", "job_0293"):
    t = truth["job_detail"][jid]
    h = page(f"{jid}.html")
    k = kpis(h)
    label = f"Job / {jid}"
    check(label, "Run span note", f"{n(t['cycle_count'])} cycles, first to last", k["Run span"][1])
    if t["good_quantity"] is not None:
        good, scrap = t["good_quantity"], t["scrap_quantity"]
        check(label, "Yield", f"{(100 * good / (good + scrap)):.1f}%", k["Yield"][0])
        check(label, "Yield note", f"{n(good)} good, {n(scrap)} scrap", k["Yield"][1])
    else:
        check(label, "Yield", "—", k["Yield"][0])
    fj = flat(h)
    check(label, "ordered units", f"{n(t['target_quantity'])} ordered",
          re.search(r"([\d,]+) ordered", fj).group(0))
    check(label, "passed units", f"{n(t['inspection_pass_units'])} passed",
          re.search(r"([\d,]+) passed", fj).group(0))
    check(label, "failed units", f"{n(t['inspection_fail_units'])} failed",
          re.search(r"([\d,]+) failed", fj).group(0))
    check(label, "pressed units", f"{n(t['cycle_units'])} pressed",
          re.search(r"([\d,]+) pressed", fj).group(0))
    check(label, "timeline event count", f"{n(t['event_count'])} events",
          re.search(r"([\d,]+) events · the whole ledger", fj).group(0).split(" ·")[0])
    check(label, "blocks / unblocks", f"{t['blocks']} / {t['unblocks']}",
          text(re.search(r"Blocks / unblocks</td><td[^>]*>(.*?)</td>", h, re.S).group(1)))
    if t["unit_price_estimate"]:
        check(label, "estimated value",
              "$" + n(round(float(t["unit_price_estimate"]) * t["target_quantity"])),
              text(re.search(r"Estimated value</td><td[^>]*>(.*?)</td>", h, re.S).group(1)))

w = [max(len(str(r[i])) for r in rows) for i in range(5)]
hdr = ("Page", "Metric", "Expected (JSONL)", "Rendered (web app)", "Result")
w = [max(w[i], len(hdr[i])) for i in range(5)]
line = lambda c: "| " + " | ".join(str(c[i]).ljust(w[i]) for i in range(5)) + " |"
print(line(hdr))
print("|" + "|".join("-" * (w[i] + 2) for i in range(5)) + "|")
for r in rows:
    print(line(r))
print(f"\n{len(rows)} rendered values compared, {len(rows) - fails} pass, {fails} fail")
