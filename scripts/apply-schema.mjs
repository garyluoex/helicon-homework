// Applies designs/schema.sql to the Neon database (DATABASE_URL_UNPOOLED, the direct connection
// rather than the pooler, since this is DDL). Expects a fresh database.
import { readFileSync } from "node:fs";
import pg from "pg";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
await client.connect();
await client.query(readFileSync("designs/schema.sql", "utf8"));
const { rows } = await client.query(
  "select table_name from information_schema.tables where table_schema = 'public' order by table_name"
);
console.log(rows.map((r) => r.table_name).join("\n"));
await client.end();
