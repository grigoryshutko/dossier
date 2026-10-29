import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRemoteJWKSet, jwtVerify } from "jose";

const issuer = "https://auth.openai.com";
const resource = "https://api.openai.com/v1";
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
const planScope = "chatgpt.tokens.use.direct";
export type ChatGptPlanView = { connected: boolean; planAuthorized: boolean; enabled: boolean; email: string | null; model: string | null; allowBackground: boolean; needsReauth: boolean };
type Credential = { clientId: string; subject: string; email: string | null; idToken: string; accessToken: string; refreshToken: string; expiresAt: number; scopes: string[] };
type State = { hostId: string; credential?: Credential; registration?: { clientId: string; subject: string; email: string | null }; enabled: boolean; model: string | null; allowBackground: boolean; needsReauth: boolean; pending?: { hash: string; nonce: string; expiresAt: number } };
const directory = () => path.join(process.env.DOSSIER_DATA_DIR || (process.env.NODE_ENV === "production" ? "/data" : "./data"), "chatgpt-plan");
const file = () => path.join(directory(), "credentials.json");
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const initial = (): State => ({ hostId: `urn:uuid:${randomUUID()}`, enabled: false, model: null, allowBackground: false, needsReauth: false });
async function read(): Promise<State> { try { return JSON.parse(await readFile(file(), "utf8")) as State; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return initial(); throw e; } }
async function write(state: State) {
  const tmp = path.join(directory(), `.credentials-${randomUUID()}`);
  const f = await open(tmp, "wx", 0o600);
  try { await f.writeFile(JSON.stringify(state)); await f.sync(); } finally { await f.close(); }
  try { await rename(tmp, file()); } catch (e) { await rm(tmp, { force: true }); throw e; }
}
// Locks cover refresh, import, pairing and disconnect across processes on one host.
// Recovery is guarded so a contender cannot replace a lock during recovery.
async function abandoned(lock: string): Promise<boolean> {
  try {
    const info = await stat(lock);
    if (Date.now() - info.mtimeMs < 30_000) return false;
    let owner: number;
    try { owner = Number(await readFile(path.join(lock, "pid"), "utf8")); } catch { return true; }
    if (!Number.isInteger(owner) || owner <= 0) return true;
    try { process.kill(owner, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function exists(p: string): Promise<boolean> { try { await stat(p); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } }
async function locked<T>(fn: (s: State) => Promise<T>): Promise<T> {
  await mkdir(directory(), { recursive: true, mode: 0o700 });
  const lock = path.join(directory(), ".lock");
  const recovery = path.join(directory(), ".recovery");
  const deadline = Date.now() + 65000;
  while (true) {
    if (!(await exists(recovery))) {
      try {
        await mkdir(lock, { mode: 0o700 });
        try { await writeFile(path.join(lock, "pid"), String(process.pid), { mode: 0o600 }); } catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }
        if (!(await exists(recovery))) break;
        await rm(lock, { recursive: true, force: true });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    if (await abandoned(lock)) {
      try {
        await mkdir(recovery, { mode: 0o700 });
        try { await writeFile(path.join(recovery, "pid"), String(process.pid), { mode: 0o600 }); } catch (error) { await rm(recovery, { recursive: true, force: true }); throw error; }
        try { if (await abandoned(lock)) await rm(lock, { recursive: true, force: true }); }
        finally { await rm(recovery, { recursive: true, force: true }); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    // A recovery owner can itself crash; only remove its guard after the
    // same conservative age and process-liveness checks.
    if (await abandoned(recovery)) await rm(recovery, { recursive: true, force: true });
    if (Date.now() >= deadline) throw new Error("ChatGPT plan credential lock timed out");
    await new Promise(r => setTimeout(r, 50));
  }
  try { return await fn(await read()); } finally { await rm(lock, { recursive: true, force: true }); }
}
function view(s: State): ChatGptPlanView { return { connected: !!s.credential, planAuthorized: !!s.credential && s.credential.scopes.includes(planScope) && !!s.credential.refreshToken, enabled: s.enabled, email: s.credential?.email ?? null, model: s.model, allowBackground: s.allowBackground, needsReauth: s.needsReauth }; }
export async function getChatGptPlanView() { return locked(async s => view(s)); }
export async function createChatGptPlanPairing(origin: string) {
  return locked(async s => { const capability = secret(); const nonce = secret(); s.pending = { hash: hash(capability), nonce, expiresAt: Date.now() + 10 * 60_000 }; await write(s); const url = new URL("http://127.0.0.1:1455/"); url.hash = new URLSearchParams({ origin, capability, nonce, ...((s.credential || s.registration) ? { clientId: (s.credential || s.registration)!.clientId, vmHostId: s.hostId } : {}) }).toString(); return url.toString(); });
}
export async function cancelChatGptPlanPairing() { return locked(async s => { delete s.pending; await write(s); return view(s); }); }
export async function importChatGptPlan(capability: string, value: unknown) {
  if (typeof capability !== "string" || capability.length > 100 || !value || typeof value !== "object") throw new Error("Invalid import");
  return locked(async s => {
    const pending = s.pending;
    if (!pending || pending.expiresAt < Date.now() || hash(capability) !== pending.hash) throw new Error("Invalid or expired pairing");
    // Consume before verification, including failures, so concurrent imports cannot race.
    delete s.pending; await write(s);
    const c = value as Record<string, unknown>;
    if (typeof c.clientId !== "string" || !/^oaiapp_[A-Za-z0-9_-]+$/.test(c.clientId) || typeof c.idToken !== "string" || typeof c.accessToken !== "string" || typeof c.refreshToken !== "string" || typeof c.expiresAt !== "number" || !Number.isFinite(c.expiresAt) || c.expiresAt <= Date.now() || c.expiresAt > Date.now() + 7200_000 || !Array.isArray(c.scopes) || !c.scopes.every(x => typeof x === "string")) throw new Error("Invalid credentials");
    const id = await jwtVerify(c.idToken, jwks, { issuer, audience: c.clientId, algorithms: ["RS256"], requiredClaims: ["sub", "exp", "iat"], clockTolerance: 5 });
    if (id.payload.nonce !== pending.nonce || !id.payload.sub) throw new Error("Invalid identity");
    const access = await jwtVerify(c.accessToken, jwks, { issuer, audience: resource, algorithms: ["RS256"], requiredClaims: ["sub", "exp", "iat"], clockTolerance: 5 });
    if (access.payload.client_id !== c.clientId || typeof access.payload.scope !== "string" || ((c.scopes as string[]).includes(planScope) && !(access.payload.scope as string).split(" ").includes(planScope))) throw new Error("Invalid access token");
    const prior = s.credential || s.registration;
    if (prior && (prior.subject !== id.payload.sub || prior.clientId !== c.clientId)) throw new Error("This installation is registered to another ChatGPT account");
    s.credential = { clientId: c.clientId, subject: id.payload.sub, email: typeof id.payload.email === "string" ? id.payload.email : null, idToken: c.idToken, accessToken: c.accessToken, refreshToken: c.refreshToken, expiresAt: Math.min(c.expiresAt, access.payload.exp! * 1000), scopes: c.scopes as string[] };
    s.registration = { clientId: c.clientId, subject: id.payload.sub, email: s.credential.email };
    s.enabled = (c.scopes as string[]).includes(planScope) && !!c.refreshToken; s.needsReauth = false; await write(s); return view(s);
  });
}
export async function saveChatGptPlanPreferences(p: { enabled?: boolean; model?: string | null; allowBackground?: boolean }) { return locked(async s => { if (p.enabled !== undefined) { if (p.enabled && (!s.credential || !s.credential.scopes.includes(planScope) || !s.credential.refreshToken)) throw new Error("Connect first"); s.enabled = p.enabled; } if (p.model !== undefined) { if (p.model !== null && (!/^[a-zA-Z0-9._-]{1,100}$/.test(p.model))) throw new Error("Invalid model"); s.model = p.model; } if (p.allowBackground !== undefined) s.allowBackground = p.allowBackground; await write(s); return view(s); }); }
export async function disconnectChatGptPlan({ forgetRegistration = false }: { forgetRegistration?: boolean } = {}): Promise<{ revocationConfirmed: boolean | null }> { return locked(async s => {
  let revocationConfirmed: boolean | null = null;
  if (s.credential?.refreshToken) {
    revocationConfirmed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(`${issuer}/api/accounts/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: s.credential.refreshToken, token_type_hint: "refresh_token", client_id: s.credential.clientId }), redirect: "error", signal: AbortSignal.timeout(3000) });
        if (response.status === 200) { revocationConfirmed = true; break; }
        if (response.status < 500) break;
      } catch { /* Clear the local session even if OpenAI is unavailable. */ }
      if (attempt < 2) await new Promise(r => setTimeout(r, 250 * 2 ** attempt));
    }
  }
  delete s.credential; delete s.pending; if (forgetRegistration) { delete s.registration; s.model = null; } s.enabled = false; s.allowBackground = false; s.needsReauth = false; await write(s);
  return { revocationConfirmed };
}); }
export async function assertChatGptPlanBackgroundAllowed() { const s = await getChatGptPlanView(); if (!s.connected || !s.enabled || !s.allowBackground || s.needsReauth) throw new Error("ChatGPT plan background use is not enabled"); }
export async function getChatGptPlanAccessToken(signal?: AbortSignal): Promise<string> { return locked(async s => {
  const c = s.credential; if (!c || !s.enabled || s.needsReauth) throw new Error("ChatGPT plan is not connected");
  if (c.expiresAt > Date.now() + 60_000) return c.accessToken;
  const response = await fetch(`${issuer}/api/accounts/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: c.clientId, refresh_token: c.refreshToken, resource }), redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
  if (!response.ok) { if (response.status === 400 || response.status === 401) { s.needsReauth = true; await write(s); } throw new Error("ChatGPT plan token refresh failed"); }
  const t = await response.json();
  if (typeof t.access_token !== "string" || typeof t.refresh_token !== "string" || !t.refresh_token || typeof t.expires_in !== "number" || t.expires_in <= 0 || typeof t.scope !== "string" || !t.scope.split(" ").includes(planScope)) { s.needsReauth = true; await write(s); throw new Error("Invalid refresh response"); }
  let access: Awaited<ReturnType<typeof jwtVerify>>;
  try { access = await jwtVerify(t.access_token, jwks, { issuer, audience: resource, algorithms: ["RS256"], requiredClaims: ["sub", "exp", "iat"] }); } catch { s.needsReauth = true; await write(s); throw new Error("Invalid refreshed access token"); }
  if (access.payload.client_id !== c.clientId || typeof access.payload.scope !== "string" || !(access.payload.scope as string).split(" ").includes(planScope)) { s.needsReauth = true; await write(s); throw new Error("Invalid refreshed access token"); }
  c.accessToken = t.access_token; c.refreshToken = t.refresh_token; c.scopes = t.scope.split(" "); c.expiresAt = Math.min(Date.now() + t.expires_in * 1000, access.payload.exp! * 1000); await write(s); return c.accessToken;
}); }
