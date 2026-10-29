import { NextResponse } from "next/server";
import { route } from "@/lib/route";
import { disconnectChatGptPlan, getChatGptPlanView } from "@/lib/chatgpt-plan";
const disconnect = async () => { const result = await disconnectChatGptPlan(); return NextResponse.json({ ...(await getChatGptPlanView()), ...result }); };
export const POST = route(disconnect);
export const DELETE = route(disconnect);
