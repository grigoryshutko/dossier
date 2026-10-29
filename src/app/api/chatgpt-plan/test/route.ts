import { NextResponse } from "next/server";
import { route } from "@/lib/route";
import { getChatGptPlanView } from "@/lib/chatgpt-plan";
import { ChatGptPlanProvider } from "@/lib/ai/providers/chatgpt-plan";
import { AiError } from "@/lib/ai/errors";

export const POST = route(async () => {
  try {
    const view = await getChatGptPlanView();
    const result = await new ChatGptPlanProvider(view.model, 120_000).test();
    return NextResponse.json({ connected: true, model: result.model, seconds: result.latencyMs / 1000 });
  } catch (error) {
    return NextResponse.json({ connected: false, message: error instanceof AiError ? error.message : "Reconnect your ChatGPT plan and try again." });
  }
});
