#!/usr/bin/env node
// Run on the computer with the browser, then open the link from Dossier settings.
import http from 'node:http';
import https from 'node:https';
import { randomBytes, randomUUID, createHash, createPublicKey, verify } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--dossier-origin') {
  console.error('Usage: node chatgpt-login.mjs --dossier-origin https://your-dossier-origin');
  process.exit(1);
}
const configuredOrigin = args[1];
const redirect = 'http://127.0.0.1:1455/auth/callback';
const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const rnd = () => randomBytes(32).toString('base64url');
let attempt;
const localDir = path.join(homedir(), '.config', 'dossier');
await mkdir(localDir, { recursive: true, mode: 0o700 });
const hostFile = path.join(localDir, 'chatgpt-host-id');
try { await writeFile(hostFile, `urn:uuid:${randomUUID()}`, { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
const hostId = (await readFile(hostFile, 'utf8')).trim();
function publicIp(ip) {
  if (isIP(ip) === 4) { const [a,b] = ip.split('.').map(Number); return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))); }
  if (isIP(ip) === 6) return !(/^(::|fc|fd|fe[89ab]|ff)/i.test(ip) || ip.includes('.'));
  return false;
}
async function target(origin) {
  const u = new URL(origin);
  const dev = process.env.CHATGPT_PLAN_ALLOW_INSECURE_DEV === '1';
  if (u.origin !== origin || u.username || u.password || (!dev && u.protocol !== 'https:') || (dev && !['http:', 'https:'].includes(u.protocol))) throw Error('Invalid target origin');
  const addresses = await lookup(u.hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (!addresses.length || (!dev && addresses.some(a => !publicIp(a.address)))) throw Error('Target must resolve to a public address');
  return { u, address: addresses[0] };
}
function sendImport(t, data) {
  return new Promise((resolve, reject) => {
    const bytes = JSON.stringify(data); const transport = t.u.protocol === 'https:' ? https : http;
    const req = transport.request(new URL('/api/chatgpt-plan/import', t.u), { method:'POST', headers: { 'content-type':'application/json', 'content-length': Buffer.byteLength(bytes) }, lookup: (_host, opts, cb) => opts.all ? cb(null, [t.address]) : cb(null, t.address.address, t.address.family), timeout: 15000 }, res => { res.resume(); res.on('end', () => res.statusCode === 200 ? resolve() : reject(Error('Import rejected'))); });
    req.on('timeout', () => req.destroy()); req.on('error', reject); req.end(bytes);
  });
}
async function verifyId(token, clientId, nonce) {
  const parts = token.split('.'); if (parts.length !== 3) throw Error('Invalid ID token');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url')); const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw Error('Invalid ID token algorithm');
  const response = await fetch(`${issuer}/.well-known/jwks.json`, { redirect: 'error', signal: AbortSignal.timeout(10000) }); if (!response.ok) throw Error('Cannot verify identity');
  const keys = await response.json(); const key = keys.keys.find(k => k.kid === header.kid && k.kty === 'RSA');
  if (!key || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format:'jwk' }), Buffer.from(parts[2], 'base64url')) || claims.iss !== issuer || !(Array.isArray(claims.aud) ? claims.aud.includes(clientId) : claims.aud === clientId) || typeof claims.exp !== 'number' || claims.exp <= Date.now()/1000 || claims.nonce !== nonce || typeof claims.sub !== 'string' || !claims.sub) throw Error('Invalid ID token');
}
const page = `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Dossier ChatGPT sign-in</title><p id="message">Starting sign-in…</p><script>const p=Object.fromEntries(new URLSearchParams(location.hash.slice(1)));history.replaceState(null,'',location.pathname);fetch('/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p)}).then(async r=>{if(!r.ok)throw Error();location.href=(await r.json()).url}).catch(()=>document.getElementById('message').textContent='Could not start sign-in. Return to Dossier and create a new connection link.');</script>`;
const server = http.createServer(async (req,res) => {
  res.setHeader('Cache-Control','no-store'); res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('X-Content-Type-Options','nosniff');
  const end = (status, message) => { res.writeHead(status, {'Content-Type':'text/plain; charset=utf-8'}); res.end(message); };
  if (req.headers.host !== '127.0.0.1:1455') return end(403,'Invalid host');
  const u = new URL(req.url, 'http://127.0.0.1:1455');
  if (req.method === 'GET' && u.pathname === '/') { res.writeHead(200, {'Content-Type':'text/html; charset=utf-8', 'Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'"}); return res.end(page); }
  if (req.method === 'POST' && u.pathname === '/start') {
    if (req.headers.origin !== 'http://127.0.0.1:1455' || attempt) return end(403,'Invalid request');
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 4096) return end(413,'Too large'); }
    try {
      const p = JSON.parse(raw); if (!/^[A-Za-z0-9_-]{43}$/.test(p.capability) || !/^[A-Za-z0-9_-]{43}$/.test(p.nonce) || (p.clientId && !/^oaiapp_[A-Za-z0-9_-]+$/.test(p.clientId))) throw Error();
      if (p.origin !== configuredOrigin) throw Error('Pairing origin does not match configured origin');
      const destination = await target(configuredOrigin); const state = rnd(), verifier = rnd();
      attempt = { destination, capability:p.capability, nonce:p.nonce, clientId:p.clientId, state, verifier, expires: Date.now()+600000 };
      const auth = new URL(`${issuer}/api/accounts/authorize`); const params = { client_id:p.clientId || 'dynamic_agent_client', ext_agent_host_id:hostId, response_type:'code', redirect_uri:redirect, scope:scopes, resource, state, nonce:p.nonce, code_challenge_method:'S256', code_challenge:createHash('sha256').update(verifier).digest('base64url'), ...(p.clientId ? {} : {agent_name_hint:'Dossier (Grigory fork)'}) }; auth.search = new URLSearchParams(params).toString();
      res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify({url:auth.toString()}));
    } catch { return end(400,'Invalid pairing'); }
  }
  if (req.method === 'GET' && u.pathname === '/auth/callback') {
    const a = attempt; attempt = undefined;
    try {
      if (!a || a.expires < Date.now() || u.searchParams.get('state') !== a.state || u.searchParams.has('error')) throw Error();
      const clientId = u.searchParams.get('client_id') || a.clientId; if (!clientId || !/^oaiapp_[A-Za-z0-9_-]+$/.test(clientId) || (a.clientId && clientId !== a.clientId) || !u.searchParams.get('code')) throw Error();
      const response = await fetch(`${issuer}/api/accounts/oauth/token`, { method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({grant_type:'authorization_code',client_id:clientId,code:u.searchParams.get('code'),code_verifier:a.verifier,redirect_uri:redirect,resource}), redirect:'error', signal:AbortSignal.timeout(15000) });
      if (!response.ok) throw Error(); const t = await response.json();
      if (typeof t.token_type !== 'string' || t.token_type.toLowerCase() !== 'bearer' || typeof t.id_token !== 'string' || typeof t.access_token !== 'string' || (t.refresh_token !== undefined && typeof t.refresh_token !== 'string') || typeof t.scope !== 'string' || typeof t.expires_in !== 'number' || t.expires_in <= 0) throw Error();
      await verifyId(t.id_token,clientId,a.nonce);
      await sendImport(a.destination,{capability:a.capability,credentials:{clientId,idToken:t.id_token,accessToken:t.access_token,refreshToken:t.refresh_token || '',scopes:t.scope.split(' '),expiresAt:Date.now()+t.expires_in*1000}});
      end(200,'Connected. You may close this tab and return to Dossier.'); server.close();
    } catch { end(400,'Sign-in failed. Return to Dossier and create a new connection link.'); }
    return;
  }
  end(404,'Not found');
});
server.listen(1455,'127.0.0.1', () => console.log('Dossier sign-in helper is listening on 127.0.0.1:1455. Open the connection link from Dossier settings.'));
