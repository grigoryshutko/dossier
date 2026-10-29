import { NextResponse } from "next/server";
import { route } from "@/lib/route";
import { createChatGptPlanPairing } from "@/lib/chatgpt-plan";
export const POST = route(async request => {
  const origin = request.headers.get("origin");
  if (!origin) return NextResponse.json({ error: "Origin required" }, { status: 400 });
  let url: URL; try { url = new URL(origin); } catch { return NextResponse.json({ error: "Invalid origin" }, { status: 400 }); }
  if (url.origin !== origin || (url.protocol !== "https:" && !(process.env.CHATGPT_PLAN_ALLOW_INSECURE_DEV === "1" && url.protocol === "http:"))) return NextResponse.json({ error: "HTTPS is required" }, { status: 400 });
  return NextResponse.json({ url: await createChatGptPlanPairing(origin) });
});
