import { NextResponse } from "next/server";
import { route } from "@/lib/route";
import { disconnectChatGptPlan, getChatGptPlanView } from "@/lib/chatgpt-plan";
const handler = route(async () => { const result = await disconnectChatGptPlan(); return NextResponse.json({ ...(await getChatGptPlanView()), ...result }); });
export const POST = handler;
export const DELETE = handler;
