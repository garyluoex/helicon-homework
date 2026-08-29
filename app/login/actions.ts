"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { one } from "@/lib/db";
import { COOKIE_NAME, issue } from "@/lib/session";

export async function signIn(_prev: string | undefined, form: FormData) {
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");

  const user = await one<{ user_id: string }>(
    "select user_id from users where email = $1", [email]
  );
  if (!user || password !== process.env.APP_PASSWORD) {
    return "That email and password do not match an account.";
  }

  (await cookies()).set(COOKIE_NAME, await issue(user.user_id), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  });
  redirect("/");
}
