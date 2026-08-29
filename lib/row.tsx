"use client";

// The design makes a whole table row the click target, not just the id cell.
// A click that landed on a link inside the row is left to that link, so the
// customer and part cells still reach their own pages.

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

export default function ClickRow({ href, children }: { href: string; children: ReactNode }) {
  const router = useRouter();
  return (
    <tr
      style={{ cursor: "pointer" }}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a")) return;
        router.push(href);
      }}
    >
      {children}
    </tr>
  );
}
