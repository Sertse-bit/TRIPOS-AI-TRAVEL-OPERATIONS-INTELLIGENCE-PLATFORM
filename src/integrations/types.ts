import { ProviderError } from "@/shared/errors";

/**
 * Marker interface every concrete provider satisfies. Deliberately
 * minimal — it exists so the domain layer can log/report on "which
 * provider answered this" (see providerName) without depending on any
 * vendor-specific detail, per the brief's "domain layer must not depend
 * directly on vendor SDK details."
 */
export interface ExternalProvider {
  readonly providerName: string;
}

/**
 * Shared fetch wrapper for real adapters. Does exactly one job: turn a
 * non-2xx or network-level failure into a ProviderError carrying the
 * provider's name, so every adapter fails the same documented way.
 *
 * Deliberately NOT doing retry/backoff/circuit-breaking here — that's
 * general resilience machinery that wraps *any* provider call uniformly,
 * and belongs to Phase 6, not to this abstraction layer. This function
 * makes exactly one HTTP attempt.
 */
export async function fetchJson(
  providerName: string,
  url: string,
  init?: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    throw new ProviderError(providerName, `Network request to ${providerName} failed.`, {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text().catch(() => undefined);
    }
    throw new ProviderError(
      providerName,
      `${providerName} responded with HTTP ${response.status}.`,
      { status: response.status, body },
    );
  }

  try {
    return await response.json();
  } catch (cause) {
    throw new ProviderError(providerName, `${providerName} returned a non-JSON response.`, {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
