"use client";
// Dev-comments in a Next.js app (App Router or Pages). Keep this file NEXT TO
// client.js — the relative import below is what makes the copy in a project
// self-contained. Render <DevComments /> once, in the root layout:
//
//   import { DevComments } from "../../integrations/dev-comments/next";
//   …<body>{children}<DevComments /></body>
//
// The API is the standalone server, because a Next dev server has no Vite
// plugin hook to write the file for it:
//
//   node integrations/dev-comments/serve.mjs --port 4777
//
// Nothing ships: the import sits behind a production check, so the bundler
// drops it, and the component renders null either way.
import { useEffect } from "react";

type Opts = {
  /** Where serve.mjs listens. Change only if the port is taken. */
  route?: string;
  /** Which bottom corner the Comment button sits in. */
  side?: "left" | "right";
  bottom?: number;
  bottomMobile?: number;
  /** Pin colour — pick one that clashes with the site. */
  accent?: string;
  /** Only these localStorage keys are captured (a design panel's prefix). */
  storagePrefixes?: string[];
  author?: string;
};

export function DevComments(opts: Opts = {}) {
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    let live = true;
    import("./client.js").then((m) => {
      if (live) m.mount({ route: "http://localhost:4777/__dev-comments", ...opts });
    });
    return () => {
      live = false;
    };
    // The overlay mounts once per page load; options are read at mount time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
