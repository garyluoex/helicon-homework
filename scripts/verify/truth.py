"""
Ground truth for the console's numbers, computed straight from the JSONL feed
with no database involved. Every figure here is recomputed from the raw lines
so it can be diffed against what Neon returns for the same screen.

Two rules from the schema writeup are reproduced deliberately, because the
numbers depend on them:
  * a repeated event_id is a restatement, so the LAST payload wins
  * the jobs projection is the replay of the ledger in (occurred_at, event_id)
    order, exactly what rebuild_jobs() does
"""
import json, math, sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP

FEED = "data/manufacturing_events.jsonl"
SECONDS_PER_DAY = 86400


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None


def fac(e):
    """The event's location. Half the identity of the machine it names."""
    return (e.get("metadata") or {}).get("facility")


def load():
    """Raw lines, deduplicated last-wins, in the replay order rebuild_jobs uses."""
    by_id, order, dupes = {}, [], defaultdict(int)
    with open(FEED) as fh:
        for line in fh:
            e = json.loads(line)
            eid = e["event_id"]
            dupes[eid] += 1
            if eid not in by_id:
                order.append(eid)
            by_id[eid] = e
    raw_lines = sum(dupes.values())
    repeated = {k: v for k, v in dupes.items() if v > 1}
    events = [by_id[i] for i in order]
    for e in events:
        e["_at"] = ts(e["timestamp"])
    events.sort(key=lambda e: (e["_at"], e["event_id"]))
    return events, raw_lines, repeated


def least(a, b):
    return b if a is None else (a if b is None else min(a, b))


def greatest(a, b):
    return b if a is None else (a if b is None else max(a, b))


IN_PROGRESS_TYPES = {"job_started", "job_unblocked", "cycle_completed",
                     "inspection_passed", "inspection_failed"}


def project(events):
    """apply_event, in Python. One row per job, built by replaying the ledger."""
    jobs = {}
    for e in events:
        md = e.get("metadata") or {}
        jid = e["job_id"]
        j = jobs.get(jid)
        if j is None:
            j = jobs[jid] = {
                "job_id": jid, "customer_id": e["customer_id"], "part_id": e["part_id"],
                "material_id": e["material"], "facility_id": md.get("facility"),
                "status": "created", "priority": None, "target_quantity": None,
                "target_due_at": None, "unit_price_estimate": None,
                "good_quantity": None, "scrap_quantity": None,
                "machine_id": None, "tool_id": None, "operator_id": None,
                "created_event_at": None, "tool_ready_at": None, "started_at": None,
                "first_cycle_at": None, "last_cycle_at": None,
                "first_inspection_at": None, "last_inspection_at": None,
                "completed_at": None, "last_event_at": None,
                "cycle_count": 0, "cycle_units": 0,
                "inspection_pass_units": 0, "inspection_fail_units": 0, "event_count": 0,
            }
        t, at, qty = e["event_type"], e["_at"], e["quantity"] or 0

        if t == "job_created":
            j["priority"] = md.get("priority")
            j["target_quantity"] = md.get("target_quantity")
            j["target_due_at"] = ts(md.get("target_due_at"))
            p = md.get("unit_price_estimate")
            j["unit_price_estimate"] = None if p is None else Decimal(str(p)).quantize(Decimal("0.01"))
            j["created_event_at"] = least(j["created_event_at"], at)
        elif t == "job_completed":
            j["good_quantity"] = md.get("good_quantity")
            j["scrap_quantity"] = md.get("scrap_quantity")
            j["completed_at"] = least(j["completed_at"], at)
        elif t == "tool_ready":
            j["tool_ready_at"] = least(j["tool_ready_at"], at)
        elif t == "job_started":
            j["machine_id"] = j["machine_id"] or e["machine_id"]
            j["started_at"] = least(j["started_at"], at)
        elif t == "cycle_completed":
            j["first_cycle_at"] = least(j["first_cycle_at"], at)
            j["last_cycle_at"] = greatest(j["last_cycle_at"], at)

        if t in ("inspection_passed", "inspection_failed"):
            j["first_inspection_at"] = least(j["first_inspection_at"], at)
            j["last_inspection_at"] = greatest(j["last_inspection_at"], at)

        j["tool_id"] = j["tool_id"] or md.get("tool_id")
        j["operator_id"] = j["operator_id"] or md.get("operator_id")
        j["last_event_at"] = greatest(j["last_event_at"], at)

        j["cycle_count"] += t == "cycle_completed"
        j["cycle_units"] += qty if t == "cycle_completed" else 0
        j["inspection_pass_units"] += qty if t == "inspection_passed" else 0
        j["inspection_fail_units"] += qty if t == "inspection_failed" else 0
        j["event_count"] += 1

        if t == "job_completed":
            j["status"] = "completed"
        elif j["status"] == "completed":
            pass
        elif t == "job_hold":
            j["status"] = "on_hold"
        elif t == "job_blocked":
            j["status"] = "blocked"
        elif t in IN_PROGRESS_TYPES:
            j["status"] = "in_progress"
        elif t == "tool_ready" and j["status"] == "created":
            j["status"] = "tooling_ready"
    return jobs


def r1(x):
    return None if x is None else float(Decimal(str(x)).quantize(Decimal("0.1"), ROUND_HALF_UP))


def r0(x):
    return None if x is None else int(Decimal(str(x)).quantize(Decimal("1"), ROUND_HALF_UP))


def pct_disc(values):
    """percentile_disc(0.5): nulls dropped, first value at or past the halfway mark."""
    vs = sorted(v for v in values if v is not None)
    if not vs:
        return None
    return vs[max(1, math.ceil(0.5 * len(vs))) - 1]


def main():
    events, raw_lines, repeated = load()
    jobs = project(events)
    out = {}

    hi = max(e["_at"] for e in events)
    lo = min(e["_at"] for e in events)

    # ---- feed shape ------------------------------------------------------
    # A physical unit is location + machine code: the same code exists at
    # both sites and names two different machines.
    machines = {(fac(e), e["machine_id"]) for e in events if e["machine_id"]}
    out["feed"] = {
        "raw_lines": raw_lines,
        "repeated_event_ids": len(repeated),
        "ledger_events": len(events),
        "jobs": len(jobs),
        "customers": len({e["customer_id"] for e in events}),
        "parts": len({e["part_id"] for e in events}),
        "machines": len(machines),
        "feed_start": lo.strftime("%Y-%m-%d"),
        "feed_end": hi.strftime("%Y-%m-%d"),
    }
    types = defaultdict(int)
    for e in events:
        types[e["event_type"]] += 1
    out["event_types"] = dict(sorted(types.items(), key=lambda kv: -kv[1]))

    # ---- home page, one block per range selector -------------------------
    blocks = {}
    for days in (7, 30, 42):
        frm = hi - timedelta(days=days)
        start = max(lo, frm)
        inr = [e for e in events if e["_at"] >= frm]
        blocked = defaultdict(int)
        for e in events:
            if e["event_type"] == "job_blocked":
                blocked[e["job_id"]] += 1
            elif e["event_type"] == "job_unblocked":
                blocked[e["job_id"]] -= 1
        glitches = [e for e in events if e["event_type"] == "sensor_glitch"]
        blocks[days] = {
            "window_start": start.strftime("%Y-%m-%d"),
            "feed_end": hi.strftime("%Y-%m-%d"),
            "window_days": math.ceil((hi - start).total_seconds() / SECONDS_PER_DAY),
            "in_progress": sum(1 for j in jobs.values() if j["status"] != "completed"),
            "created_in_range": sum(1 for j in jobs.values()
                                    if j["created_event_at"] and j["created_event_at"] >= frm),
            "done_in_range": sum(1 for j in jobs.values()
                                 if j["completed_at"] and j["completed_at"] >= frm),
            "tools": sum(1 for e in inr if e["event_type"] == "tool_ready"),
            "pressed": sum(e["quantity"] or 0 for e in inr if e["event_type"] == "cycle_completed"),
            "pass_units": sum(e["quantity"] or 0 for e in inr if e["event_type"] == "inspection_passed"),
            "fail_units": sum(e["quantity"] or 0 for e in inr if e["event_type"] == "inspection_failed"),
            "open_blocks": sum(1 for v in blocked.values() if v > 0),
            "glitch_events": len(glitches),
            "units": len(machines),
            "flagged_units": None,   # filled in once machine state is folded, below
        }
    out["home"] = blocks

    # jobs with an unlifted block, the home "Needs attention" table
    net = defaultdict(lambda: [0, 0])
    last_reason, last_blocked = {}, {}
    for e in events:
        if e["event_type"] == "job_blocked":
            net[e["job_id"]][0] += 1
            last_reason[e["job_id"]] = (e.get("metadata") or {}).get("reason")
            last_blocked[e["job_id"]] = e["_at"]
        elif e["event_type"] == "job_unblocked":
            net[e["job_id"]][1] += 1
    out["home_open_block_rows"] = sorted(
        [{"job_id": jid,
          "cause": last_reason.get(jid),
          "where_at": jobs[jid]["machine_id"] or jobs[jid]["facility_id"],
          "when_at": jobs[jid]["last_event_at"].strftime("%Y-%m-%d"),
          "silent_days": math.floor((hi - jobs[jid]["last_event_at"]).total_seconds() / SECONDS_PER_DAY)}
         for jid, (b, u) in net.items() if b > u],
        key=lambda r: r["job_id"])

    # Home's equipment table is filled from the machine state fold below, so it
    # lists exactly the units Equipment does not call operational.

    # ---- jobs page, one block per tab ------------------------------------
    TABS = {"in-progress": ["in_progress", "blocked", "on_hold"],
            "pending": ["created", "tooling_ready"],
            "completed": ["completed"]}
    tabs = {}
    for tab, statuses in TABS.items():
        sel = [j for j in jobs.values() if j["status"] in statuses]
        tabs[tab] = {
            "jobs": len(sel),
            "units_pressed": sum(j["cycle_units"] for j in sel),
            "units_booked": sum(j["target_quantity"] or 0 for j in sel),
            "good_units": sum(j["good_quantity"] or 0 for j in sel),
            "blocked": sum(1 for j in sel if j["status"] == "blocked"),
            "awaiting_tooling": sum(1 for j in sel if j["status"] == "created"),
            "on_time": sum(1 for j in sel if j["completed_at"] and j["target_due_at"]
                           and j["completed_at"] <= j["target_due_at"]),
        }
    out["jobs_tabs"] = tabs
    out["jobs_total"] = len(jobs)
    out["status_counts"] = dict(sorted(
        ((s, sum(1 for j in jobs.values() if j["status"] == s)) for s in
         {j["status"] for j in jobs.values()})))

    # ---- customers -------------------------------------------------------
    def revenue(js):
        total = Decimal(0)
        for j in js:
            if j["unit_price_estimate"] is not None:
                qty = j["good_quantity"] if j["good_quantity"] is not None else j["target_quantity"]
                total += j["unit_price_estimate"] * Decimal(qty or 0)
        return total

    all_jobs = list(jobs.values())
    done = [j for j in all_jobs if j["completed_at"]]
    out["customers_kpis"] = {
        "customers": len({j["customer_id"] for j in all_jobs}),
        "customers_open": len({j["customer_id"] for j in all_jobs if j["status"] != "completed"}),
        "jobs": len(all_jobs),
        "open_jobs": sum(1 for j in all_jobs if j["status"] != "completed"),
        "ordered": sum(j["target_quantity"] or 0 for j in all_jobs),
        "good": sum(j["good_quantity"] or 0 for j in all_jobs),
        "done": len(done),
        "on_time": sum(1 for j in done if j["target_due_at"] and j["completed_at"] <= j["target_due_at"]),
        "priced": sum(1 for j in all_jobs if j["unit_price_estimate"] is not None),
        "revenue": r0(revenue(all_jobs)),
        "both_sites": sum(1 for c in {j["customer_id"] for j in all_jobs}
                          if len({j["facility_id"] for j in all_jobs if j["customer_id"] == c}) == 2),
    }
    rows = []
    for c in sorted({j["customer_id"] for j in all_jobs}):
        js = [j for j in all_jobs if j["customer_id"] == c]
        d = [j for j in js if j["completed_at"]]
        rows.append({
            "customer_id": c, "jobs": len(js),
            "open_jobs": sum(1 for j in js if j["status"] != "completed"),
            "ordered": sum(j["target_quantity"] or 0 for j in js),
            "good": sum(j["good_quantity"] or 0 for j in js),
            "done": len(d),
            "on_time": sum(1 for j in d if j["target_due_at"] and j["completed_at"] <= j["target_due_at"]),
            "revenue": r0(revenue(js)),
        })
    out["customer_rows"] = rows

    # ---- parts -----------------------------------------------------------
    part_material = {}
    for e in events:
        part_material.setdefault(e["part_id"], e["material"])
    out["parts_kpis"] = {"parts": len(part_material),
                         "materials": len(set(part_material.values()))}
    prows = []
    for p in sorted(part_material):
        js = [j for j in all_jobs if j["part_id"] == p]
        good = sum(j["good_quantity"] or 0 for j in js)
        scrap = sum(j["scrap_quantity"] or 0 for j in js)
        gaps = [((j["last_cycle_at"] - j["first_cycle_at"]).total_seconds() / j["cycle_count"])
                if j["cycle_count"] and j["first_cycle_at"] and j["last_cycle_at"] else None
                for j in js]
        med = pct_disc(gaps)
        prows.append({
            "part_id": p, "material_id": part_material[p], "jobs": len(js),
            "customers": len({j["customer_id"] for j in js}),
            "ordered": sum(j["target_quantity"] or 0 for j in js),
            "good": good, "scrap": scrap,
            "fail_units": sum(j["inspection_fail_units"] for j in js),
            "scrap_rate": r1(100 * scrap / (good + scrap)) if (good + scrap) else None,
            "median_gap_h": r1(med / 3600.0) if med is not None else None,
        })
    out["part_rows"] = prows

    # ---- equipment -------------------------------------------------------
    # The machine_state view, in Python. Three states in precedence order:
    # non_operational while the unit's latest machine_fault block still stands,
    # degraded while the job it was last put on carries a sensor glitch,
    # operational otherwise.
    #
    # Two rules, both matching the view. A signal names its unit as
    # (facility, code) and falls back to the press its job started on when it
    # names no machine at all; "seen working again" is the unit's next
    # assignment, which is job_started on a press, an inspection on a QC
    # station and tool_ready on a tooling cell.
    ASSIGN = ("job_started", "tool_ready", "inspection_passed", "inspection_failed")

    def unit_of(e):
        j = jobs.get(e["job_id"], {})
        code = e["machine_id"] or j.get("machine_id")
        return None if code is None else (fac(e) or j.get("facility_id"), code)

    assigned = defaultdict(list)
    for e in events:
        if e["event_type"] in ASSIGN and e["machine_id"]:
            assigned[(fac(e), e["machine_id"])].append(e)

    on_job, glitches_ever = defaultdict(list), defaultdict(int)
    for e in events:
        if e["event_type"] == "sensor_glitch" and unit_of(e):
            on_job[(unit_of(e), e["job_id"])].append(e)
            glitches_ever[unit_of(e)] += 1

    latest_fault = {}
    for e in events:
        if e["event_type"] != "job_blocked":
            continue
        if (e.get("metadata") or {}).get("reason") != "machine_fault":
            continue
        unit = unit_of(e)
        if unit is None:
            continue
        key = (e["_at"], e["event_id"])
        if unit not in latest_fault or key > latest_fault[unit][0]:
            latest_fault[unit] = (key, e["job_id"])

    def is_down(unit, key, job_id):
        unblocked = any(e["event_type"] == "job_unblocked" and e["job_id"] == job_id
                        and (e["_at"], e["event_id"]) > key for e in events)
        reassigned = any((e["_at"], e["event_id"]) > key for e in assigned[unit])
        return not (unblocked or reassigned)

    erows = []
    for facility, m in sorted(machines):
        unit = (facility, m)
        es = [e for e in events if e["machine_id"] == m and fac(e) == facility]
        kind = m.split("_")[0]
        metric = (len({e["job_id"] for e in es if e["event_type"] == "job_started"}) if kind == "press"
                  else sum(e["quantity"] or 0 for e in es
                           if e["event_type"] in ("inspection_passed", "inspection_failed")) if kind == "qc"
                  else sum(1 for e in es if e["event_type"] == "tool_ready"))
        fault = latest_fault.get(unit)
        down = is_down(unit, *fault) if fault else False
        last_job = assigned[unit][-1]["job_id"] if assigned[unit] else None
        glitched = on_job.get((unit, last_job), []) if last_job else []
        erows.append({
            "facility_id": facility, "machine_id": m, "kind": kind, "events": len(es),
            "glitches": glitches_ever.get(unit, 0),
            "metric": metric,
            "state": "non_operational" if down else "degraded" if glitched else "operational",
            "last_fault": fault[0][0].strftime("%Y-%m-%d") if fault else None,
            "last_job_id": last_job,
            "signal": ", ".join(sorted({(e.get("metadata") or {}).get("signal")
                                        for e in glitched})) or None,
            "last_event_at": max(e["_at"] for e in es).strftime("%Y-%m-%d") if es else None,
            "silent_days": (math.floor((hi - max(e["_at"] for e in es)).total_seconds()
                                       / SECONDS_PER_DAY) if es else None),
        })
    out["equipment_rows"] = erows

    # Home lists every unit the fold does not call operational, worst first.
    out["home_state_rows"] = [
        {"where_at": f'{r["machine_id"]} · {r["facility_id"]}',
         "facility_id": r["facility_id"], "machine_id": r["machine_id"],
         "state": r["state"],
         "problem": "machine_fault" if r["state"] == "non_operational" else r["signal"],
         "when_at": r["last_event_at"],
         "silent_days": r["silent_days"]}
        for r in erows if r["state"] != "operational"]
    for block in out["home"].values():
        block["flagged_units"] = len(out["home_state_rows"])
    out["equipment_kpis"] = {
        "units": len(machines),
        "codes": len({m for _, m in machines}),
        "locations": len({f for f, _ in machines}),
        "flagged": sum(1 for r in erows if r["state"] != "operational"),
    }

    # ---- machine detail pages --------------------------------------------
    # /equipment/[facility]/[machine]: the unit's chips, and the ten most recent
    # runs on it. A run is one job's work on this unit, dated by the last event
    # the unit reported for that job, so a job that came back to the same press
    # sorts by its latest visit. Glitches on a run reuse the attribution above,
    # the same fallback the page's own query applies, so a glitch the unit's
    # tally counts is a glitch some run in this list carries.
    RUNS_SHOWN = 10
    FAIL_RATE_FLAGGED = 0.15   # the share of judged units the page reads as a bad run

    visits = defaultdict(dict)          # unit -> job_id -> last event the unit reported for it
    for e in events:
        if e["machine_id"] is None or e["job_id"] is None:
            continue
        unit = (fac(e), e["machine_id"])
        visits[unit][e["job_id"]] = greatest(visits[unit].get(e["job_id"]), e["_at"])

    blocks_by_job, unblocks_by_job = defaultdict(int), defaultdict(int)
    for e in events:
        blocks_by_job[e["job_id"]] += e["event_type"] == "job_blocked"
        unblocks_by_job[e["job_id"]] += e["event_type"] == "job_unblocked"

    units = {}
    for r in erows:
        unit = (r["facility_id"], r["machine_id"])
        # Newest first, job id breaking a tie, exactly as the page orders.
        newest = sorted(visits[unit].items(), key=lambda kv: (kv[1], kv[0]), reverse=True)
        runs = []
        for jid, last_on_unit in newest[:RUNS_SHOWN]:
            j = jobs[jid]
            glitched = on_job.get((unit, jid), [])
            judged = j["inspection_pass_units"] + j["inspection_fail_units"]
            runs.append({
                "job_id": jid,
                "when_at": last_on_unit.strftime("%Y-%m-%d"),
                "status": j["status"],
                "glitches": len(glitched),
                "signals": ", ".join(sorted({(e.get("metadata") or {}).get("signal")
                                             for e in glitched})) or None,
                "subtitle": f'{j["customer_id"].replace("cust_", "")} · {j["part_id"]} · {j["material_id"]}',
                "target_quantity": j["target_quantity"],
                "cycle_units": j["cycle_units"], "cycle_count": j["cycle_count"],
                "pass_units": j["inspection_pass_units"],
                "fail_units": j["inspection_fail_units"],
                "blocks": blocks_by_job[jid], "unblocks": unblocks_by_job[jid],
                "due": j["target_due_at"].strftime("%Y-%m-%d") if j["target_due_at"] else None,
                "overdue": bool(j["status"] != "completed" and j["target_due_at"]
                                and j["target_due_at"] < hi),
                "failing": bool(judged and j["inspection_fail_units"] / judged > FAIL_RATE_FLAGGED),
            })
        units[f'{r["facility_id"]}/{r["machine_id"]}'] = {
            "kind": r["kind"], "state": r["state"],
            "events": r["events"], "jobs": len(visits[unit]), "glitches": r["glitches"],
            "last_fault": r["last_fault"],
            "last_fault_job_id": latest_fault[unit][1] if unit in latest_fault else None,
            "last_job_id": r["last_job_id"],
            "last_job_at": assigned[unit][-1]["_at"].strftime("%Y-%m-%d") if assigned[unit] else None,
            "signal": r["signal"],
            "runs": runs,
        }
    out["machine_detail"] = units

    # ---- a sample of job detail pages ------------------------------------
    sample = ["job_0001", "job_0080", "job_0166", "job_0189", "job_0216", "job_0293"]
    detail = {}
    for jid in sample:
        j = jobs[jid]
        blocks_n = sum(1 for e in events if e["job_id"] == jid and e["event_type"] == "job_blocked")
        unblocks_n = sum(1 for e in events if e["job_id"] == jid and e["event_type"] == "job_unblocked")
        detail[jid] = {
            "status": j["status"], "target_quantity": j["target_quantity"],
            "cycle_count": j["cycle_count"], "cycle_units": j["cycle_units"],
            "inspection_pass_units": j["inspection_pass_units"],
            "inspection_fail_units": j["inspection_fail_units"],
            "good_quantity": j["good_quantity"], "scrap_quantity": j["scrap_quantity"],
            "event_count": j["event_count"],
            "unit_price_estimate": None if j["unit_price_estimate"] is None else str(j["unit_price_estimate"]),
            "blocks": blocks_n, "unblocks": unblocks_n,
            "created_event_at": j["created_event_at"].isoformat() if j["created_event_at"] else None,
            "completed_at": j["completed_at"].isoformat() if j["completed_at"] else None,
            "last_event_at": j["last_event_at"].isoformat() if j["last_event_at"] else None,
            "machine_id": j["machine_id"], "tool_id": j["tool_id"], "operator_id": j["operator_id"],
        }
    out["job_detail"] = detail

    json.dump(out, sys.stdout, indent=1, default=str)


main()
