import { cookies } from "next/headers";
import { one } from "@/lib/db";
import { COOKIE_NAME, verify } from "@/lib/session";

/** The two values every console page's header needs, in one round trip. */
export async function chrome() {
  const userId = await verify((await cookies()).get(COOKIE_NAME)?.value);
  return one<{ user_name: string; feed_end: string }>(
    `select coalesce((select coalesce(display_name, email::text) from users where user_id = $1),
                     'Signed in') as user_name,
            (select to_char(max(occurred_at), 'YYYY-MM-DD') from events) as feed_end`,
    [userId]
  );
}
