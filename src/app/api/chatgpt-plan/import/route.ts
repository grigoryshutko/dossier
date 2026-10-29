import { NextResponse, type NextRequest } from "next/server";
import { importChatGptPlan } from "@/lib/chatgpt-plan";
// Deliberately capability-authenticated: the local helper has no Dossier cookie.
export async function POST(request: NextRequest) {
  const fail = (status: number) => NextResponse.json({ error: "Import failed" }, { status, headers: { "cache-control": "no-store" } });
  if (request.headers.get("content-type") !== "application/json" || Number(request.headers.get("content-length") || 0) > 65536) return fail(400);
  try { const reader = request.body?.getReader(); if (!reader) return fail(400); const chunks: Uint8Array[] = []; let size = 0; while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 65536) { await reader.cancel(); return fail(413); } chunks.push(value); } const body = JSON.parse(Buffer.concat(chunks).toString("utf8")); await importChatGptPlan(body.capability, body.credentials); return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } }); } catch { return fail(400); }
}
