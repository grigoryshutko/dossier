import { NextResponse } from "next/server";
import { route } from "@/lib/route";
import { getChatGptPlanView } from "@/lib/chatgpt-plan";
export const GET = route(async () => NextResponse.json(await getChatGptPlanView()));
