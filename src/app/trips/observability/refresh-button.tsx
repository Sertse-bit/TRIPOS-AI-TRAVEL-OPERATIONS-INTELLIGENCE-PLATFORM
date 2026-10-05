"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@/components/ui";

/**
 * Re-runs the server component's data assembly (a fresh SELECT 1, PING,
 * and health read). `router.refresh()` inside a transition keeps
 * `isPending` true until the refreshed server payload has arrived —
 * there is no fake timer here.
 */
export function RefreshObservabilityButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      variant="secondary"
      disabled={isPending}
      onClick={() => startTransition(() => router.refresh())}
    >
      {isPending ? "Checking…" : "Re-check now"}
    </Button>
  );
}
