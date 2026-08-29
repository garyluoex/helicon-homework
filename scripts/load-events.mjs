// Loads data/manufacturing_events.jsonl into the database.
//
// The whole load is one transaction that starts by truncating, so a run either
// replaces the contents entirely or leaves them untouched. Events go over in
// batches through process_events, which applies them server-side in array
// order; only the events that were not plainly applied come back.
import { readFileSync } from "node:fs";
import pg from "pg";

const FILE = "data/manufacturing_events.jsonl";
const BATCH_SIZE_EVENTS = 500;

const lines = readFileSync(FILE, "utf8").split("\n").filter(Boolean);
const events = lines.map((line, i) => {
  try {
    return JSON.parse(line);
  } catch (err) {
    throw new Error(`${FILE} line ${i + 1} is not valid JSON: ${err.message}`);
  }
});

const client = new pg.Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
await client.connect();
const started_ms = Date.now();
const exceptions = [];

try {
  await client.query("begin");
  await client.query("truncate events, jobs, customers, parts, machines");
  for (let i = 0; i < events.length; i += BATCH_SIZE_EVENTS) {
    const batch = events.slice(i, i + BATCH_SIZE_EVENTS);
    const { rows } = await client.query(
      "select event_id, outcome from process_events($1::jsonb)",
      [JSON.stringify(batch)]
    );
    exceptions.push(...rows);
  }
  await client.query("commit");
} catch (err) {
  await client.query("rollback");
  throw err;
}

const of = (outcome) => exceptions.filter((r) => r.outcome === outcome).map((r) => r.event_id);
const restated = of("restated");
const unchanged = of("unchanged");
const elapsed_seconds = ((Date.now() - started_ms) / 1000).toFixed(1);

console.log(`${events.length} events in ${Math.ceil(events.length / BATCH_SIZE_EVENTS)} batches, ${elapsed_seconds}s`);
console.log(`  applied   ${events.length - exceptions.length}`);
console.log(`  restated  ${restated.length}  ${restated.join(" ")}`);
console.log(`  unchanged ${unchanged.length}  ${unchanged.join(" ")}`);

const { rows } = await client.query(
  `select 'events' as t, count(*) from events
   union all select 'jobs', count(*) from jobs
   union all select 'customers', count(*) from customers
   union all select 'parts', count(*) from parts
   union all select 'machines', count(*) from machines`
);
console.log(rows.map((r) => `  ${r.t.padEnd(10)}${r.count}`).join("\n"));
await client.end();
