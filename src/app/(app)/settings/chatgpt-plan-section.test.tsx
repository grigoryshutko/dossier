import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiSettingsView } from "@/lib/ai/provider-options";
import type { ChatGptPlanView } from "@/lib/chatgpt-plan";
import { ChatGptPlanSection } from "./chatgpt-plan-section";

vi.mock("./ai-provider-section", () => ({ AiProviderSection: () => <p>API settings</p> }));
const api: AiSettingsView = { provider: "LOCAL", baseUrl: "http://localhost:11434", model: "local", keyState: "none" };
const disconnected: ChatGptPlanView = { connected: false, planAuthorized: false, enabled: false, email: null, model: null, allowBackground: false, needsReauth: false };
const connected: ChatGptPlanView = { connected: true, planAuthorized: true, enabled: true, email: "person@example.com", model: "available-model", allowBackground: false, needsReauth: false };
afterEach(() => vi.unstubAllGlobals());

describe("ChatGptPlanSection", () => {
  it("explains the local setup before sign-in and keeps API settings available", async () => {
    render(<ChatGptPlanSection initial={disconnected} apiInitial={api} />);
    expect(screen.getByText("API settings")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "ChatGPT plan" }));
    expect(screen.getByRole("link", { name: /download the sign-in helper/i })).toHaveAttribute("href", "/api/chatgpt-plan/helper");
    expect(screen.getByText(/node chatgpt-login.mjs --dossier-origin/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue with ChatGPT" })).toBeInTheDocument();
    expect(screen.getByText(/separate job source/i)).toBeInTheDocument();
  });
  it("loads available models and saves explicit background consent", async () => {
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => ({ ok: true, json: async () => url.endsWith("models") ? { models: ["available-model", "another-model"], labels: { "another-model": "Another model" } } : { ...connected, allowBackground: JSON.parse(String(options?.body)).allowBackground } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatGptPlanSection initial={connected} apiInitial={api} />);
    expect(screen.getByText("Using ChatGPT plan")).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "Another model" })).toBeInTheDocument();
    const consent = screen.getByRole("checkbox", { name: /allow scheduled job agent/i });
    expect(consent).not.toBeChecked();
    await userEvent.click(consent);
    await waitFor(() => expect(consent).toBeChecked());
    expect(fetchMock).toHaveBeenCalledWith("/api/chatgpt-plan/preferences", expect.objectContaining({ method: "POST", body: JSON.stringify({ allowBackground: true }) }));
  });
  it("does not enable plan use for an identity-only connection", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatGptPlanSection initial={{ ...connected, enabled: false, planAuthorized: false }} apiInitial={api} />);
    await userEvent.click(screen.getByRole("radio", { name: "ChatGPT plan" }));
    expect(screen.getByText(/did not grant ChatGPT plan access/i)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /allow scheduled/i })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("reports unconfirmed remote revocation after removing the local connection", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith("models") ? { models: [], labels: {} } : { ...disconnected, revocationConfirmed: false } })));
    render(<ChatGptPlanSection initial={connected} apiInitial={api} />);
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText(/removal from OpenAI could not be confirmed/i)).toBeInTheDocument();
  });

  it("cancels the server pairing and isolates the sign-in popup", async () => {
    const popup = { opener: window, location: { href: "" }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const fetchMock = vi.fn(async (url: string) => ({ ok: true, json: async () => url.endsWith("connect") ? { url: "https://example.com/sign-in" } : {} }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ChatGptPlanSection initial={disconnected} apiInitial={api} />);
    await userEvent.click(screen.getByRole("radio", { name: "ChatGPT plan" }));
    await userEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }));
    expect(popup.opener).toBeNull();
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/chatgpt-plan/cancel", expect.objectContaining({ method: "POST" }));
    vi.restoreAllMocks();
  });

});
