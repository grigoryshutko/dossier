import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";

const keyState = vi.hoisted(() => ({ resolve: null as null | ((...args: unknown[]) => unknown) }));
vi.mock("jose", async importOriginal => {
  const actual = await importOriginal<typeof import("jose")>();
  return { ...actual, createRemoteJWKSet: () => (...args: unknown[]) => keyState.resolve!(...args) };
});
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cancelChatGptPlanPairing, createChatGptPlanPairing, disconnectChatGptPlan, getChatGptPlanView, importChatGptPlan } from "./index";

let dir: string;
let privateKey: CryptoKey;
async function credentials(nonce: string, options: { idNonce?: string; idAudience?: string; idExpired?: boolean; accessSubject?: string; accessClient?: string; accessScope?: string; expiresAt?: number } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const idToken = await new SignJWT({ nonce: options.idNonce ?? nonce, email: "person@example.com" }).setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer("https://auth.openai.com").setAudience(options.idAudience ?? "oaiapp_test").setSubject("user-1").setIssuedAt(now).setExpirationTime(options.idExpired ? now - 60 : now + 3600).sign(privateKey);
  const accessToken = await new SignJWT({ client_id: options.accessClient ?? "oaiapp_test", scope: options.accessScope ?? "openid offline_access resource.invoke chatgpt.tokens.use.direct" }).setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer("https://auth.openai.com").setAudience("https://api.openai.com/v1").setSubject(options.accessSubject ?? "user-1").setIssuedAt(now).setExpirationTime(now + 3600).sign(privateKey);
  return { clientId: "oaiapp_test", idToken, accessToken, refreshToken: "refresh-1", expiresAt: options.expiresAt ?? Date.now() + 3_500_000, scopes: ["openid", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"] };
}
async function pairing() { const url = new URL(await createChatGptPlanPairing("https://example.com")); const params = new URLSearchParams(url.hash.slice(1)); return { capability: params.get("capability")!, nonce: params.get("nonce")! }; }

beforeEach(async () => { const pair = await generateKeyPair("RS256"); privateKey = pair.privateKey as CryptoKey; const jwk = await exportJWK(pair.publicKey); jwk.kid = "test"; keyState.resolve = createLocalJWKSet({ keys: [jwk] }) as unknown as typeof keyState.resolve; dir = await mkdtemp(path.join(tmpdir(), "dossier-plan-")); process.env.DOSSIER_DATA_DIR = dir; });
afterEach(async () => { delete process.env.DOSSIER_DATA_DIR; vi.unstubAllGlobals(); await rm(dir, { recursive: true, force: true }); });
describe("ChatGPT plan pairing", () => {
  it("stores a stable VM host and never stores the pairing capability", async () => {
    const url = new URL(await createChatGptPlanPairing("https://example.com"));
    const capability = new URLSearchParams(url.hash.slice(1)).get("capability")!;
    const file = path.join(dir, "chatgpt-plan", "credentials.json");
    const first = await readFile(file, "utf8");
    expect(first).not.toContain(capability);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await disconnectChatGptPlan();
    expect(JSON.parse(await readFile(file, "utf8")).hostId).toBe(JSON.parse(first).hostId);
    expect((await getChatGptPlanView()).connected).toBe(false);
  });
  it("consumes a capability once even for failed and concurrent imports", async () => {
    const url = new URL(await createChatGptPlanPairing("https://example.com"));
    const capability = new URLSearchParams(url.hash.slice(1)).get("capability")!;
    const results = await Promise.allSettled([importChatGptPlan(capability, {}), importChatGptPlan(capability, {})]);
    expect(results.every(r => r.status === "rejected")).toBe(true);
    await expect(importChatGptPlan(capability, {})).rejects.toThrow("Invalid or expired pairing");
  });
  it("recovers a lock abandoned by a dead process", async () => {
    const lock = path.join(dir, "chatgpt-plan", ".lock");
    await mkdir(lock, { recursive: true }); await writeFile(path.join(lock, "pid"), "2147483647");
    const past = new Date(Date.now() - 60_000); await utimes(lock, past, past);
    await expect(getChatGptPlanView()).resolves.toMatchObject({ connected: false });
  });
  it("cancellation invalidates a pending transfer without disconnecting the account", async () => {
    const first = await pairing(); await importChatGptPlan(first.capability, await credentials(first.nonce));
    const pending = await pairing();
    await expect(cancelChatGptPlanPairing()).resolves.toMatchObject({ connected: true, planAuthorized: true });
    await expect(importChatGptPlan(pending.capability, {})).rejects.toThrow("Invalid or expired pairing");
  });
  it("disconnect invalidates pending transfers", async () => {
    const url = new URL(await createChatGptPlanPairing("https://example.com"));
    const capability = new URLSearchParams(url.hash.slice(1)).get("capability")!;
    await disconnectChatGptPlan();
    await expect(importChatGptPlan(capability, {})).rejects.toThrow("Invalid or expired pairing");
  });
});

describe("credential validation and refresh", () => {
  it.each([
    ["nonce", { idNonce: "wrong" }],
    ["audience", { idAudience: "oaiapp_other" }],
    ["expiry", { idExpired: true }],
    ["client", { accessClient: "oaiapp_other" }],
    ["plan scope", { accessScope: "openid offline_access resource.invoke" }],
  ])("rejects a mismatched %s", async (_name, options) => {
    const p = await pairing();
    await expect(importChatGptPlan(p.capability, await credentials(p.nonce, options))).rejects.toThrow();
    expect((await getChatGptPlanView()).connected).toBe(false);
  });
  it("retains identity without enabling plan use when permission is absent", async () => {
    const p = await pairing(); const c = await credentials(p.nonce); c.scopes = ["openid", "offline_access", "resource.invoke"];
    await expect(importChatGptPlan(p.capability, c)).resolves.toMatchObject({ connected: true, planAuthorized: false, enabled: false });
  });
  it("serializes refresh and persists the replacement token", async () => {
    const p = await pairing(); const c = await credentials(p.nonce, { expiresAt: Date.now() + 5000 }); await importChatGptPlan(p.capability, c);
    const replacement = await credentials(p.nonce);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ access_token: replacement.accessToken, refresh_token: "refresh-2", expires_in: 3600, scope: replacement.scopes.join(" ") }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { getChatGptPlanAccessToken } = await import("./index");
    const results = await Promise.all([getChatGptPlanAccessToken(), getChatGptPlanAccessToken()]);
    expect(results).toEqual([replacement.accessToken, replacement.accessToken]); expect(fetchMock).toHaveBeenCalledTimes(1);
    const stored = await readFile(path.join(dir, "chatgpt-plan", "credentials.json"), "utf8"); expect(JSON.parse(stored).credential.refreshToken).toBe("refresh-2");
  });
  it("rejects replacing an existing account with another client", async () => {
    const p = await pairing(); await importChatGptPlan(p.capability, await credentials(p.nonce));
    const q = await pairing(); const c = await credentials(q.nonce, { idAudience: "oaiapp_other", accessClient: "oaiapp_other" }); c.clientId = "oaiapp_other";
    await expect(importChatGptPlan(q.capability, c)).rejects.toThrow("Disconnect before connecting another account");
    expect((await getChatGptPlanView()).connected).toBe(true);
  });
  it("revokes a session and clears credentials on disconnect", async () => {
    const p = await pairing(); await importChatGptPlan(p.capability, await credentials(p.nonce));
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 })); vi.stubGlobal("fetch", fetchMock);
    expect(await disconnectChatGptPlan()).toEqual({ revocationConfirmed: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await getChatGptPlanView()).connected).toBe(false);
    expect(new URLSearchParams(new URL(await createChatGptPlanPairing("https://example.com")).hash.slice(1)).get("clientId")).toBe("oaiapp_test");
    expect(await readFile(path.join(dir, "chatgpt-plan", "credentials.json"), "utf8")).not.toContain("refresh-1");
  });
  it("clears local credentials if remote revocation fails", async () => {
    const p = await pairing(); await importChatGptPlan(p.capability, await credentials(p.nonce));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 400 })));
    expect(await disconnectChatGptPlan()).toEqual({ revocationConfirmed: false });
    expect((await getChatGptPlanView()).connected).toBe(false);
  });
  it("marks invalid grants as requiring reauthorization", async () => {
    const p = await pairing(); await importChatGptPlan(p.capability, await credentials(p.nonce, { expiresAt: Date.now() + 5000 }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 400 })));
    const { getChatGptPlanAccessToken } = await import("./index"); await expect(getChatGptPlanAccessToken()).rejects.toThrow();
    expect((await getChatGptPlanView()).needsReauth).toBe(true);
  });
});
