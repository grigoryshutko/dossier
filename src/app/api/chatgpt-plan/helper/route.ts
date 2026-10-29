import { readFile } from "node:fs/promises";
import path from "node:path";
import { route } from "@/lib/route";

export const GET = route(async () => new Response(await readFile(path.join(process.cwd(), "scripts/chatgpt-login.mjs"), "utf8"), {
  headers: { "content-type": "text/javascript; charset=utf-8", "content-disposition": "attachment; filename=chatgpt-login.mjs", "cache-control": "private, no-store" },
}));
