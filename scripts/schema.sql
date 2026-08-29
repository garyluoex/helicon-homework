-- =====================================================================
-- Manufacturing event store: proposed PostgreSQL schema
-- Derived from data/manufacturing_events.jsonl (19,519 events, 42 days).
--
-- Scope rule: a column exists only where the feed supplies the value.
-- `jobs` additionally carries the rollups the application reads on every
-- screen, maintained by the ingest and rebuildable from the ledger with
-- rebuild_jobs(). Every table is written by the event ingest except
-- `users`, which the application's auth layer owns.
--
-- Six tables, kept to the core. A code gets a table only where something
-- hangs off it: customers because the business is organised around them,
-- parts because a part states its material, machines because a code states
-- its kind. Facilities, tools, materials and technician badges are values
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
-- event_id is the primary key. 19 ids arrive twice in the sample; the
-- second copy is dropped at ingest (5 of those 19 differ in payload, so
-- the drop is a decision, not a technicality: see process_event, which
-- returns false so the loader can log what it discarded).
--
-- No constraints beyond the key. This table has to accept whatever the
-- shop reported, including the parts that are wrong; the projections
-- below are where meaning is imposed.
--
-- Two source fields are renamed: `timestamp` -> occurred_at (timestamp
-- is a type name), `material` -> material_id (it is a code, not a mass).
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
-- Created on sight from events.machine_id: press_01..06, qc_01..02,
-- tooling_01..02. kind is the code prefix, stamped once on first sight
-- and never revisited. All ten codes appear under both facilities;
-- the registry treats a code as one machine, and if the sites turn out
-- to number their own equipment the split is a replay away, since every
-- event carries its facility.
-- ---------------------------------------------------------------------
CREATE TABLE machines (
  machine_id text         PRIMARY KEY,           -- 'press_04'
  kind       machine_kind NOT NULL               -- from the prefix, first sight only
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
  machine_id            text        REFERENCES machines(machine_id),   -- the press, from job_started
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
  event_count           integer     NOT NULL DEFAULT 0
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
CREATE INDEX events_machine_idx    ON events (machine_id, occurred_at DESC) WHERE machine_id IS NOT NULL;
CREATE INDEX events_metadata_gin   ON events USING gin (metadata jsonb_path_ops);
CREATE INDEX events_defect_idx     ON events ((metadata ->> 'defect_code'), occurred_at DESC)
                                    WHERE metadata ? 'defect_code';
CREATE INDEX events_tool_idx       ON events ((metadata ->> 'tool_id'), occurred_at DESC)
                                    WHERE metadata ? 'tool_id';

CREATE INDEX jobs_status_idx       ON jobs (facility_id, status);   -- facility is text now
CREATE INDEX jobs_customer_idx     ON jobs (customer_id, created_event_at DESC);
CREATE INDEX jobs_open_due_idx     ON jobs (target_due_at) WHERE completed_at IS NULL;
CREATE INDEX jobs_silent_idx       ON jobs (last_event_at) WHERE completed_at IS NULL;
CREATE INDEX jobs_machine_idx      ON jobs (machine_id) WHERE machine_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- @ingest
-- Two functions, because the projection has to be reachable twice: once per
-- arriving event, and once per stored event when jobs is rebuilt.
--
--   apply_event   the projection, and the only thing that moves a counter
--   process_event registries, then the ledger insert, then apply_event
--
-- The ledger insert is the dedupe gate. A repeated event_id inserts nothing,
-- FOUND is false, apply_event is never called and the function returns false
-- so the loader can log the drop.
-- ---------------------------------------------------------------------
CREATE FUNCTION apply_event(p events) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO jobs (job_id, customer_id, part_id, material_id, facility_id)
  VALUES (p.job_id, p.customer_id, p.part_id, p.material_id, p.metadata ->> 'facility')
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

CREATE FUNCTION process_event(p_raw jsonb) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_md    jsonb := COALESCE(p_raw -> 'metadata', '{}'::jsonb);
  v_event events;
BEGIN
  -- 1. reference rows, created the first time an event names them
  INSERT INTO customers  (customer_id) VALUES (p_raw ->> 'customer_id')  ON CONFLICT DO NOTHING;
  INSERT INTO parts (part_id, material_id)
    VALUES (p_raw ->> 'part_id', p_raw ->> 'material')
    ON CONFLICT DO NOTHING;   -- a later disagreement is a finding, not an overwrite

  INSERT INTO machines (machine_id, kind)
    SELECT p_raw ->> 'machine_id',
           split_part(p_raw ->> 'machine_id', '_', 1)::machine_kind
    WHERE p_raw ->> 'machine_id' IS NOT NULL
    ON CONFLICT DO NOTHING;

  -- 2. the ledger insert IS the dedupe gate
  INSERT INTO events (event_id, occurred_at, event_type, job_id, part_id,
                      customer_id, material_id, machine_id, quantity, metadata)
  VALUES (p_raw ->> 'event_id', (p_raw ->> 'timestamp')::timestamptz, p_raw ->> 'event_type',
          p_raw ->> 'job_id', p_raw ->> 'part_id', p_raw ->> 'customer_id',
          p_raw ->> 'material', p_raw ->> 'machine_id',
          (p_raw ->> 'quantity')::int, v_md)
  ON CONFLICT (event_id) DO NOTHING
  RETURNING * INTO v_event;

  IF NOT FOUND THEN
    RETURN false;          -- duplicate id: dropped before any counter moves
  END IF;

  -- 3. the projection
  PERFORM apply_event(v_event);
  RETURN true;
END $$;

-- ---------------------------------------------------------------------
-- @replay
-- The repair path, and the reason stored counters are safe to keep. The
-- ledger is untouched: jobs is emptied and rebuilt from it, in occurred_at
-- order because the counters and the status fold depend on order. Run it
-- after changing anything in apply_event, or to prove the projection still
-- agrees with the events.
--
-- 19,519 events is a single-digit-second rebuild. Past a few million, replay
-- per facility or per job range rather than whole-table.
-- ---------------------------------------------------------------------
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
CREATE VIEW dq_double_completions AS          -- job_0293 in the sample
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
  SELECT machine_id,
         count(*) FILTER (WHERE (metadata ->> 'cycle_time_seconds')::int >= 1860) AS at_ceiling,
         count(*) AS cycles
  FROM events WHERE event_type = 'cycle_completed' GROUP BY 1;

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
  SELECT 'facility', metadata ->> 'facility', count(*)
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
