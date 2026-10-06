"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, FormMessage } from "@/components/ui";

/**
 * Client island: posts to /api/trips with the authenticated session cookie
 * and navigates to the new trip's detail page on success.
 */
export function NewTripForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;

    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      });
      const body = await res.json();
      if (!res.ok || body.error) {
        throw new Error(body.error?.message ?? "Failed to create trip.");
      }
      router.push(`/trips/${body.data.trip.id}`);
      router.refresh();
    } catch (error) {
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Failed to create trip.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 space-y-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-sand-700 dark:text-sand-600">Title</span>
        <input
          name="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          type="text"
          required
          maxLength={200}
          placeholder="e.g. Lisbon October Escape"
          className="h-10 w-full rounded-md border border-sand-300 bg-white px-3 text-sm outline-none transition placeholder:text-sand-600 focus:border-navy-500 focus:ring-2 focus:ring-navy-200/60 dark:border-sand-200 dark:bg-sand-50"
        />
      </label>
      <Button type="submit" busy={busy} disabled={!title.trim()} className="w-full">
        {busy ? "Creating…" : "Create trip"}
      </Button>
      <FormMessage message={message} />
    </form>
  );
}
