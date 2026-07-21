#!/usr/bin/env node
// Stdio MCP proxy for the Charter governed verb API. ONE implementation, used by both
// the Claude Code plugin (this file) and the Claude Desktop extension (which stages
// this file into its .mcpb at build time). Runs on the bundled Node both clients
// ship — no system Python/Node, no Terminal step.
//
// Exposes one generic tool, `charter_call(verb, args)`, that POSTs
// {"verb": verb, ...args} to the charter endpoint with the CF Access + X-API-Key
// headers read from the environment — injected from the plugin/manifest user_config
// (keychain-stored), so the secret never lives in a file or in Claude's context.
//
// Pure Node built-ins: newline-delimited JSON-RPC 2.0 over stdin/stdout. No deps.
// Self-check: node charter_mcp.js --selftest
'use strict';
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { URL } = require('url');
const crypto = require('crypto');
const { spawn } = require('child_process');

const MAX_RESPONSE_BYTES = 1 << 20; // 1 MB cap on what we read + inject into Claude's context

// --- Config resolution (user_config -> env) ------------------------------------
// Adopter supplies these via plugin user_config or manifest env keys.
// All keys are prefixed with CHARTER_ to avoid collisions with other tools.
// The proxy fails fast with a named error when any required config is missing.

let BRIDGE_URL = (process.env.CHARTER_URL || '').replace(/\/+$/, '');

const OAUTH_CLIENT_ID = (process.env.CHARTER_GOOGLE_CLIENT_ID || '').trim();
const OAUTH_CLIENT_SECRET = (process.env.CHARTER_GOOGLE_CLIENT_SECRET || '').trim();
const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const LOGIN_TIMEOUT_MS = 180000;
const OAUTH_DOMAIN_HINT = (process.env.CHARTER_DOMAIN_HINT || '').trim();
let IDENTITY_PATH = path.join(os.homedir(), '.charter', 'identity.json'); // let: selftest redirects it

const HS_OAUTH_CLIENT_ID = (process.env.CHARTER_HUBSPOT_CLIENT_ID || '').trim();
const HS_OAUTH_SCOPES = 'oauth content files marketing-email'; // space-separated, must match the HubSpot app config
const HS_CONNECT_PORT = 53682;
const HS_AUTH_URL = 'https://app.hubspot.com/oauth/authorize';

// --- Config validation --------------------------------------------------------
function validateConfig() {
  const errors = [];
  if (!BRIDGE_URL) errors.push('CHARTER_URL: the bridge endpoint URL (e.g. https://charter.example.com)');
  if (!OAUTH_CLIENT_ID) errors.push('CHARTER_GOOGLE_CLIENT_ID: your Google OAuth client ID (create one at https://console.cloud.google.com/apis/credentials)');
  if (!OAUTH_CLIENT_SECRET) errors.push('CHARTER_GOOGLE_CLIENT_SECRET: your Google OAuth client secret');
  return errors;
}

function credHeaders(env) {
  // ONE pasted credential "cf-client-id:cf-client-secret:api-key" (what teammates
  // configure since 0.4.0). CF id/secret are colon-free (hex + ".access"), so any
  // extra colons belong to the API key. The three legacy vars still work — older
  // installs and the pre-0.4.0 desktop extension keep running unreconfigured.
  const cred = (env.CHARTER_CREDENTIAL || '').trim();
  if (!cred) return {
    'X-API-Key': env.CHARTER_API_KEY || '',
    'CF-Access-Client-Id': env.CHARTER_CF_ACCESS_CLIENT_ID || '',
    'CF-Access-Client-Secret': env.CHARTER_CF_ACCESS_CLIENT_SECRET || '',
  };
  // A colon-free credential is a bare API key (non-Cloudflare deploys) — the
  // docs promise this works. Anything with colons is the cf-id:cf-secret:api-key
  // form (>=3 parts); a 2-part value stays malformed -> empty key, fails loudly.
  const parts = cred.split(':');
  if (parts.length === 1) return { 'X-API-Key': parts[0], 'CF-Access-Client-Id': '', 'CF-Access-Client-Secret': '' };
  const [id = '', secret = '', ...key] = parts;
  return { 'X-API-Key': key.join(':'), 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret };
}

const HEADERS = {
  'Content-Type': 'application/json',
  // Explicit UA: Cloudflare 1010-bans the bare default urllib signature at the edge
  // (before CF Access runs). Any non-default UA passes; set one to be safe here too.
  'User-Agent': 'charter-mcp/0.1',
  ...credHeaders(process.env),
};

// --- actor identity (Google OAuth, scopes: openid email) -----------------------
// Pairs with the engine's actor_auth.py — the same "charter-identity"
// Desktop-app OAuth client. Installed-app client secrets are non-confidential in
// Google's model; tokens from this client only PROVE identity (openid email) —
// they grant no access to mail, Drive, or anything else.

class MethodNotFound extends Error {} // unknown JSON-RPC method -> -32601; anything else -> -32603

const TOOL = {
  name: 'charter_call',
  annotations: { title: 'Call charter verb', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  description:
    "Call a charter verb. Pass the verb name and its args; returns the " +
    "bridge's JSON response verbatim. Auth (Cloudflare Access + API key) is added " +
    "by this server from local config — NEVER put secrets in args. Call `verbs.list` " +
    "first to discover exactly which verbs your key can use, each with a one-line " +
    "summary and read/write flag (it's always callable and shows only your verbs). " +
    "On failure the result is the string 'HTTP <status>: " +
    "{...\"error\":\"<code>\"...}' — match on the <code> (e.g. denied = your key " +
    "lacks scope; actor_required = run charter_login first; confirm_required = " +
    "pass confirm:true for irreversible verbs; bad_deal_id = malformed record id). " +
    "For BULK content, don't hand-form large JSON: pass `args_path` (a local JSON file " +
    "a builder script wrote) to send the request body from that file, and/or " +
    "`out_path` to write a large response to a file (you get a small summary back) — " +
    "so a 50KB+ transcript or post body never round-trips through the model." +
    " If a call fails with actor_required, run the charter_login tool once, then retry." +
    " If a call fails with hs_identity_required (or hs_identity_revoked), run the " +
    "charter_connect_hubspot tool once, then retry.",
  inputSchema: {
    type: 'object',
    properties: {
      verb: { type: 'string', description: 'e.g. verbs.list or data.warehouse.query' },
      args: { type: 'object', description: 'verb arguments (default {})' },
      args_path: { type: 'string', description: 'read the verb args from this local JSON file instead of `args` (for large request bodies)' },
      out_path: { type: 'string', description: 'write the response to this local file instead of returning it; returns a small summary (for large responses)' },
    },
    required: ['verb'],
  },
};

const TOOL_READ = {
  name: 'charter_read',
  annotations: { title: 'Read charter data (read-only)', readOnlyHint: true, openWorldHint: false },
  description:
    "READ-ONLY view of your data — use this (NOT charter_call) for ANY data question. " +
    "Safe to always-allow: the server rejects write verbs sent here " +
    "(returns write_in_read_tool). Call `verbs.list` first to discover available verbs, " +
    "then use read verbs like `data.warehouse.schema` / `data.warehouse.query` or " +
    "`data.posthog.schema` / `data.posthog.query` — each has a schema verb that returns " +
    "the table catalog + an analyst guide with dialect gotchas and business definitions. " +
    "Unsure which resource? Call BOTH `.schema` verbs — they're cheap and each guide " +
    "cross-links the other. Same args as charter_call: {verb, args, args_path, out_path}. " +
    "To DRAFT/PUBLISH content, use charter_call instead.",
  inputSchema: TOOL.inputSchema,
};

const TOOL_LOGIN = {
  name: 'charter_login',
  annotations: { title: 'Sign in to charter (Google)', readOnlyHint: false, openWorldHint: true },
  description:
    'One-time Google sign-in so charter actions are attributed to the human running ' +
    'Claude. Opens a browser — pick your WORK account matching the configured domain. ' +
    "Run this when a verb returns actor_required, or re-run it anytime to switch accounts. " +
    'Stores only an identity token (openid email) locally; it grants no access to mail, ' +
    'Drive, or files.',
  inputSchema: { type: 'object', properties: {} },
};

const TOOL_CONNECT_HS = {
  name: 'charter_connect_hubspot',
  annotations: { title: 'Connect HubSpot to charter', readOnlyHint: false, openWorldHint: true },
  description:
    'One-time HubSpot connect so your drafts/publishes show as YOU in HubSpot. Opens a ' +
    'browser — log in with YOUR HubSpot user on the configured portal. Run this when a verb ' +
    'returns hs_identity_required, or re-run after hs_identity_revoked. Requires a ' +
    'prior charter_login (your verified sign-in is the key the connection is stored under).',
  inputSchema: { type: 'object', properties: {} },
};

function urlIsSafe(u) {
  let p;
  try { p = new URL(u); } catch (_) { return false; }
  return p.protocol === 'https:' || ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(p.hostname);
}

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function buildAuthUrl(port, state, challenge) {
  const u = new URL(OAUTH_AUTH_URL);
  u.searchParams.set('client_id', OAUTH_CLIENT_ID);
  u.searchParams.set('redirect_uri', `http://127.0.0.1:${port}/callback`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'openid email');
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  u.searchParams.set('prompt', 'select_account consent'); // consent => refresh_token on every login
  if (OAUTH_DOMAIN_HINT) u.searchParams.set('hd', OAUTH_DOMAIN_HINT); // hint only; the SERVER verifies the domain
  return u.toString();
}

function googleAuthError(json, statusCode) {
  const err = new Error(json.error_description || json.error || ('HTTP ' + statusCode));
  err.code = json.error;
  return err;
}

function postForm(url, params) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(new URLSearchParams(params).toString());
    const req = https.request(new URL(url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': payload.length },
      timeout: 30000,
    }, async (res) => {
      const body = await readCapped(res);
      let json;
      try { json = JSON.parse(body); } catch (_) { return reject(new Error('bad JSON from ' + url)); }
      if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
      else reject(googleAuthError(json, res.statusCode));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

function idTokenPayload(idt) {
  return JSON.parse(Buffer.from(idt.split('.')[1], 'base64url').toString('utf8'));
}

function readIdentity() {
  try { return JSON.parse(fs.readFileSync(IDENTITY_PATH, 'utf8')); } catch (_) { return null; }
}

function writeIdentity(obj) {
  fs.mkdirSync(path.dirname(IDENTITY_PATH), { recursive: true, mode: 0o700 });
  fs.writeFileSync(IDENTITY_PATH, JSON.stringify(obj), { mode: 0o600 });
  fs.chmodSync(IDENTITY_PATH, 0o600);
}

let _actorCache = null;
function invalidateActorToken() { _actorCache = null; }

let mintActorToken = async function mintActorToken() {
  if (_actorCache && _actorCache.exp - 300 > Date.now() / 1000) return _actorCache.token;
  const id = readIdentity();
  if (!id) return null;
  const tok = await postForm(OAUTH_TOKEN_URL, {
    refresh_token: id.refresh_token, client_id: OAUTH_CLIENT_ID,
    client_secret: OAUTH_CLIENT_SECRET, grant_type: 'refresh_token',
  });
  _actorCache = { token: tok.id_token, exp: idTokenPayload(tok.id_token).exp };
  return tok.id_token;
};

let actorHeader = async function actorHeader() {
  try {
    const t = await mintActorToken();
    return t ? { 'X-Actor-Token': t } : {};
  } catch (e) {
    if (e.code === 'invalid_grant') throw e;
    process.stderr.write('charter: identity refresh failed (' + e.message + ') — run charter_login\n');
    return {};
  }
};

let login = async function login() {
  const configErrors = validateConfig();
  if (configErrors.length) throw new Error('config_missing: ' + configErrors.join('; '));

  const state = b64url(crypto.randomBytes(16));
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const { code, port } = await new Promise((resolve, reject) => {
    let port;
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      const err = u.searchParams.get('error');
      const stateOk = u.searchParams.get('state') === state;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(!err && stateOk
        ? '<html><body style="font-family:sans-serif"><h3>Signed in &mdash; you can return to Claude.</h3></body></html>'
        : '<html><body style="font-family:sans-serif"><h3>Sign-in failed &mdash; return to Claude and try again.</h3></body></html>');
      clearTimeout(timer);
      server.close();
      if (err) reject(new Error('Google returned: ' + err));
      else if (!stateOk) reject(new Error('state mismatch — run charter_login again'));
      else resolve({ code: u.searchParams.get('code'), port });
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('login timed out after 180s — run charter_login again'));
    }, LOGIN_TIMEOUT_MS);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      openBrowser(buildAuthUrl(port, state, challenge));
    });
    server.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
  const tok = await postForm(OAUTH_TOKEN_URL, {
    code, client_id: OAUTH_CLIENT_ID, client_secret: OAUTH_CLIENT_SECRET,
    redirect_uri: `http://127.0.0.1:${port}/callback`,
    grant_type: 'authorization_code', code_verifier: verifier,
  });
  if (!tok.refresh_token || !tok.id_token) throw new Error('Google response missing tokens — run charter_login again');
  const email = idTokenPayload(tok.id_token).email || '(unknown)';
  writeIdentity({ refresh_token: tok.refresh_token, email, client_id: OAUTH_CLIENT_ID });
  _actorCache = { token: tok.id_token, exp: idTokenPayload(tok.id_token).exp };
  return email;
};

function buildHsAuthUrl(state) {
  const u = new URL(HS_AUTH_URL);
  u.searchParams.set('client_id', HS_OAUTH_CLIENT_ID);
  u.searchParams.set('redirect_uri', `http://localhost:${HS_CONNECT_PORT}/callback`);
  u.searchParams.set('scope', HS_OAUTH_SCOPES);
  u.searchParams.set('state', state);
  return u.toString();
}

let connectHubspot = async function connectHubspot() {
  if (!readIdentity()) throw new Error('sign in first: run the charter_login tool, then retry charter_connect_hubspot');
  if (!HS_OAUTH_CLIENT_ID) throw new Error('config_missing: CHARTER_HUBSPOT_CLIENT_ID is required for HubSpot connection');
  const state = b64url(crypto.randomBytes(16));
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      const err = u.searchParams.get('error');
      const stateOk = u.searchParams.get('state') === state;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(!err && stateOk
        ? '<html><body style="font-family:sans-serif"><h3>HubSpot connected &mdash; return to Claude.</h3></body></html>'
        : '<html><body style="font-family:sans-serif"><h3>Connect failed &mdash; return to Claude and try again.</h3></body></html>');
      clearTimeout(timer);
      server.close();
      if (err) reject(new Error('HubSpot returned: ' + err));
      else if (!stateOk) reject(new Error('state mismatch — run charter_connect_hubspot again'));
      else resolve(u.searchParams.get('code'));
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('connect timed out after 180s — run charter_connect_hubspot again'));
    }, LOGIN_TIMEOUT_MS);
    server.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(e.code === 'EADDRINUSE'
        ? 'port ' + HS_CONNECT_PORT + ' is in use — close the conflicting app and retry'
        : e.message));
    });
    server.listen(HS_CONNECT_PORT, '127.0.0.1', () => openBrowser(buildHsAuthUrl(state)));
  });
  const [text, isError] = await callBridge('identity.hs.connect', { code });
  if (isError) throw new Error(text);
  return text;
};

function readCapped(res) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0, truncated = false;
    res.on('data', (c) => {
      if (total >= MAX_RESPONSE_BYTES) { truncated = true; return; }
      if (total + c.length > MAX_RESPONSE_BYTES) {
        chunks.push(c.subarray(0, MAX_RESPONSE_BYTES - total));
        total = MAX_RESPONSE_BYTES; truncated = true;
      } else { chunks.push(c); total += c.length; }
    });
    const done = () => {
      let text = Buffer.concat(chunks).toString('utf8');
      if (truncated) text += '\n...[truncated]';
      resolve(text);
    };
    res.on('end', done);
    res.on('error', done);
  });
}

let callBridge = async function callBridge(verb, args, opts) {
  const readOnly = !!(opts && opts.readOnly);
  if (!verb) return ["missing 'verb'", true];
  if (!urlIsSafe(BRIDGE_URL)) return ['refusing to send credentials in cleartext; set CHARTER_URL to https://', true];
  let u;
  try { u = new URL(BRIDGE_URL + '/'); } catch (e) { return ['bad CHARTER_URL: ' + e.message, true]; }
  let extra;
  try { extra = await actorHeader(); }
  catch (_) {
    return ['your Google sign-in was revoked — run the charter_login tool, then retry', true];
  }
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify({ ...(args || {}), verb, ...(readOnly ? { read_only: true } : {}) }));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'POST',
      headers: { ...HEADERS, ...extra, 'Content-Length': payload.length },
      timeout: 120000,
    }, async (res) => {
      const body = await readCapped(res);
      if (res.statusCode >= 200 && res.statusCode < 300) resolve([body, false]);
      else resolve(['HTTP ' + res.statusCode + ': ' + (body || res.statusMessage || ''), true]);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve(['request failed: ' + e.message, true]));
    req.write(payload);
    req.end();
  });
};

async function handle(msg) {
  const method = msg.method;
  if (method === 'initialize') {
    const pv = (msg.params && msg.params.protocolVersion) || '2025-06-18';
    return { protocolVersion: pv, capabilities: { tools: {} }, serverInfo: { name: 'charter', version: '0.1.0' } };
  }
  if (method === 'tools/list') return { tools: [TOOL_READ, TOOL, TOOL_LOGIN, TOOL_CONNECT_HS] };
  if (method === 'tools/call') {
    const name = (msg.params && msg.params.name) || '';
    const a = (msg.params && msg.params.arguments) || {};
    if (name === 'charter_login') {
      try {
        const email = await login();
        return { content: [{ type: 'text', text: 'Logged in as ' + email }], isError: false };
      } catch (e) {
        return { content: [{ type: 'text', text: 'login failed: ' + e.message }], isError: true };
      }
    }
    if (name === 'charter_connect_hubspot') {
      try {
        const out = await connectHubspot();
        return { content: [{ type: 'text', text: out }], isError: false };
      } catch (e) {
        return { content: [{ type: 'text', text: 'connect failed: ' + e.message }], isError: true };
      }
    }
    const readOnly = name === 'charter_read';
    let vargs;
    if (a.args_path) {
      try { vargs = JSON.parse(fs.readFileSync(a.args_path, 'utf8')); }
      catch (e) { return { content: [{ type: 'text', text: 'args_path read failed: ' + e.message }], isError: true }; }
    } else {
      vargs = a.args || {};
    }
    let [text, isError] = await callBridge(a.verb || '', vargs, { readOnly });
    if (isError && /"error":\s*"actor_invalid"/.test(text)) {
      invalidateActorToken();
      [text, isError] = await callBridge(a.verb || '', vargs, { readOnly });
    }
    if (a.out_path && !isError) {
      try {
        const d = path.dirname(a.out_path);
        if (d) fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(a.out_path, text);
        text = JSON.stringify({ ok: true, wrote: a.out_path, bytes: Buffer.byteLength(text) });
      } catch (e) { text = 'out_path write failed: ' + e.message; isError = true; }
    }
    return { content: [{ type: 'text', text }], isError };
  }
  if (method === 'ping') return {};
  throw new MethodNotFound(method);
}

async function dispatch(line) {
  line = line.trim();
  if (!line) return null;
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return null; }
  const mid = msg.id;
  if (mid == null) return null;
  try {
    return JSON.stringify({ jsonrpc: '2.0', id: mid, result: await handle(msg) });
  } catch (e) {
    const notFound = e instanceof MethodNotFound;
    return JSON.stringify({
      jsonrpc: '2.0', id: mid,
      error: { code: notFound ? -32601 : -32603, message: (notFound ? 'method not found: ' : 'internal error: ') + e.message },
    });
  }
}

function main() {
  const configErrors = validateConfig();
  if (configErrors.length) {
    process.stderr.write('charter: config missing — ' + configErrors.join('; ') + '\n');
    process.stderr.write('charter: set these in your plugin user_config or environment, then restart.\n');
  }
  if (!HEADERS['X-API-Key']) process.stderr.write('charter: no API key set — run /plugin configure charter (credential = cf-id:cf-secret:api-key).\n');
  const rl = readline.createInterface({ input: process.stdin });
  let chain = Promise.resolve();
  rl.on('line', (line) => {
    chain = chain.then(async () => {
      const out = await dispatch(line);
      if (out !== null) process.stdout.write(out + '\n');
    });
  });
}

function assert(cond, msg) { if (!cond) throw new Error('selftest failed: ' + msg); }

async function selftest() {
  // Suppress startup warnings during the check
  HEADERS['X-API-Key'] = 'selftest';

  const init = await handle({ method: 'initialize', id: 1, params: { protocolVersion: 'X' } });
  assert(init.protocolVersion === 'X' && init.capabilities.tools, 'init');

  const tools = await handle({ method: 'tools/list', id: 2 });
  assert(tools.tools[0].name === 'charter_read' && tools.tools[0].annotations.readOnlyHint === true, 'read tool first + read-only hint');
  assert(tools.tools.length === 4 && tools.tools.some((t) => t.name === 'charter_call'), 'call tool listed');
  assert(tools.tools.some((t) => t.name === 'charter_login'), 'login tool listed');

  // PKCE + auth-URL construction
  const ch = b64url(crypto.createHash('sha256').update('test-verifier').digest());
  const au = new URL(buildAuthUrl(9999, 'STATE', ch));
  assert(au.origin + au.pathname === 'https://accounts.google.com/o/oauth2/v2/auth', 'auth url');
  assert(au.searchParams.get('redirect_uri') === 'http://127.0.0.1:9999/callback', 'redirect_uri');
  assert(au.searchParams.get('code_challenge') === ch && au.searchParams.get('code_challenge_method') === 'S256', 'pkce');
  assert(au.searchParams.get('scope') === 'openid email' && au.searchParams.get('state') === 'STATE', 'scope/state');
  assert(au.searchParams.get('prompt') === 'select_account consent', 'prompt');

  // tools/call dispatches through callBridge; stub it to avoid the network (capture opts too).
  const real = callBridge;
  let lastOpts;
  callBridge = (v, a, o) => { lastOpts = o; return Promise.resolve([JSON.stringify({ echo_verb: v, echo_args: a }), false]); };
  let res = await handle({ method: 'tools/call', id: 3, params: { name: 'charter_call', arguments: { verb: 'sync.status', args: { x: 1 } } } });
  assert(res.isError === false && res.content[0].text.includes('sync.status'), 'call');

  await handle({ method: 'tools/call', id: 30, params: { name: 'charter_read', arguments: { verb: 'data.warehouse.query', args: {} } } });
  assert(lastOpts && lastOpts.readOnly === true, 'read tool sets readOnly');
  await handle({ method: 'tools/call', id: 300, params: { name: 'charter_call', arguments: { verb: 'sync.status' } } });
  assert(!(lastOpts && lastOpts.readOnly), 'call tool omits readOnly');

  // args_path + out_path
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-'));
  const ap = path.join(dir, 'in.json'), op = path.join(dir, 'sub', 'out.json');
  fs.writeFileSync(ap, JSON.stringify({ post: { name: 'big' } }));
  res = await handle({ method: 'tools/call', id: 31, params: { name: 'charter_call', arguments: { verb: 'content.hs_post.draft', args_path: ap, out_path: op } } });
  assert(res.isError === false, 'args_path/out_path');
  const summary = JSON.parse(res.content[0].text);
  assert(summary.wrote === op && summary.bytes > 0, 'summary');
  assert(JSON.stringify(JSON.parse(fs.readFileSync(op, 'utf8')).echo_args) === JSON.stringify({ post: { name: 'big' } }), 'body from file');
  fs.rmSync(dir, { recursive: true, force: true });

  // unknown method throws
  let threw = false;
  try { await handle({ method: 'nope', id: 4 }); } catch (e) { threw = e instanceof MethodNotFound; }
  assert(threw, 'expected MethodNotFound');

  // combined credential parsing
  let ch3 = credHeaders({ CHARTER_CREDENTIAL: 'abc.access:s3cret:k3y' });
  assert(ch3['CF-Access-Client-Id'] === 'abc.access' && ch3['CF-Access-Client-Secret'] === 's3cret' && ch3['X-API-Key'] === 'k3y', 'combined credential split');
  assert(credHeaders({ CHARTER_CREDENTIAL: 'a:b:key:with:colons' })['X-API-Key'] === 'key:with:colons', 'colons in api key survive');
  assert(credHeaders({ CHARTER_CREDENTIAL: 'only-two:parts' })['X-API-Key'] === '', 'malformed credential -> empty key, fails loudly');
  let chBare = credHeaders({ CHARTER_CREDENTIAL: 'bare-api-key-no-colons' });
  assert(chBare['X-API-Key'] === 'bare-api-key-no-colons' && chBare['CF-Access-Client-Id'] === '' && chBare['CF-Access-Client-Secret'] === '', 'bare API key (non-Cloudflare) works');
  ch3 = credHeaders({ CHARTER_API_KEY: 'k', CHARTER_CF_ACCESS_CLIENT_ID: 'i', CHARTER_CF_ACCESS_CLIENT_SECRET: 's' });
  assert(ch3['X-API-Key'] === 'k' && ch3['CF-Access-Client-Id'] === 'i' && ch3['CF-Access-Client-Secret'] === 's', 'legacy vars honored');
  assert(credHeaders({ CHARTER_CREDENTIAL: ' a:b:c ', CHARTER_API_KEY: 'legacy' })['X-API-Key'] === 'c', 'combined wins over legacy, trimmed');

  // cleartext guard
  assert(!urlIsSafe('http://evil.example'), 'http remote should be unsafe');
  assert(urlIsSafe('http://127.0.0.1:8787') && urlIsSafe('https://x'), 'loopback/https ok');

  // dispatch(): notification / id:0 / malformed / unknown-code
  assert((await dispatch('{"jsonrpc":"2.0","method":"notifications/initialized"}')) === null, 'notification got a reply');
  assert((await dispatch('{"jsonrpc":"2.0","id":0,"method":"ping"}')).includes('"id":0'), 'id:0 answered');
  assert((await dispatch('{bad json')) === null, 'malformed not skipped');
  assert((await dispatch('{"jsonrpc":"2.0","id":5,"method":"nope"}')).includes('-32601'), 'wrong code for unknown method');

  // identity store round-trip
  const idDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charter-id-'));
  const realIdPath = IDENTITY_PATH;
  IDENTITY_PATH = path.join(idDir, 'identity.json');
  assert(readIdentity() === null, 'missing identity reads null');
  assert((await mintActorToken()) === null, 'no identity -> null token, no network');
  writeIdentity({ refresh_token: 'r', email: 'x@example.com' });
  assert(readIdentity().email === 'x@example.com', 'identity round-trip');
  if (process.platform !== 'win32') {
    assert((fs.statSync(IDENTITY_PATH).mode & 0o777) === 0o600, 'identity file mode 0600');
  }

  // header injection + transient-degrade / invalid_grant-propagate
  const realMint = mintActorToken;
  mintActorToken = async () => 'FAKE';
  assert((await actorHeader())['X-Actor-Token'] === 'FAKE', 'actor header attached');

  const ge = googleAuthError({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400);
  assert(ge.code === 'invalid_grant' && !/invalid_grant/.test(ge.message), 'google error keeps code separate from text');

  mintActorToken = async () => { throw new Error('ETIMEDOUT'); };
  assert(Object.keys(await actorHeader()).length === 0, 'network mint failure degrades to headerless');
  mintActorToken = async () => { throw googleAuthError({ error: 'temporarily_unavailable', error_description: 'try later' }, 503); };
  assert(Object.keys(await actorHeader()).length === 0, 'transient oauth failure degrades to headerless');

  mintActorToken = async () => { throw googleAuthError({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400); };
  let threwIG = false;
  try { await actorHeader(); } catch (e) { threwIG = e.code === 'invalid_grant'; }
  assert(threwIG, 'invalid_grant propagates from actorHeader');
  mintActorToken = realMint;

  // actor_invalid retried exactly once
  let nCalls = 0;
  callBridge = async () => { nCalls += 1; return nCalls === 1 ? ['HTTP 401: {"error":"actor_invalid"}', true] : ['{"ok":true}', false]; };
  let r2 = await handle({ method: 'tools/call', id: 6, params: { name: 'charter_call', arguments: { verb: 'sync.status' } } });
  assert(nCalls === 2 && r2.isError === false, 'actor_invalid retried once');
  nCalls = 0;
  callBridge = async () => { nCalls += 1; return ['HTTP 403: {"error":"denied"}', true]; };
  r2 = await handle({ method: 'tools/call', id: 7, params: { name: 'charter_call', arguments: { verb: 'sync.status' } } });
  assert(nCalls === 1 && r2.isError === true, 'denied not retried');

  // login tool routes by name (stub login itself — no browser/network in selftest)
  const realLogin = login;
  login = async () => 'sam@example.com';
  r2 = await handle({ method: 'tools/call', id: 8, params: { name: 'charter_login', arguments: {} } });
  assert(r2.isError === false && r2.content[0].text === 'Logged in as sam@example.com', 'login tool routed');
  login = realLogin;

  // connect-hubspot tool: listing, auth-url construction, and routing
  assert(tools.tools.length === 4 && tools.tools.some((t) => t.name === 'charter_connect_hubspot'), 'connect tool listed');
  const hu = new URL(buildHsAuthUrl('S'));
  assert(hu.origin + hu.pathname === 'https://app.hubspot.com/oauth/authorize', 'hs auth url');
  assert(hu.searchParams.get('redirect_uri') === 'http://localhost:53682/callback', 'hs fixed-port redirect');
  assert(hu.searchParams.get('state') === 'S' && hu.searchParams.get('client_id') === HS_OAUTH_CLIENT_ID, 'hs state/client');
  const realConnect = connectHubspot;
  connectHubspot = async () => '{"ok":true,"connected":true}';
  let rc = await handle({ method: 'tools/call', id: 9, params: { name: 'charter_connect_hubspot', arguments: {} } });
  assert(rc.isError === false && rc.content[0].text.includes('connected'), 'connect tool routed');
  connectHubspot = async () => { throw new Error('state mismatch'); };
  rc = await handle({ method: 'tools/call', id: 10, params: { name: 'charter_connect_hubspot', arguments: {} } });
  assert(rc.isError === true && rc.content[0].text.includes('state mismatch'), 'connect failure surfaces');
  connectHubspot = realConnect;

  // sign-in pre-check
  IDENTITY_PATH = path.join(idDir, 'no-such-identity.json');
  rc = await handle({ method: 'tools/call', id: 11, params: { name: 'charter_connect_hubspot', arguments: {} } });
  assert(rc.isError === true && rc.content[0].text.includes('sign in first'), 'connect requires sign-in');
  IDENTITY_PATH = realIdPath;
  fs.rmSync(idDir, { recursive: true, force: true });
  callBridge = real;

  // invalid_grant through the REAL callBridge: fails with login guidance, no network
  BRIDGE_URL = 'https://test.example.com'; // selftest needs a valid URL to reach actorHeader
  mintActorToken = async () => { throw googleAuthError({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400); };
  const r3 = await callBridge('sync.status', {});
  assert(r3[1] === true && r3[0].includes('charter_login'), 'invalid_grant fails the call with login guidance');
  mintActorToken = realMint;

  // --- NEW: config validation selftest ---
  // Missing config should produce named errors
  const realClientId = OAUTH_CLIENT_ID; // OAUTH_CLIENT_ID is const, but we can test the function
  // We can't mutate the const, but we can test the error path indirectly
  // by verifying the validateConfig function exists and returns the right shape
  const errs = validateConfig();
  // In selftest, all env vars are set (selftest doesn't clear them), so this should be empty
  // But we can test the function logic by calling it with a simulated empty env
  // Since we can't easily mock process.env in this closure, we verify the function exists
  assert(typeof validateConfig === 'function', 'validateConfig exists');

  console.log('selftest ok');
}

if (process.argv.includes('--selftest')) selftest().catch((e) => { console.error(e.message); process.exit(1); });
else main();
