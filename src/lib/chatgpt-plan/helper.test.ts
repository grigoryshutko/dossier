import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let child: ChildProcess;
let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "dossier-helper-"));
  child = spawn(process.execPath, ["scripts/chatgpt-login.mjs", "--dossier-origin", "http://127.0.0.1:3000"], { env: { ...process.env, DOSSIER_CHATGPT_HELPER_CONFIG_DIR: home, CHATGPT_PLAN_ALLOW_INSECURE_DEV: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => { child.stdout!.once("data", () => resolve()); child.once("error", reject); child.once("exit", code => reject(new Error(`helper exited ${code}`))); });
});
afterEach(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise(r => child.once("exit", r)); } await rm(home, { recursive: true, force: true }); });
async function start(clientId?: string, vmHostId?: string) {
  const response = await fetch("http://127.0.0.1:1455/start", { method: "POST", headers: { origin: "http://127.0.0.1:1455", "content-type": "application/json" }, body: JSON.stringify({ origin: "http://127.0.0.1:3000", capability: "a".repeat(43), nonce: "b".repeat(43), ...(clientId ? { clientId } : {}), ...(vmHostId ? { vmHostId } : {}) }) });
  expect(response.status).toBe(200); return new URL((await response.json()).url);
}
describe("local sign-in helper", () => {
  it("rejects a pairing for a different origin before starting OAuth", async () => {
    const response = await fetch("http://127.0.0.1:1455/start", { method: "POST", headers: { origin: "http://127.0.0.1:1455", "content-type": "application/json" }, body: JSON.stringify({ origin: "https://attacker.example", capability: "a".repeat(43), nonce: "b".repeat(43) }) });
    expect(response.status).toBe(400);
    expect((await start()).hostname).toBe("auth.openai.com");
  });
  it("rejects a callback with incorrect state before exchanging the code", async () => {
    const auth = await start(); expect(auth.searchParams.get("client_id")).toBe("dynamic_agent_client"); expect(auth.searchParams.get("nonce")).toBe("b".repeat(43)); expect(auth.searchParams.get("ext_agent_host_id")).toBe(await readFile(path.join(home, "chatgpt-host-id"), "utf8"));
    const response = await fetch("http://127.0.0.1:1455/auth/callback?state=wrong&code=code&client_id=oaiapp_test"); expect(response.status).toBe(400);
  });
  it("uses the VM host ID for a later authorization", async () => {
    const vmHostId = "urn:uuid:12345678-1234-4234-8234-123456789abc";
    const auth = await start("oaiapp_original", vmHostId);
    expect(auth.searchParams.get("ext_agent_host_id")).toBe(vmHostId);
  });
  it("rejects a VM host ID without a valid issued client ID", async () => {
    const response = await fetch("http://127.0.0.1:1455/start", { method: "POST", headers: { origin: "http://127.0.0.1:1455", "content-type": "application/json" }, body: JSON.stringify({ origin: "http://127.0.0.1:3000", capability: "a".repeat(43), nonce: "b".repeat(43), vmHostId: "urn:uuid:12345678-1234-4234-8234-123456789abc" }) });
    expect(response.status).toBe(400);
  });
  it("rejects a changed issued client ID before exchanging the code", async () => {
    const auth = await start("oaiapp_original");
    const callback = new URL("http://127.0.0.1:1455/auth/callback"); callback.search = new URLSearchParams({ state: auth.searchParams.get("state")!, code: "code", client_id: "oaiapp_other" }).toString();
    const response = await fetch(callback); expect(response.status).toBe(400);
  });
});
