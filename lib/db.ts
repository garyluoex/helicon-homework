import pg from "pg";

// One pool per server instance, on the pooled connection string. Page renders
// issue several queries; opening a client per query would pay the ~600ms
// connect each time.
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

export async function query<T>(text: string, values: unknown[] = []): Promise<T[]> {
  const { rows } = await pool.query(text, values);
  return rows as T[];
}

export async function one<T>(text: string, values: unknown[] = []): Promise<T> {
  const rows = await query<T>(text, values);
  return rows[0];
}
