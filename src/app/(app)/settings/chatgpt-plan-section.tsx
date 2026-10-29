"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import type { AiSettingsView } from "@/lib/ai/provider-options";
import type { ChatGptPlanView } from "@/lib/chatgpt-plan";

import { AiProviderSection } from "./ai-provider-section";
import { SettingsSectionIntro } from "./settings-screen";

async function request<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(`/api/chatgpt-plan/${path}`, body === undefined ? { cache: "no-store" } : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("The request failed. Please try again.");
  return result as T;
}

export function ChatGptPlanSection({ initial, apiInitial }: { initial: ChatGptPlanView; apiInitial: AiSettingsView }) {
  const [view, setView] = useState(initial);
  const [choice, setChoice] = useState<"plan" | "api">(initial.enabled ? "plan" : "api");
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [origin, setOrigin] = useState("");
  useEffect(() => { setOrigin(window.location.origin); }, []);
  const [modelsProblem, setModelsProblem] = useState("");
  const [testMessage, setTestMessage] = useState("");

  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    const started = Date.now();
    const poll = async () => {
      try {
        const next = await request<ChatGptPlanView>("status");
        if (cancelled) return;
        if (next.connected && !next.needsReauth) {
          setView(next); setPending(false); setMessage(next.planAuthorized ? "Your ChatGPT account is connected." : "Your account is connected, but it did not grant ChatGPT plan access.");
        } else if (Date.now() - started >= 10 * 60_000) {
          setPending(false); setMessage("Sign-in timed out. Start the helper and try connecting again.");
        }
      } catch {
        if (!cancelled) { setPending(false); setMessage("Could not check the connection. Check your connection and try again."); }
      }
    };
    const timer = setInterval(() => void poll(), 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [pending]);

  useEffect(() => {
    if (!view.connected || !view.planAuthorized || !view.enabled || view.needsReauth) return;
    let current = true;
    void request<{ models: string[]; labels: Record<string, string>; problem?: string }>("models").then((result) => {
      if (current) { setModels(result.models); setLabels(result.labels ?? {}); setModelsProblem(result.problem ?? ""); }
    }).catch((error: Error) => { if (current) setModelsProblem(error.message); });
    return () => { current = false; };
  }, [view.connected, view.planAuthorized, view.enabled, view.needsReauth]);

  const update = async (changes: { enabled?: boolean; model?: string; allowBackground?: boolean }) => {
    setBusy(true); setMessage(""); setTestMessage("");
    try { const next = await request<ChatGptPlanView>("preferences", changes); setView(next); return true; }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not save your preference."); return false; }
    finally { setBusy(false); }
  };
  const choose = async (next: "plan" | "api") => {
    if (next === "api" && view.enabled && !(await update({ enabled: false }))) return;
    if (next === "plan" && view.connected && view.planAuthorized && !view.needsReauth && !view.enabled && !(await update({ enabled: true }))) return;
    setChoice(next); setPending(false);
  };
  const connect = async () => {
    // Open synchronously to avoid popup blockers; the helper URL is returned by the server.
    const popup = window.open("about:blank", "_blank");
    if (!popup) { setMessage("Allow pop-ups for this site, then try again."); return; }
    setBusy(true); setMessage("");
    try { const result = await request<{ url: string }>("connect", {}); popup.opener = null; popup.location.href = result.url; setPending(true); }
    catch (error) { popup.close(); setMessage(error instanceof Error ? error.message : "Could not start sign-in."); }
    finally { setBusy(false); }
  };
  const disconnect = async () => {
    setBusy(true); setMessage("");
    try { const result = await request<ChatGptPlanView & { revocationConfirmed: boolean | null }>("disconnect", {}); setView(result); setPending(false); setTestMessage(""); setMessage(result.revocationConfirmed === false ? "The local connection was removed, but removal from OpenAI could not be confirmed. You can remove access from your OpenAI account." : "ChatGPT account disconnected from Dossier."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not disconnect."); }
    finally { setBusy(false); }
  };
  const cancel = async () => {
    setBusy(true);
    try { await request("cancel", {}); setPending(false); setMessage("Sign-in cancelled. You can try again when the helper is running."); }
    catch { setMessage("Could not cancel sign-in. Please try again."); }
    finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true); setTestMessage("Sending a short test prompt…");
    try {
      const result = await request<{ connected: boolean; model?: string; seconds?: number; message?: string }>("test", {});
      setTestMessage(result.connected ? `${result.model ?? "Model"} answered${result.seconds !== undefined ? ` in ${result.seconds.toLocaleString("en-US")} s` : ""}.` : (result.message ?? "The test failed. Check your plan limits or reconnect."));
    } catch (error) { setTestMessage(error instanceof Error ? error.message : "The test failed. Check your plan limits or reconnect."); }
    finally { setBusy(false); }
  };

  return <>
    <SettingsSectionIntro title="AI connection">Choose how Dossier reads job postings and writes your drafts.</SettingsSectionIntro>
    <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-2" disabled={busy}>
      <legend className="sr-only">AI connection</legend>
      {([ ["plan", "ChatGPT plan"], ["api", "API or local model"] ] as const).map(([value, label]) => <label key={value} className="flex cursor-pointer items-center gap-3 rounded-card border border-line-card bg-card p-[18px] has-checked:border-primary">
        <input type="radio" name="ai-connection" value={value} checked={choice === value} onChange={() => void choose(value)} /> {label}
      </label>)}
    </fieldset>
    {message && <p role="status" className="text-sm text-muted">{message}</p>}
    {choice === "api" ? <AiProviderSection initial={apiInitial} /> : <Card className="flex flex-col gap-4">
      {view.connected && !view.needsReauth && !view.planAuthorized ? <>
        <p className="font-medium">ChatGPT account connected</p>
        <p role="status" className="text-sm">This sign-in identified your account but did not grant ChatGPT plan access. Dossier cannot use your plan with this connection.</p>
        <Button variant="secondary" disabled={busy} onClick={() => void disconnect()}>Disconnect account</Button>
      </> : view.connected && !view.needsReauth && view.planAuthorized ? <>
        <p className="font-medium">{view.enabled ? "Using ChatGPT plan" : "ChatGPT account connected"}</p>
        <p className="text-sm text-muted">Connected account: {view.email ?? "ChatGPT account"} · <a className="underline" href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">Check ChatGPT usage</a></p>
        <Select label="Model" value={view.model ?? ""} disabled={busy || models.length === 0} onChange={(event) => void update({ model: event.target.value })} hint={modelsProblem || (models.length === 0 ? "No models available. Check your connection or try again." : undefined)}>
          <option value="" disabled>Choose a model</option>
          {view.model && !models.includes(view.model) && <option value={view.model}>{view.model} (currently selected)</option>}
          {models.map((model) => <option key={model} value={model}>{labels[model] ?? model}</option>)}
        </Select>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={view.allowBackground} disabled={busy} onChange={(event) => void update({ allowBackground: event.target.checked })} /> <span>Allow scheduled job agent, startup, and inbox AI tasks to use my ChatGPT plan while my browser is closed.</span></label>
        <div className="flex flex-wrap gap-3"><Button variant="secondary" disabled={busy} onClick={() => void test()}>Test connection</Button><Button variant="secondary" disabled={busy} onClick={() => void disconnect()}>Disconnect</Button></div>
        {testMessage && <p role="status" className="text-sm">{testMessage}</p>}
        <p className="text-sm text-muted">If you reach a plan limit, check your usage and try again later. Dossier will not automatically switch to a paid API. Disconnect removes the local connection; revoke access in ChatGPT separately if desired.</p>
      </> : <>
        {view.needsReauth && <p role="alert">Your ChatGPT connection needs to be renewed. Follow the steps below to reconnect.</p>}
        <p className="font-medium">Connect your ChatGPT account</p>
        <p className="text-sm text-muted">For a personal VPS, first set up the local helper on the computer where you use your browser. This one-time setup completes sign-in locally and securely transfers the connection to your VPS.</p>
        <ol className="list-decimal space-y-2 pl-5 text-sm"><li><a href="/api/chatgpt-plan/helper" className="underline" download>Download the sign-in helper</a>.</li><li>Run <code>node chatgpt-login.mjs --dossier-origin '{origin.replaceAll("'", "'\\''")}'</code> on your computer. The helper listens on 127.0.0.1:1455.</li><li>With the helper running, select Continue with ChatGPT and finish sign-in in the new tab.</li></ol>
        <div className="flex flex-wrap gap-3"><Button disabled={busy || pending} onClick={() => void connect()}>Continue with ChatGPT</Button>{pending && <Button variant="secondary" disabled={busy} onClick={() => void cancel()}>Cancel</Button>}</div>
        {pending && <p role="status" className="text-sm text-muted">Waiting for sign-in to finish…</p>}
        {view.connected && <Button variant="secondary" disabled={busy} onClick={() => void disconnect()}>Disconnect account</Button>}
      </>}
      <p className="text-sm text-muted">A ChatGPT plan does not provide JSearch or Adzuna credentials. Find Jobs and the Agent need a separate job source configured in Jobs settings. <a href="https://github.com/grigoryshutko/dossier/tree/feat/chatgpt-plan-sign-in" target="_blank" rel="noreferrer" className="underline">Source code for this modified version</a>.</p>
    </Card>}
  </>;
}
