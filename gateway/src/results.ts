/**
 * Resource-link-out (§4.5): detect core's result_ref envelope and dereference
 * it through core with the caller's actor token.
 *
 * The dereference re-authorizes: result.read is producer-only in core, so a
 * leaked charter://result/<id> URI is useless to anyone but the caller that
 * produced it — the reference is unguessable AND re-checked, not a capability.
 *
 * The fetch cap is larger than the tool-call cap because resource contents go
 * to the CLIENT on request, not unconditionally into a model's context — but
 * it is still a cap, and redaction still runs before the cut (core.ts
 * readCapped, at any maxBytes). A result over the cap errors honestly.
 */
import { callCore, type CoreConfig, type CoreResult } from "./core.js";

export const RESULT_FETCH_MAX_BYTES = 16 << 20; // 16 MiB

export const RESULT_URI_PREFIX = "charter://result/";

/** Shared contract with core's results.py _ID_RE — widen both or neither. */
export const RESULT_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

export type ResultRef = { id: string; bytes: number; mime: string };

/** Core's offload envelope, or null for anything else. Strict on the id —
 * this string becomes a URI the client will echo back. */
export function parseResultRef(text: string): ResultRef | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const ref = (parsed as { result_ref?: unknown }).result_ref;
  if (typeof ref !== "object" || ref === null) return null;
  const { id, bytes, mime } = ref as { id?: unknown; bytes?: unknown; mime?: unknown };
  if (typeof id !== "string" || !RESULT_ID_RE.test(id)) return null;
  return {
    id,
    bytes: typeof bytes === "number" ? bytes : 0,
    mime: typeof mime === "string" ? mime : "application/json",
  };
}

/** Fetch one offloaded result back through core. Resolves to the stored
 * envelope string in .text; every failure is an isError CoreResult. */
export async function readResult(
  fetchImpl: typeof fetch,
  cfg: CoreConfig,
  id: string,
  actorToken: string,
): Promise<CoreResult> {
  if (!RESULT_ID_RE.test(id)) return { text: "bad result id", isError: true };
  const res = await callCore(fetchImpl, cfg, "result.read", { id }, {
    readOnly: true,
    actorToken,
    maxBytes: RESULT_FETCH_MAX_BYTES,
  });
  if (res.isError) return res;
  let content: unknown;
  try {
    content = (JSON.parse(res.text) as { content?: unknown }).content;
  } catch {
    return { text: "unparseable result.read response", isError: true };
  }
  if (typeof content !== "string") {
    return { text: "unparseable result.read response", isError: true };
  }
  return { text: content, isError: false };
}
