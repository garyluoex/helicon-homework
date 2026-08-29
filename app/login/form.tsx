"use client";

import { useActionState } from "react";
import { signIn } from "./actions";

export default function LoginForm() {
  const [error, action, pending] = useActionState(signIn, undefined);

  return (
    <form action={action} className="card" style={{ width: 340, gap: "var(--space-4)", padding: "var(--space-8)" }}>
      <div>
        <div className="card-kicker">Sign in</div>
        <div style={{ fontFamily: "var(--font-heading)", fontSize: 27, lineHeight: 1.1 }}>Operations console</div>
      </div>
      <div className="field">
        <label htmlFor="em">Email</label>
        <input className="input" id="em" name="email" type="email" defaultValue="admin@helicon.local" required />
      </div>
      <div className="field">
        <label htmlFor="pw">Password</label>
        <input className="input" id="pw" name="password" type="password" required />
      </div>
      {error && (
        <div role="alert" style={{ fontSize: 12, lineHeight: 1.5, color: "var(--color-accent-800)", border: "1px solid var(--color-accent)", padding: "var(--space-2) var(--space-3)" }}>
          {error}
        </div>
      )}
      <button className="btn btn-primary btn-block" type="submit" disabled={pending}>
        {pending ? "Checking..." : "Enter console"}
      </button>
      <div style={{ fontSize: 11, lineHeight: 1.5, color: "color-mix(in srgb, var(--color-text) 50%, transparent)" }}>
        One shared credential gates the console. Per-user sign-in and operator badge scoping are not wired up yet.
      </div>
    </form>
  );
}
