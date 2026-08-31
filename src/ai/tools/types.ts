import { z } from "zod";

/**
 * Every field here comes from the authenticated request, never from the
 * LLM's tool-call arguments. This is the actual security boundary: a
 * tool's input schema can (and does) include a tripId, because that's
 * how the model tells us *which* trip it means -- but which *user* is
 * making the call is never something the model gets to specify. Even if
 * a prompt injection convinced the model to call get_trip with someone
 * else's tripId, authorization runs against the real userId injected
 * here, and the ownership check (requireOwnedTrip, Phase 7) fails closed
 * regardless of what the model asked for.
 */
export interface ToolContext {
  userId: string;
  requestId: string;
}

export type ToolResult<T> =
  { success: true; data: T } | { success: false; error: { code: string; message: string } };

/**
 * TInput/TOutput default to `any`, not `unknown`, specifically so a
 * heterogeneous registry (registry.ts) can hold many ToolDefinitions
 * with different concrete input/output types under one uniform type.
 * `execute`'s parameter position is contravariant, so
 * `ToolDefinition<{tripId: string}, X>` is NOT a subtype of
 * `ToolDefinition<unknown, X>` -- an earlier version used `unknown` here
 * and every tool failed to type-check against the registry's map type
 * (caught by `pnpm typecheck`). `any` is the standard, deliberate escape
 * hatch for exactly this "type-erased at storage, runtime-checked at
 * the boundary" pattern -- real safety comes from each tool's own
 * `inputSchema.safeParse()` in registry.ts's `callTool`, not from the
 * stored type here.
 */
export interface ToolDefinition<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberate, see comment above
  TInput = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberate, see comment above
  TOutput = any,
> {
  name: string;
  /** Shown to the LLM as part of its tool schema -- describe what it does and when to use it. */
  description: string;
  inputSchema: z.ZodType<TInput>;
  execute: (input: TInput, context: ToolContext) => Promise<TOutput>;
}

/**
 * Helper for defining a tool with full type inference from its Zod
 * schema, so `execute`'s `input` parameter is typed automatically rather
 * than needing a separate manually-written interface kept in sync by hand.
 *
 * The `as` assertion at the return is narrow and justified, not a way to
 * paper over a real mismatch: `definition`'s shape already structurally
 * satisfies `ToolDefinition<z.infer<TSchema>, TOutput>` by construction
 * (every field is declared with exactly that type in the parameter),
 * but Zod 4's generic structure makes that hard for TS to *prove*
 * automatically here -- this asserts what the parameter types already
 * guarantee, not something unverified.
 */
export function defineTool<TSchema extends z.ZodType, TOutput>(definition: {
  name: string;
  description: string;
  inputSchema: TSchema;
  execute: (input: z.infer<TSchema>, context: ToolContext) => Promise<TOutput>;
}): ToolDefinition<z.infer<TSchema>, TOutput> {
  return definition as ToolDefinition<z.infer<TSchema>, TOutput>;
}
