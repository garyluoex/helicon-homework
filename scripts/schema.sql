-- =====================================================================
-- Manufacturing event store: proposed PostgreSQL schema
-- Derived from data/manufacturing_events.jsonl (19,519 events, 42 days).
--
-- Scope rule: a column exists only where the feed supplies the value.
-- The one field lifted out of an event's metadata is `facility`, because a
-- machine code is only unique within a site: location is half the identity
-- of a physical unit, not an attribute of an event.
-- `jobs` additionally carries the rollups the application reads on every
-- screen, maintained by the ingest and rebuildable from the ledger with
-- rebuild_jobs(). Every table is written by the event ingest except
-- `users`, which the application's auth layer owns.
--
-- Six tables, kept to the core. A code gets a table only where something
-- hangs off it: customers because the business is organised around them,
-- parts because a part states its material, machines because a location and
-- a code together name a physical unit, and the code states its kind. Facilities, tools, materials and technician badges are values
-- the events carry, listed with a DISTINCT over the ledger when a screen
-- needs them and given a table the day they carry more than a code.
-- Target: PostgreSQL 14+.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------
-- @enums
-- One enum, and it is not a vocabulary from the feed: job_status is our
-- own six-state fold of the event stream. Everything the shop names
-- (event types, defect codes, block reasons, signals, priorities) stays
-- text, so a new code on the floor never rejects a row.
-- ---------------------------------------------------------------------
CREATE TYPE job_status AS ENUM ('created', 'tooling_ready', 'in_progress',
                                'blocked', 'on_hold', 'completed');

-- One closed set read off the code prefix, stamped on the registry row the
-- first time a code appears. Unambiguous across all 10 machine codes.
CREATE TYPE machine_kind AS ENUM ('press', 'qc', 'tooling');

-- ---------------------------------------------------------------------
-- @table events
-- The append-only ledger, and the only source of truth. One column per
-- field the feed actually sends, nothing derived, nothing duplicated:
-- metadata stays whole rather than being copied out into columns.
--
-- event_id is the primary key. 19 ids arrive twice in the sample. A repeat
-- carrying the same payload changes nothing; a repeat carrying a different
-- payload is treated as a restatement and overwrites the stored row (5 of
-- the 19 do, all differing only in quantity). So the table is append-only
-- for distinct ids and last-writer-wins for a repeated one, and the
-- projection is repaired by replay rather than by arithmetic: see
-- process_event and rebuild_job.
--
-- No constraints beyond the key. This table has to accept whatever the
-- shop reported, including the parts that are wrong; the projections
-- below are where meaning is imposed.
--
-- Two source fields are renamed: `timestamp` -> occurred_at (timestamp
-- is a type name), `material` -> material_id (it is a code, not a mass).
--
-- One field is copied out of metadata rather than only read through it:
-- facility_id. Every one of the 19,519 events carries it, and it is half
-- the key of the machine the event names, so an equipment query joins on
-- it on the hot path. metadata still keeps its own copy and stays whole.
-- ---------------------------------------------------------------------
CREATE TABLE events (
  event_id    text PRIMARY KEY,     -- 'evt_000001'
  occurred_at timestamptz,          -- source `timestamp`, UTC
  event_type  text,                 -- 14 values today; text, not enum
  job_id      text,
  part_id     text,
  customer_id text,
  material_id text,                 -- source `material`
  machine_id  text,                 -- null on 704 events, kept null
  facility_id text,                 -- source metadata `facility`, la_01 | la_02
  quantity    integer,              -- meaning depends on event_type
  metadata    jsonb                 -- 15 keys across the feed, kept whole
);

-- ---------------------------------------------------------------------
-- @table customers
-- Created on sight from events.customer_id. 16 in the sample, and not
-- facility-scoped: 15 of the 16 place work at both sites.
-- ---------------------------------------------------------------------
CREATE TABLE customers (
  customer_id text PRIMARY KEY                   -- 'cust_orbit'
);

-- ---------------------------------------------------------------------
-- @table parts
-- Created on sight from events.part_id. 25 in the sample, and the only
-- registry with a column of its own: across all 19,519 events a part maps
-- to exactly one material, so material_id is a stated fact about the part.
-- It is plain text with nothing to validate it against, since materials
-- have no table; dq_part_material_conflicts is what catches a disagreement.
-- Customer is not stable per part: every part is built for several, so that
-- relationship lives on the job.
-- ---------------------------------------------------------------------
CREATE TABLE parts (
  part_id     text PRIMARY KEY,                  -- 'part_1020'
  material_id text                               -- 8 codes in the feed, unvalidated
);

-- ---------------------------------------------------------------------
-- @table machines
-- Created on sight from (events.facility_id, events.machine_id):
-- press_01..06, qc_01..02, tooling_01..02, and all ten codes appear under
-- both la_01 and la_02. The sites number their own equipment, so press_01
-- at la_01 and press_01 at la_02 are two different presses that happen to
-- share a name. Location plus code is therefore the key, and twenty rows
-- is the true count of physical units.
--
-- kind stays a fact about the code rather than the unit: it is the prefix,
-- stamped once on first sight of the unit and never revisited.
-- ---------------------------------------------------------------------
CREATE TABLE machines (
  facility_id text,                              -- 'la_01', where the unit stands
  machine_id  text,                              -- 'press_04', unique only within a site
  kind        machine_kind NOT NULL,             -- from the prefix, first sight only
  PRIMARY KEY (facility_id, machine_id)
);

-- ---------------------------------------------------------------------
-- @table jobs
-- The projection, maintained forward as events arrive. A row is created by
-- whichever event mentions the job first, so ingest can start mid-stream.
--
-- Three kinds of column: what the events repeat on every line (identity),
-- what an event states once (the order terms, the completion totals), and
-- what the ingest accumulates (milestones, counters, resources). The third
-- kind is a second copy of what the ledger already says, bought deliberately
-- so a job list or a job page is one row read instead of an aggregate.
--
-- Two rules keep that copy from lying. Totals the event carries as a total
-- (good_quantity, scrap_quantity) are ASSIGNED, never added, so job_0293's
-- second completion cannot double them. Counters are only reached through
-- apply_event, which process_event calls only when the ledger insert
-- actually inserted, so a repeated event_id moves nothing.
--
-- Milestones use LEAST / GREATEST and resources use COALESCE, so those are
-- order-independent; the counters and the status fold are not, which is why
-- rebuild_jobs() replays in occurred_at order.
--
-- Deliberately absent: block_count, hold_count, completion_event_count, and
-- generated yield_pct / days_late. Each is one arithmetic step from columns
-- that are here, or one GROUP BY over events.
-- ---------------------------------------------------------------------
CREATE TABLE jobs (
  job_id                text        PRIMARY KEY,   -- 'job_0003'
  customer_id           text        REFERENCES customers(customer_id),
  part_id               text        REFERENCES parts(part_id),
  material_id           text,                                          -- no materials table
  facility_id           text,                                          -- la_01 | la_02
  status                job_status  NOT NULL DEFAULT 'created',

  -- stated once by job_created
  priority              text,                      -- low | normal | high
  target_quantity       integer,
  target_due_at         timestamptz,
  unit_price_estimate   numeric(10,2),             -- present on 150 of 312

  -- stated once by job_completed, assigned and never accumulated
  good_quantity         integer,
  scrap_quantity        integer,

  -- resources. Verified single-valued per job across all 312: no job runs on
  -- more than one press, tool or operator, so first value wins. The material
  -- lot is deliberately not here: 14 of 312 jobs carry one, 5 of those scans
  -- land after the last cycle, and no lot is shared between jobs, so it stays
  -- in the event's metadata until the feed can support traceability.
  machine_id            text,                                          -- the press, from job_started
  tool_id               text,                                          -- 25 codes, unvalidated
  operator_id           text,                                          -- badge code, unvalidated

  -- milestones, each set by its own event type, never moved backwards
  created_event_at      timestamptz,
  tool_ready_at         timestamptz,
  started_at            timestamptz,
  first_cycle_at        timestamptz,
  last_cycle_at         timestamptz,
  first_inspection_at   timestamptz,
  last_inspection_at    timestamptz,
  completed_at          timestamptz,
  last_event_at         timestamptz,

  -- counters, incremented once per applied event
  cycle_count           integer     NOT NULL DEFAULT 0,
  cycle_units           integer     NOT NULL DEFAULT 0,   -- press throughput, NOT order progress
  inspection_pass_units integer     NOT NULL DEFAULT 0,
  inspection_fail_units integer     NOT NULL DEFAULT 0,
  event_count           integer     NOT NULL DEFAULT 0,

  -- A press is identified by where it stands, so the reference is the pair.
  -- Verified across all 312 jobs: each carries exactly one facility, and
  -- every job_started names a machine under that same facility. MATCH SIMPLE
  -- leaves the check unenforced while machine_id is null, which is what a
  -- job that has not started yet looks like.
  FOREIGN KEY (facility_id, machine_id) REFERENCES machines (facility_id, machine_id)
);

-- ---------------------------------------------------------------------
-- @table users
-- The only table an event never touches, and the only one whose columns do
-- not come from the feed. The application is a viewer over the shop's data:
-- nothing here writes to events or jobs, and no other table references a
-- user. technician_id is the one bridge, carrying the badge code the feed
-- names so an operator's screens can be scoped to their own work. There is
-- no technicians table to point at, so nothing validates the code beyond
-- uniqueness: a typo here is a login that matches no events.
-- ---------------------------------------------------------------------
CREATE TABLE users (
  user_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         citext NOT NULL UNIQUE,
  display_name  text,
  technician_id text UNIQUE                      -- badge code, null for a planner
);

-- ---------------------------------------------------------------------
-- @indexes
-- Sized for 19.5k events per 6 weeks (~170k/year). No partitioning yet:
-- revisit past roughly 50M rows, then RANGE partition events on
-- occurred_at. The two expression indexes stand in for the columns this
-- schema deliberately does not store.
-- ---------------------------------------------------------------------
CREATE INDEX events_job_time_idx   ON events (job_id, occurred_at);
CREATE INDEX events_type_time_idx  ON events (event_type, occurred_at DESC);
CREATE INDEX events_time_idx       ON events (occurred_at DESC);
CREATE INDEX events_machine_idx    ON events (facility_id, machine_id, occurred_at DESC) WHERE machine_id IS NOT NULL;
CREATE INDEX events_metadata_gin   ON events USING gin (metadata jsonb_path_ops);
CREATE INDEX events_defect_idx     ON events ((metadata ->> 'defect_code'), occurred_at DESC)
                                    WHERE metadata ? 'defect_code';
CREATE INDEX events_tool_idx       ON events ((metadata ->> 'tool_id'), occurred_at DESC)
                                    WHERE metadata ? 'tool_id';

CREATE INDEX jobs_status_idx       ON jobs (facility_id, status);   -- facility is text now
CREATE INDEX jobs_customer_idx     ON jobs (customer_id, created_event_at DESC);
CREATE INDEX jobs_open_due_idx     ON jobs (target_due_at) WHERE completed_at IS NULL;
CREATE INDEX jobs_silent_idx       ON jobs (last_event_at) WHERE completed_at IS NULL;
CREATE INDEX jobs_machine_idx      ON jobs (facility_id, machine_id) WHERE machine_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- @ingest
-- Three functions, because the projection has to be reachable twice (once
-- per arriving event, once per stored event when jobs is rebuilt) and
-- because a loader wants to spend one round trip on many events.
--
--   apply_event    the projection, and the only thing that moves a counter
--   process_event  registries, then the ledger write, then apply or repair
--   process_events one round trip per batch, in order
--
-- The ledger write decides what a repeated event_id means, and reports it:
--
--   applied    a new id. Inserted, then applied to the projection.
--   unchanged  the id and the whole payload were already stored. The
--              upsert's WHERE finds nothing distinct, so no row is touched
--              and no counter moves.
--   restated   the id was stored with a different payload. The row is
--              overwritten and the affected job's projection is rebuilt
--              from the ledger, because the counters it already accumulated
--              were computed from the payload that just got replaced.
-- ---------------------------------------------------------------------
CREATE FUNCTION apply_event(p events) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO jobs (job_id, customer_id, part_id, material_id, facility_id)
  VALUES (p.job_id, p.customer_id, p.part_id, p.material_id, p.facility_id)
  ON CONFLICT (job_id) DO NOTHING;

  UPDATE jobs j SET
    -- terms, stated once
    priority            = CASE WHEN p.event_type = 'job_created' THEN p.metadata ->> 'priority' ELSE j.priority END,
    target_quantity     = CASE WHEN p.event_type = 'job_created' THEN (p.metadata ->> 'target_quantity')::int ELSE j.target_quantity END,
    target_due_at       = CASE WHEN p.event_type = 'job_created' THEN (p.metadata ->> 'target_due_at')::timestamptz ELSE j.target_due_at END,
    unit_price_estimate = CASE WHEN p.event_type = 'job_created' THEN (p.metadata ->> 'unit_price_estimate')::numeric ELSE j.unit_price_estimate END,

    -- totals, assigned so a replayed completion cannot double them
    good_quantity  = CASE WHEN p.event_type = 'job_completed' THEN (p.metadata ->> 'good_quantity')::int  ELSE j.good_quantity END,
    scrap_quantity = CASE WHEN p.event_type = 'job_completed' THEN (p.metadata ->> 'scrap_quantity')::int ELSE j.scrap_quantity END,

    -- resources, first value wins
    machine_id        = CASE WHEN p.event_type = 'job_started' THEN COALESCE(j.machine_id, p.machine_id) ELSE j.machine_id END,
    tool_id           = COALESCE(j.tool_id, p.metadata ->> 'tool_id'),
    operator_id       = COALESCE(j.operator_id, p.metadata ->> 'operator_id'),

    -- milestones. LEAST and GREATEST ignore nulls, so the first event of a
    -- type sets the stamp and a later or backfilled one cannot rewind it.
    created_event_at    = CASE WHEN p.event_type = 'job_created'     THEN LEAST(j.created_event_at, p.occurred_at)    ELSE j.created_event_at END,
    tool_ready_at       = CASE WHEN p.event_type = 'tool_ready'      THEN LEAST(j.tool_ready_at, p.occurred_at)       ELSE j.tool_ready_at END,
    started_at          = CASE WHEN p.event_type = 'job_started'     THEN LEAST(j.started_at, p.occurred_at)          ELSE j.started_at END,
    first_cycle_at      = CASE WHEN p.event_type = 'cycle_completed' THEN LEAST(j.first_cycle_at, p.occurred_at)      ELSE j.first_cycle_at END,
    last_cycle_at       = CASE WHEN p.event_type = 'cycle_completed' THEN GREATEST(j.last_cycle_at, p.occurred_at)    ELSE j.last_cycle_at END,
    first_inspection_at = CASE WHEN p.event_type IN ('inspection_passed','inspection_failed') THEN LEAST(j.first_inspection_at, p.occurred_at)   ELSE j.first_inspection_at END,
    last_inspection_at  = CASE WHEN p.event_type IN ('inspection_passed','inspection_failed') THEN GREATEST(j.last_inspection_at, p.occurred_at) ELSE j.last_inspection_at END,
    completed_at        = CASE WHEN p.event_type = 'job_completed'   THEN LEAST(j.completed_at, p.occurred_at)        ELSE j.completed_at END,
    last_event_at       = GREATEST(j.last_event_at, p.occurred_at),

    -- counters. Each event is applied exactly once, so these accumulate.
    cycle_count           = j.cycle_count + (p.event_type = 'cycle_completed')::int,
    cycle_units           = j.cycle_units           + CASE WHEN p.event_type = 'cycle_completed'   THEN COALESCE(p.quantity, 0) ELSE 0 END,
    inspection_pass_units = j.inspection_pass_units + CASE WHEN p.event_type = 'inspection_passed' THEN COALESCE(p.quantity, 0) ELSE 0 END,
    inspection_fail_units = j.inspection_fail_units + CASE WHEN p.event_type = 'inspection_failed' THEN COALESCE(p.quantity, 0) ELSE 0 END,
    event_count           = j.event_count + 1,

    status = CASE
      WHEN p.event_type = 'job_completed' THEN 'completed'::job_status
      WHEN j.status = 'completed'         THEN j.status         -- terminal wins over late strays
      WHEN p.event_type = 'job_hold'      THEN 'on_hold'
      WHEN p.event_type = 'job_blocked'   THEN 'blocked'
      WHEN p.event_type IN ('job_started', 'job_unblocked', 'cycle_completed',
                            'inspection_passed', 'inspection_failed') THEN 'in_progress'
      WHEN p.event_type = 'tool_ready' AND j.status = 'created' THEN 'tooling_ready'
      ELSE j.status END
  WHERE j.job_id = p.job_id;
END $$;

-- Returns 'applied', 'restated' or 'unchanged'. rebuild_job is defined in
-- the replay section below; plpgsql resolves it at first call, not here.
CREATE FUNCTION process_event(p_raw jsonb) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_md    jsonb := COALESCE(p_raw -> 'metadata', '{}'::jsonb);
  v_event events;
  v_new   boolean;
BEGIN
  -- 1. reference rows, created the first time an event names them
  INSERT INTO customers  (customer_id) VALUES (p_raw ->> 'customer_id')  ON CONFLICT DO NOTHING;
  INSERT INTO parts (part_id, material_id)
    VALUES (p_raw ->> 'part_id', p_raw ->> 'material')
    ON CONFLICT DO NOTHING;   -- a later disagreement is a finding, not an overwrite

  -- One row per physical unit, so a code seen at a second site registers
  -- as a second machine rather than colliding with the first.
  INSERT INTO machines (facility_id, machine_id, kind)
    SELECT v_md ->> 'facility',
           p_raw ->> 'machine_id',
           split_part(p_raw ->> 'machine_id', '_', 1)::machine_kind
    WHERE p_raw ->> 'machine_id' IS NOT NULL
    ON CONFLICT DO NOTHING;

  -- 2. the ledger write. The WHERE is what separates a restatement from a
  --    repeat that says nothing new: if no column differs, no row is
  --    touched, RETURNING yields nothing and FOUND is false.
  INSERT INTO events (event_id, occurred_at, event_type, job_id, part_id,
                      customer_id, material_id, machine_id, facility_id, quantity, metadata)
  VALUES (p_raw ->> 'event_id', (p_raw ->> 'timestamp')::timestamptz, p_raw ->> 'event_type',
          p_raw ->> 'job_id', p_raw ->> 'part_id', p_raw ->> 'customer_id',
          p_raw ->> 'material', p_raw ->> 'machine_id', v_md ->> 'facility',
          (p_raw ->> 'quantity')::int, v_md)
  ON CONFLICT (event_id) DO UPDATE SET
    occurred_at = EXCLUDED.occurred_at,
    event_type  = EXCLUDED.event_type,
    job_id      = EXCLUDED.job_id,
    part_id     = EXCLUDED.part_id,
    customer_id = EXCLUDED.customer_id,
    material_id = EXCLUDED.material_id,
    machine_id  = EXCLUDED.machine_id,
    facility_id = EXCLUDED.facility_id,
    quantity    = EXCLUDED.quantity,
    metadata    = EXCLUDED.metadata
  WHERE events.* IS DISTINCT FROM EXCLUDED.*
  RETURNING (xmax = 0) INTO v_new;   -- xmax is 0 on an insert, set on an update

  IF NOT FOUND THEN
    RETURN 'unchanged';
  END IF;

  SELECT * INTO v_event FROM events WHERE event_id = p_raw ->> 'event_id';

  -- 3. the projection
  IF v_new THEN
    PERFORM apply_event(v_event);
    RETURN 'applied';
  END IF;

  -- A restatement replaced a payload the counters were already computed
  -- from, so this job's totals are wrong by the difference. Replaying the
  -- job costs one delete and its own events; teaching apply_event to
  -- subtract would cost every event forever.
  PERFORM rebuild_job(v_event.job_id);
  RETURN 'restated';
END $$;

-- One round trip, many events, applied in array order. Only the events that
-- were not plainly applied come back, so a full load returns a handful of
-- rows rather than one per event.
CREATE FUNCTION process_events(p_batch jsonb)
RETURNS TABLE (event_id text, outcome text)
LANGUAGE plpgsql AS $$
DECLARE
  e jsonb;
  o text;
BEGIN
  FOR e IN SELECT value FROM jsonb_array_elements(p_batch) LOOP
    o := process_event(e);
    IF o <> 'applied' THEN
      event_id := e ->> 'event_id';
      outcome  := o;
      RETURN NEXT;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- @replay
-- The repair path, and the reason stored counters are safe to keep. The
-- ledger is untouched: jobs is emptied and rebuilt from it, in occurred_at
-- order because the counters and the status fold depend on order. Run it
-- after changing anything in apply_event, or to prove the projection still
-- agrees with the events.
--
-- Two scopes. rebuild_job repairs one job and is called by process_event
-- whenever a restatement invalidates that job's totals; rebuild_jobs is the
-- whole-table version, and the two must agree.
--
-- 19,519 events is a single-digit-second rebuild. Past a few million, replay
-- per facility or per job range rather than whole-table.
-- ---------------------------------------------------------------------
CREATE FUNCTION rebuild_job(p_job_id text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  r events;
BEGIN
  DELETE FROM jobs WHERE job_id = p_job_id;   -- nothing references jobs
  FOR r IN SELECT * FROM events WHERE job_id = p_job_id
           ORDER BY occurred_at, event_id LOOP
    PERFORM apply_event(r);
  END LOOP;
END $$;

CREATE FUNCTION rebuild_jobs() RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  r events;
  n bigint := 0;
BEGIN
  TRUNCATE jobs;                       -- nothing references jobs
  FOR r IN SELECT * FROM events ORDER BY occurred_at, event_id LOOP
    PERFORM apply_event(r);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- ---------------------------------------------------------------------
-- @dq
-- Every anomaly the profile found gets a standing query, not a cleanup.
-- ---------------------------------------------------------------------
-- job_0293 looked like the sample's double completion; loading proved both
-- lines carry event_id evt_001862, so the ledger holds one and this returns
-- nothing. It stays as the guard for a job that completes twice under two ids.
CREATE VIEW dq_double_completions AS
  SELECT e.job_id, count(*) AS completion_events,
         j.good_quantity, j.scrap_quantity, j.target_quantity
  FROM events e JOIN jobs j USING (job_id)
  WHERE e.event_type = 'job_completed'
  GROUP BY e.job_id, j.good_quantity, j.scrap_quantity, j.target_quantity
  HAVING count(*) > 1;

CREATE VIEW dq_unattributed_events AS         -- 704 events with no machine
  SELECT event_type,
         count(*) FILTER (WHERE machine_id IS NULL) AS no_machine,
         count(*) FILTER (WHERE NOT metadata ? 'inspector_id'
                          AND event_type IN ('inspection_passed','inspection_failed')) AS no_inspector,
         count(*) AS total
  FROM events GROUP BY 1 ORDER BY 2 DESC;

CREATE VIEW dq_censored_cycles AS             -- 1,072 cycles pinned at the 1,860 s ceiling
  SELECT facility_id, machine_id,
         count(*) FILTER (WHERE (metadata ->> 'cycle_time_seconds')::int >= 1860) AS at_ceiling,
         count(*) AS cycles
  FROM events WHERE event_type = 'cycle_completed' GROUP BY 1, 2;

CREATE VIEW dq_part_material_conflicts AS     -- none in the sample; guards parts.material_id
  SELECT e.part_id, p.material_id AS part_material, e.material_id AS event_material, count(*)
  FROM events e JOIN parts p USING (part_id)
  WHERE e.material_id <> p.material_id GROUP BY 1, 2, 3;

CREATE VIEW dq_stalled_jobs AS                -- 10 never started, 21 started and never finished
  SELECT job_id, status, last_event_at, target_due_at,
         now() - last_event_at AS silent_for
  FROM jobs
  WHERE completed_at IS NULL AND last_event_at < now() - interval '3 days';

-- Holds are not the leak: all 13 in the sample are followed by production
-- within 0.1 to 7.4 hours, so the status fold clears them on its own.
-- Blocks are. 68 job_blocked against 59 job_unblocked leaves 9 jobs blocked
-- at the end of the feed, none completed, silent 7 to 37 days. Three of the
-- nine kept cycling after the block, so status alone does not find them:
-- the test has to be the count of blocks against the count of unblocks.
CREATE VIEW dq_open_blocks AS
  SELECT j.job_id, j.status, j.last_event_at,
         count(*) FILTER (WHERE e.event_type = 'job_blocked')   AS blocks,
         count(*) FILTER (WHERE e.event_type = 'job_unblocked') AS unblocks,
         max(e.occurred_at) FILTER (WHERE e.event_type = 'job_blocked') AS last_blocked_at
  FROM jobs j JOIN events e USING (job_id)
  WHERE j.completed_at IS NULL
  GROUP BY j.job_id, j.status, j.last_event_at
  HAVING count(*) FILTER (WHERE e.event_type = 'job_blocked')
       > count(*) FILTER (WHERE e.event_type = 'job_unblocked');

-- The shop vocabularies are text, so nothing rejects a new code. This is
-- the standing watch instead: 6 defect codes, 5 block causes and their 5
-- resolved_ mirrors, 3 signals, 3 priorities as of this sample. A value
-- that appears here for the first time is a conversation, not an outage.
CREATE VIEW dq_vocabulary AS
  SELECT 'defect_code' AS key, metadata ->> 'defect_code' AS value, count(*) AS events
  FROM events WHERE metadata ? 'defect_code' GROUP BY 2
  UNION ALL
  SELECT 'reason', metadata ->> 'reason', count(*)
  FROM events WHERE metadata ? 'reason' GROUP BY 2
  UNION ALL
  SELECT 'signal', metadata ->> 'signal', count(*)
  FROM events WHERE metadata ? 'signal' GROUP BY 2
  UNION ALL
  SELECT 'event_type', event_type, count(*)
  FROM events GROUP BY 2
  UNION ALL
  SELECT 'priority', priority, count(*)
  FROM jobs WHERE priority IS NOT NULL GROUP BY 2
  UNION ALL   -- the vocabularies with no table of their own
  SELECT 'material', material_id, count(*)
  FROM events GROUP BY 2
  UNION ALL
  SELECT 'facility', facility_id, count(*)
  FROM events GROUP BY 2
  UNION ALL
  SELECT 'tool', metadata ->> 'tool_id', count(*)
  FROM events WHERE metadata ? 'tool_id' GROUP BY 2
  UNION ALL   -- 24 operators, 12 inspectors
  SELECT 'operator', metadata ->> 'operator_id', count(*)
  FROM events WHERE metadata ? 'operator_id' GROUP BY 2
  UNION ALL
  SELECT 'inspector', metadata ->> 'inspector_id', count(*)
  FROM events WHERE metadata ? 'inspector_id' GROUP BY 2;

CREATE VIEW dq_overproduction AS              -- cycles run 1.00 to 1.60 x the order, median 1.48
  SELECT job_id, target_quantity, cycle_units,
         inspection_pass_units + inspection_fail_units AS inspected_units,
         round(cycle_units::numeric / NULLIF(target_quantity, 0), 2) AS cycles_per_ordered_unit
  FROM jobs WHERE target_quantity IS NOT NULL AND cycle_units > target_quantity;
