"use client";

import { useState, type FormEvent } from "react";
import { Button, Card, InlineError, SectionHeading, apiRequest } from "@/components/ui";

/**
 * Phase 22 — the Command Bar. A client island on the trip detail page:
 * one natural-language command posts to POST /api/trips/:id/ask, and the
 * structured answer comes back with the real tool-call trail it was
 * grounded against. Nothing here is computed locally — every number and
 * status rendered is a value the API returned from a real tool call.
 */

interface CommandEvidence {
  source: string;
  observation: string;
}

interface CommandAnswer {
  command: string;
  decision: string;
  evidence: CommandEvidence[];
  reasoningSummary: string;
  recommendationText: string;
  confidence: number;
  dataGaps: string[];
  toolCalls: Array<{ name: string; success: boolean }>;
  toolCallsUsed: number;
  durationMs: number;
  tokensUsed: number;
}

const EXAMPLES = [
  "Is anything about this trip off track right now?",
  "What's the weather at my destinations?",
  "Are we over budget?",
  "What does my risk score say and why?",
  "What should I know before my first flight?",
];

function confidencePercent(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

export function CommandBar({ tripId, aiEnabled }: { tripId: string; aiEnabled: boolean }) {
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CommandAnswer | null>(null);

  async function runCommand(value: string) {
    const trimmed = value.trim();
    if (!trimmed || busy) return;

    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const data = await apiRequest<CommandAnswer>(`/api/trips/${tripId}/ask`, {
        method: "POST",
        body: JSON.stringify({ command: trimmed }),
      });
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runCommand(command);
  }

  return (
    <Card className="mt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionHeading>Command bar</SectionHeading>
        <span className="text-xs text-sand-600">Answers cite the tool calls they came from</span>
      </div>
      <p className="mt-1.5 text-sm text-sand-600">
        Ask a question or give an instruction about this trip. The answer is composed only from
        tools that read this trip&apos;s real data — live flight status, weather, currency, your
        documents, the itinerary, and the deterministic risk score — and every claim lists the check
        it came from. It cannot change anything on the trip and will not invent a detail a provider
        could not confirm.
      </p>

      {!aiEnabled && (
        <p className="mt-3 rounded-lg border border-warn-100 bg-warn-100/40 p-3 text-sm text-warn-700">
          The command bar is unavailable because no Anthropic API key is configured — it will not
          fabricate an answer without a model. Everything else on this page works without it.
        </p>
      )}

      <form onSubmit={handleSubmit} className="mt-3 flex flex-col gap-2 sm:flex-row">
        <label className="flex-1">
          <span className="sr-only">Command</span>
          <input
            type="text"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            disabled={!aiEnabled || busy}
            maxLength={500}
            placeholder="e.g. Is my flight on time, and does the weather threaten anything?"
            className="h-10 w-full rounded-md border border-sand-300 bg-white px-3 text-sm text-foreground outline-none transition placeholder:text-sand-600 focus:border-navy-500 focus:ring-2 focus:ring-navy-200/60 disabled:cursor-not-allowed disabled:opacity-60 dark:border-sand-200 dark:bg-sand-50"
          />
        </label>
        <Button type="submit" busy={busy} disabled={!aiEnabled || command.trim().length === 0}>
          {busy ? "Working…" : "Run"}
        </Button>
      </form>

      {aiEnabled && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              disabled={busy}
              onClick={() => {
                setCommand(example);
                void runCommand(example);
              }}
              className="rounded-full border border-sand-200 px-2.5 py-1 text-xs text-sand-600 transition hover:border-navy-500 hover:text-navy-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {example}
            </button>
          ))}
        </div>
      )}

      {busy && (
        <p role="status" className="mt-3 text-sm text-sand-600">
          Running real checks against this trip&apos;s providers — this can take a few seconds…
        </p>
      )}

      <InlineError error={error ? new Error(error) : null} />

      {result && (
        <div role="status" aria-live="polite" className="mt-4 space-y-3">
          <div className="rounded-lg border border-navy-200 bg-navy-100/60 p-4 dark:border-navy-200 dark:bg-navy-100/60">
            <p className="text-base font-semibold text-navy-950 dark:text-sand-800">
              {result.decision}
            </p>
            <p className="mt-1 text-xs text-sand-600">
              command: “{result.command}” · confidence {confidencePercent(result.confidence)}
            </p>
            <div
              className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-sand-200"
              aria-hidden="true"
            >
              <div
                className="h-full rounded-full bg-navy-600"
                style={{ width: confidencePercent(result.confidence) }}
              />
            </div>
          </div>

          <div className="rounded-lg border border-sand-200 p-4 dark:border-sand-200">
            <p className="text-xs font-semibold uppercase tracking-wide text-sand-600">
              Recommended action
            </p>
            <p className="mt-1 text-sm text-navy-950 dark:text-sand-800">
              {result.recommendationText}
            </p>
            <p className="mt-2 text-sm text-sand-700 dark:text-sand-600">
              {result.reasoningSummary}
            </p>
          </div>

          {result.evidence.length > 0 && (
            <div className="rounded-lg border border-sand-200 p-4 dark:border-sand-200">
              <p className="text-xs font-semibold uppercase tracking-wide text-sand-600">
                Evidence — what was actually checked
              </p>
              <ul className="mt-2 space-y-1.5">
                {result.evidence.map((item, index) => (
                  <li key={`${item.source}-${index}`} className="text-sm">
                    <span className="mr-2 rounded bg-navy-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-navy-700">
                      {item.source}
                    </span>
                    <span className="text-navy-950 dark:text-sand-800">{item.observation}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.dataGaps.length > 0 && (
            <div className="rounded-lg border border-warn-100 bg-warn-100/40 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-warn-700">
                Couldn&apos;t be verified
              </p>
              <ul className="mt-1 list-inside list-disc space-y-0.5 text-sm text-warn-700">
                {result.dataGaps.map((gap) => (
                  <li key={gap}>{gap}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-sand-600">
            <span>
              {result.toolCallsUsed} tool call{result.toolCallsUsed === 1 ? "" : "s"} ·{" "}
              {(result.durationMs / 1000).toFixed(1)}s
            </span>
            <span className="flex flex-wrap items-center gap-1.5">
              {result.toolCalls.map((call, index) => (
                <span
                  key={`${call.name}-${index}`}
                  className={`rounded px-1.5 py-0.5 font-mono ${
                    call.success ? "bg-ok-100 text-ok-700" : "bg-alert-100 text-alert-700"
                  }`}
                  title={call.success ? "returned data" : "failed — recorded in the answer's gaps"}
                >
                  {call.name} {call.success ? "✓" : "✗"}
                </span>
              ))}
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}
