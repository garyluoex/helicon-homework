import pg from "pg";

// Read live on every request rather than freezing the list into the build.
export const dynamic = "force-dynamic";

export default async function Page() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const { rows } = await client.query<{ name: string; kind: string }>(
    `select table_name as name, table_type as kind from information_schema.tables
     where table_schema = 'public' order by table_type, table_name`
  );
  await client.end();

  return (
    <main>
      <h1>Tables</h1>
      <ul>
        {rows.map((r) => (
          <li key={r.name}>
            {r.name} <small>{r.kind === "VIEW" ? "view" : "table"}</small>
          </li>
        ))}
      </ul>
    </main>
  );
}
