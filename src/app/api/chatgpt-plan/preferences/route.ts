import { NextResponse } from "next/server";
import { route } from "@/lib/route";
import { saveChatGptPlanPreferences } from "@/lib/chatgpt-plan";
export const POST = route(async request => {
  if (Number(request.headers.get("content-length") || 0) > 1024) return NextResponse.json({ error: "Too large" }, { status: 413 });
  const text = await request.text(); if (text.length > 1024) return NextResponse.json({ error: "Too large" }, { status: 413 });
  let p: Record<string, unknown>; try { p = JSON.parse(text); } catch { return NextResponse.json({ error: "Invalid request" }, { status: 400 }); }
  if (!p || typeof p !== "object" || (p.enabled !== undefined && typeof p.enabled !== "boolean") || (p.allowBackground !== undefined && typeof p.allowBackground !== "boolean") || (p.model !== undefined && p.model !== null && typeof p.model !== "string")) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  try { return NextResponse.json(await saveChatGptPlanPreferences(p as Parameters<typeof saveChatGptPlanPreferences>[0])); } catch { return NextResponse.json({ error: "Invalid preferences" }, { status: 400 }); }
});
