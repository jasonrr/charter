/**
 * The MCP surface: two tools over the whole verb catalog.
 *
 * Verb discovery stays on demand through `verbs.list` rather than being
 * expanded into one MCP tool per verb. That is the whole point of charter — a
 * client pays for two tool definitions, not fifty, and the catalog it sees is
 * already filtered to what its caller is allowed to run.
 *
 * Dropped from the stdio proxy's four tools:
 *  - charter_login: OAuth at install replaces it (§4.2).
 *  - charter_connect_hubspot: it opens a loopback listener on 127.0.0.1, which a
 *    remote gateway has no equivalent of. Out of scope for B (§4.6); verbs that
 *    need a HubSpot identity keep returning hs_identity_required.
 *  - args_path / out_path: they read and write the CLIENT's disk. A remote
 *    server cannot. Large payloads move by reference instead (§4.5).
 */
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { callCore, type CoreConfig } from "./core.js";
import { parseResultRef, RESULT_URI_PREFIX } from "./results.js";

export const TOOL_READ_NAME = "charter_read";
export const TOOL_CALL_NAME = "charter_call";

export const TOOL_INPUT_SHAPE = {
  verb: z.string().describe("e.g. verbs.list or data.warehouse.query"),
  args: z.record(z.unknown()).optional().describe("verb arguments (default {})"),
};

export const TOOL_READ_DESCRIPTION =
  "READ-ONLY view of your data — use this (NOT charter_call) for ANY data " +
  "question. Safe to always-allow: the server rejects write verbs sent here " +
  "(returns write_in_read_tool). Call `verbs.list` first to discover available " +
  "verbs, then use read verbs like `data.warehouse.schema` / " +
  "`data.warehouse.query` or `data.posthog.schema` / `data.posthog.query` — each " +
  "has a schema verb that returns the table catalog plus an analyst guide with " +
  "dialect gotchas and business definitions. Unsure which resource? Call BOTH " +
  "`.schema` verbs — they're cheap and each guide cross-links the other. " +
  "To DRAFT or PUBLISH content, use charter_call instead. Oversized results " +
  "come back as a resource_link (charter://result/<id>) — read the linked " +
  "resource only if the inline summary is not enough.";

export const TOOL_CALL_DESCRIPTION =
  "Call a charter verb. Pass the verb name and its args; returns the engine's " +
  "JSON response verbatim. Authentication is added by this server — NEVER put " +
  "secrets in args. Call `verbs.list` first to discover exactly which verbs you " +
  "can use, each with a one-line summary and read/write flag (it's always " +
  "callable and shows only your verbs). On failure the result is the string " +
  "'HTTP <status>: {...\"error\":\"<code>\"...}' — match on the <code> " +
  "(e.g. denied = your account lacks scope for that verb; confirm_required = " +
  "pass confirm:true for irreversible verbs). Large inputs go by reference: " +
  "pass an id or URI the " +
  "verb dereferences, never a large inline body. Oversized results come back " +
  "as a resource_link (charter://result/<id>) — read the linked resource " +
  "only if the inline summary is not enough.";

/**
 * Annotations, carried over verbatim from the removed stdio proxy (see git
 * history).
 *
 * They live beside the descriptions because they say the same thing in the
 * other register: TOOL_READ_DESCRIPTION tells a human charter_read is "safe to
 * always-allow", and readOnlyHint is what lets a client act on that claim
 * without parsing English. Change one, change the other.
 */
export const TOOL_READ_ANNOTATIONS: ToolAnnotations = {
  title: "Read charter data (read-only)",
  readOnlyHint: true,
  openWorldHint: false,
};

export const TOOL_CALL_ANNOTATIONS: ToolAnnotations = {
  title: "Call charter verb",
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

// `text?: undefined` on the resource_link variant isn't part of the wire
// shape — it's there so `content[N].text` (existing tests, indexing into a
// now-heterogeneous array) still typechecks without narrowing first.
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "resource_link"; uri: string; name: string; description: string; mimeType: string; text?: undefined };

type ToolResult = {
  content: ContentBlock[];
  isError: boolean;
};

export async function handleTool(
  fetchImpl: typeof fetch,
  cfg: CoreConfig,
  toolName: string,
  args: { verb?: string; args?: Record<string, unknown> },
  actorToken: string,
  traceparent?: string,
): Promise<ToolResult> {
  if (toolName !== TOOL_READ_NAME && toolName !== TOOL_CALL_NAME) {
    return {
      content: [{ type: "text", text: `unknown tool: ${toolName}` }],
      isError: true,
    };
  }
  const { text, isError } = await callCore(
    fetchImpl,
    cfg,
    args.verb ?? "",
    args.args ?? {},
    { readOnly: toolName === TOOL_READ_NAME, actorToken, traceparent },
  );
  // §4.5 resource-link-out: core offloaded this result; hand the model a
  // reference, not bytes. Only on a clean success — an error body that merely
  // looks like a ref must stay an error.
  const ref = !isError ? parseResultRef(text) : null;
  if (ref) {
    return {
      content: [
        {
          type: "text",
          text:
            `Result is ${ref.bytes} bytes — too large to inline. ` +
            `It is available as a resource if you need the full body; ` +
            `it expires, and re-running the verb regenerates it.`,
        },
        {
          type: "resource_link",
          uri: RESULT_URI_PREFIX + ref.id,
          name: `${args.verb ?? "verb"} result`,
          description: "Full verb result, offloaded by size. Read only if the inline summary is not enough.",
          mimeType: ref.mime,
        },
      ],
      isError: false,
    };
  }
  return { content: [{ type: "text", text }], isError };
}
