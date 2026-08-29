"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE_NAME } from "@/lib/session";

export async function signOut() {
  (await cookies()).delete(COOKIE_NAME);
  redirect("/login");
}
