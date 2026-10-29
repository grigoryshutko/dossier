import { NextResponse } from "next/server";
import { route } from "@/lib/route";
import { cancelChatGptPlanPairing } from "@/lib/chatgpt-plan";

export const POST = route(async () => NextResponse.json(await cancelChatGptPlanPairing()));
