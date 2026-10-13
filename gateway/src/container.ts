import { Container } from "@cloudflare/containers";
import type { Env } from "./index";

export const CORE_URL = "https://charter-core.internal/";
const PREFIX = "CORE_";

/** Container env = every CORE_* Worker var/secret (prefix stripped) + three fixed values. */
export function coreEnv(env: Record<string, unknown>, googleClientId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const name = k.slice(PREFIX.length);
    if (!k.startsWith(PREFIX) || !name) continue;
    if (typeof v === "string") out[name] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[name] = JSON.stringify(v);
    // Plain JSON vars (e.g. CORE_CHARTER_CONNECT_PROVIDERS); bindings are class instances.
    else if (Array.isArray(v) || (v && Object.getPrototypeOf(v) === Object.prototype)) out[name] = JSON.stringify(v);
  }
  out.PORT = "8080";
  out.CHARTER_BACKEND = "cloudflare";
  out.GOOGLE_OAUTH_CLIENT_ID = googleClientId;
  return out;
}

/** Instance name = hash of the env. A changed secret → a new name → a fresh container. */
export async function instanceName(vars: Record<string, string>): Promise<string> {
  const canon = JSON.stringify(Object.keys(vars).sort().map((k) => [k, vars[k]]));
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canon));
  const hex = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `core-${hex.slice(0, 16)}`;
}

export class CharterCore extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";

  /**
   * Start (if needed) with the env the calling Worker hashed into this instance's
   * name, then forward. Not this DO's own env: during a deploy the Worker and the
   * DO can run different versions, and a container started from a stale env keeps
   * the old keys for its whole life under the new name.
   */
  async fetchWithEnv(request: Request, vars: Record<string, string>): Promise<Response> {
    this.envVars = vars;
    return this.fetch(request);
  }
}

type CoreEnv = { CHARTER_CORE?: DurableObjectNamespace<CharterCore>; GOOGLE_CLIENT_ID: string };

/** A fetch that targets the container when the binding exists, else the global fetch. */
export async function coreFetch(env: CoreEnv): Promise<typeof fetch> {
  const ns = env.CHARTER_CORE;
  if (!ns) return fetch;
  const vars = coreEnv(env as unknown as Record<string, unknown>, env.GOOGLE_CLIENT_ID);
  const stub = ns.getByName(await instanceName(vars));
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    stub.fetchWithEnv(new Request(input, init), vars)) as typeof fetch;
}
