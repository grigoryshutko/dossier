import "server-only";

import { assertChatGptPlanBackgroundAllowed, getChatGptPlanAccessToken } from "@/lib/chatgpt-plan";
import { isAiBackgroundExecution } from "@/lib/ai/execution";
import { AiError } from "../errors";
import { BaseProvider, withJsonSchema, type ChatAnswer, type ChatCall } from "../provider";

const API = "https://api.openai.com/v1";
const LIMIT = 4 * 1024 * 1024;
const PLAN_LIMITS = new Set(["subscription_sharing_usage_limit_exceeded", "subscription_sharing_usage_unavailable"]);

function errorFor(value: unknown, status?: number): AiError {
  const obj = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const nested = obj.error && typeof obj.error === "object" ? obj.error as Record<string, unknown> : {};
  const response = obj.response && typeof obj.response === "object" ? obj.response as Record<string, unknown> : {};
  const responseError = response.error && typeof response.error === "object" ? response.error as Record<string, unknown> : {};
  const code = [obj.code, nested.code, responseError.code, nested.type, responseError.type].find(x => typeof x === "string" && PLAN_LIMITS.has(x));
  if (code) return new AiError("rate-limited", "Your ChatGPT plan usage limit has been reached or is unavailable. Please try again later or check your plan.", String(code));
  if (status === 401 || status === 403) return new AiError("auth", "Your ChatGPT plan connection needs attention. Reconnect it in Settings → AI provider.");
  if (status === 429) return AiError.of("rate-limited");
  return AiError.of("provider", status ? `HTTP ${status}` : "ChatGPT plan response failed");
}

async function request(path: string, signal: AbortSignal, init: RequestInit = {}): Promise<Response> {
  const token = await getChatGptPlanAccessToken(signal);
  const response = await fetch(`${API}${path}`, {
    ...init, signal, redirect: "manual",
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
  });
  if (response.status >= 300 && response.status < 400) throw AiError.of("provider", "Redirect refused");
  if (!response.ok) {
    // Only inspect a bounded response and never expose the server's message.
    let payload: unknown;
    if (response.body) {
      const reader = response.body.getReader();
      let text = "";
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const chunk = await reader.read();
          text += decoder.decode(chunk.value, { stream: !chunk.done });
          if (text.length > LIMIT) break;
          if (chunk.done) { payload = JSON.parse(text); break; }
        }
      } catch { /* no usable error payload */ }
      finally { try { await reader.cancel(); } catch { /* already closed */ } reader.releaseLock(); }
    }
    throw errorFor(payload, response.status);
  }
  return response;
}

/** Visible plan models, in the order supplied by the catalog. */
export async function fetchChatGptPlanModels(signal: AbortSignal = AbortSignal.timeout(30_000)): Promise<{ id: string; label: string }[]> {
  const response = await request("/models", signal);
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || !Array.isArray((data as { models?: unknown }).models)) throw AiError.of("provider", "Invalid model catalog");
  return (data as { models: unknown[] }).models.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const model = item as Record<string, unknown>;
    return model.visibility === "list" && typeof model.slug === "string" && model.slug && typeof model.display_name === "string"
      ? [{ id: model.slug, label: model.display_name }] : [];
  });
}

export class ChatGptPlanProvider extends BaseProvider {
  readonly kind = "OPENAI" as const;

  protected override acceptsTemperature(): boolean { return false; }

  protected async fetchModels(signal: AbortSignal): Promise<string[]> {
    return (await fetchChatGptPlanModels(signal)).map(model => model.id);
  }

  protected async chat(call: ChatCall): Promise<ChatAnswer> {
    if (isAiBackgroundExecution()) {
      try { await assertChatGptPlanBackgroundAllowed(); }
      catch { throw AiError.config("Scheduled AI work is paused. Allow background ChatGPT plan use or reconnect in Settings → AI connection."); }
    }
    const response = await request("/responses", call.signal, {
      method: "POST",
      body: JSON.stringify({ model: call.model, input: call.messages, instructions: call.json ? withJsonSchema(call.system, call.json.schema) : call.system, store: false, stream: true }),
    });
    if (!response.body) throw AiError.of("provider", "Missing response stream");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", output = "", completed = false;
    const process = (event: string) => {
      const data = event.split(/\r\n|\r|\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
      if (!data || data === "[DONE]") return;
      let value: Record<string, unknown>;
      try { value = JSON.parse(data); } catch { throw AiError.of("provider", "Invalid response event"); }
      if (!value || typeof value !== "object") throw AiError.of("provider", "Invalid response event");
      if (value.type === "error" || value.type === "response.failed" || value.type === "response.incomplete") throw errorFor(value);
      if (value.type === "response.refusal.delta" || value.type === "response.refusal.done") throw new AiError("provider", "The model declined to answer this one. Try rewording it, or try again.", "refusal");
      if (value.type === "response.output_text.delta" && typeof value.delta === "string") {
        output += value.delta;
        if (output.length > LIMIT) throw AiError.of("provider", "Response too large");
      }
      if (value.type === "response.completed") completed = true;
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        if (buffer.length > LIMIT) throw AiError.of("provider", "Response event too large");
        let match: RegExpExecArray | null;
        while ((match = /\r\n\r\n|\n\n|\r\r|\r\n\n|\n\r\n/.exec(buffer))) {
          process(buffer.slice(0, match.index));
          buffer = buffer.slice(match.index + match[0].length);
        }
        if (done) break;
      }
      if (buffer.trim()) throw AiError.of("provider", "Partial response event");
      if (!completed) throw AiError.of("provider", "Response stream ended before completion");
      if (!output.trim()) throw AiError.of("provider", "Empty response");
      return { text: output, cutOff: false };
    } finally {
      try { await reader.cancel(); } catch { /* already closed or aborted */ }
      reader.releaseLock();
    }
  }
}
