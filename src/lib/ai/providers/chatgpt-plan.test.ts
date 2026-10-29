import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("server-only", () => ({}));
const auth = vi.hoisted(() => ({ token: vi.fn(), background: vi.fn(), allowed: vi.fn() }));
vi.mock("@/lib/chatgpt-plan", () => ({ getChatGptPlanAccessToken: auth.token, assertChatGptPlanBackgroundAllowed: auth.allowed }));
vi.mock("@/lib/ai/execution", () => ({ isAiBackgroundExecution: auth.background }));
import { ChatGptPlanProvider, fetchChatGptPlanModels } from "./chatgpt-plan";

const call = { system: "Be helpful", messages: [{ role: "user" as const, content: "Hi" }] };
const event = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
function stream(chunks: string[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } }));
}

describe("ChatGptPlanProvider", () => {
  beforeEach(() => { vi.resetAllMocks(); auth.token.mockResolvedValue("plan-token"); auth.allowed.mockResolvedValue(undefined); });
  it("uses only supported fields and reads split CRLF SSE events", async () => {
    const wire = event({ type: "response.output_text.delta", delta: "Hello" }) + event({ type: "response.completed" });
    const fetchMock = vi.fn().mockResolvedValue(stream([wire.slice(0, 7), wire.slice(7, 52), wire.slice(52)]));
    vi.stubGlobal("fetch", fetchMock);
    const p = new ChatGptPlanProvider("model", 5000);
    expect(await p.complete({ ...call, creativity: "EXPRESSIVE", effort: "high", maxTokens: 20 })).toBe("Hello");
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(options.redirect).toBe("manual");
    expect(options.headers.Authorization).toBe("Bearer plan-token");
    expect(JSON.parse(options.body)).toEqual({ model: "model", input: call.messages, instructions: call.system, store: false, stream: true });
  });
  it("puts the JSON schema in instructions", async () => {
    const fetchMock = vi.fn().mockResolvedValue(stream([event({ type: "response.output_text.delta", delta: '{"ok":true}' }), event({ type: "response.completed" })]));
    vi.stubGlobal("fetch", fetchMock);
    expect(await new ChatGptPlanProvider("model", 5000).complete({ ...call, schema: z.object({ ok: z.boolean() }) })).toEqual({ ok: true });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.instructions).toContain("JSON schema");
    expect(body).not.toHaveProperty("text");
  });
  it("rejects a quota error after a partial answer without leaking the message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream([event({ type: "response.output_text.delta", delta: "partial" }), event({ type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "secret" } } })])));
    await expect(new ChatGptPlanProvider("model", 5000).complete(call)).rejects.toMatchObject({ kind: "rate-limited", message: expect.stringContaining("plan usage limit") });
  });
  it("rejects an incomplete stream and redirects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(stream([event({ type: "response.output_text.delta", delta: "partial" })])).mockResolvedValueOnce(new Response(null, { status: 302 })));
    const p = new ChatGptPlanProvider("model", 5000);
    await expect(p.complete(call)).rejects.toMatchObject({ kind: "provider" });
    await expect(p.complete(call)).rejects.toMatchObject({ kind: "provider" });
  });
  it("checks background consent and retrieves a fresh token for every inference", async () => {
    auth.background.mockReturnValue(true);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(stream([event({ type: "response.output_text.delta", delta: "ok" }), event({ type: "response.completed" })]))));
    const p = new ChatGptPlanProvider("model", 5000);
    await p.complete(call); await p.complete(call);
    expect(auth.allowed).toHaveBeenCalledTimes(2);
    expect(auth.token).toHaveBeenCalledTimes(2);
  });
  it("rechecks background consent for each inference", async () => {
    auth.background.mockReturnValue(true);
    auth.allowed.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("disabled"));
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(stream([event({ type: "response.output_text.delta", delta: "ok" }), event({ type: "response.completed" })])));
    vi.stubGlobal("fetch", fetchMock);
    const p = new ChatGptPlanProvider("model", 5000);
    await p.complete(call);
    await expect(p.complete(call)).rejects.toMatchObject({ kind: "config", message: expect.stringContaining("background ChatGPT plan") });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("maps caller cancellation and rejects empty and refusal responses", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn().mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })).mockResolvedValueOnce(stream([event({ type: "response.completed" })])).mockResolvedValueOnce(stream([event({ type: "response.refusal.delta", delta: "No" })])));
    const p = new ChatGptPlanProvider("model", 5000);
    const pending = p.complete({ ...call, signal: controller.signal });
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
    await expect(p.complete(call)).rejects.toMatchObject({ kind: "provider" });
    await expect(p.complete(call)).rejects.toMatchObject({ detail: "refusal" });
  });
  it.each([
    [401, "auth"],
    [429, "rate-limited"],
    [500, "provider"],
  ] as const)("maps HTTP %i without exposing response messages", async (status, kind) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { message: "private upstream text" } }, { status })));
    const error = await new ChatGptPlanProvider("model", 5000).complete(call).catch(error => error);
    expect(error).toMatchObject({ kind });
    expect(error.message).not.toContain("private upstream text");
  });
  it("classifies plan quota errors in HTTP responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { code: "subscription_sharing_usage_unavailable" } }, { status: 403 })));
    await expect(new ChatGptPlanProvider("model", 5000).complete(call)).rejects.toMatchObject({ kind: "rate-limited", message: expect.stringContaining("plan usage limit") });
  });
  it("rejects missing bodies, invalid events, and partial frames", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(null)).mockResolvedValueOnce(stream(["data: {bad}\n\n"])).mockResolvedValueOnce(stream(['data: {"type":"response.completed"}'])));
    const p = new ChatGptPlanProvider("model", 5000);
    for (let i = 0; i < 3; i++) await expect(p.complete(call)).rejects.toMatchObject({ kind: "provider" });
  });
  it("rejects malformed catalogs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data: [] })));
    await expect(fetchChatGptPlanModels()).rejects.toMatchObject({ kind: "provider" });
  });
  it("rejects oversized SSE frames", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream(["data: " + "x".repeat(4 * 1024 * 1024)])));
    await expect(new ChatGptPlanProvider("model", 5000).complete(call)).rejects.toMatchObject({ kind: "provider", detail: "Response event too large" });
  });
  it("returns visible catalog models and labels in server order", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ models: [{ slug: "b", display_name: "B", visibility: "list" }, { slug: "hidden", display_name: "Hidden", visibility: "hide" }, { slug: "a", display_name: "A", visibility: "list" }] })));
    expect(await fetchChatGptPlanModels()).toEqual([{ id: "b", label: "B" }, { id: "a", label: "A" }]);
  });
});
