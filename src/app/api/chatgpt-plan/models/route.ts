import { NextResponse } from "next/server";
import { route } from "@/lib/route";
import { fetchChatGptPlanModels } from "@/lib/ai/providers/chatgpt-plan";
import { AiError } from "@/lib/ai/errors";

export const GET = route(async () => {
  try {
    const catalog = await fetchChatGptPlanModels();
    return NextResponse.json({ models: catalog.map(m => m.id), labels: Object.fromEntries(catalog.map(m => [m.id, m.label])) });
  } catch (error) {
    return NextResponse.json({ models: [], problem: error instanceof AiError ? error.message : "Reconnect your ChatGPT plan to load available models." });
  }
});
