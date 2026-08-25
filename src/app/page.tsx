export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      <p className="font-mono text-xs uppercase tracking-widest text-zinc-500">
        TripOS — build in progress
      </p>
      <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
        AI Travel Operations &amp; Intelligence Platform
      </h1>
      <p className="max-w-md text-sm text-zinc-500">
        The command center UI lands in Phase 21. See{" "}
        <code className="rounded bg-black/[.06] px-1.5 py-0.5 font-mono text-xs dark:bg-white/[.08]">
          docs/BUILD_PROGRESS.md
        </code>{" "}
        for current status, or check{" "}
        <a href="/api/health" className="underline underline-offset-2">
          /api/health
        </a>{" "}
        for a live status readout.
      </p>
    </main>
  );
}
