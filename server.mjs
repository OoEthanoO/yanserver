import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Monitor } from './lib/monitor.mjs';
import { hashCode, verifyCode, signSession, validSession, sessionCookie, sameOrigin, publicSnapshot } from './lib/security.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3800);
const origin = process.env.PUBLIC_ORIGIN || `http://localhost:${port}`;
const dataDir = process.env.YANSERVER_DATA || path.join(root, '.runtime');
const secure = origin.startsWith('https://');
await mkdir(dataDir, { recursive: true });
let auth;
try { auth = JSON.parse(await readFile(path.join(dataDir, 'auth.json'), 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const code = randomBytes(24).toString('base64url');
  auth = { ...await hashCode(code), secret: randomBytes(48).toString('base64url') };
  await writeFile(path.join(dataDir, 'auth.json'), JSON.stringify(auth), { mode: 0o600, flag: 'wx' });
  await writeFile(path.join(dataDir, 'owner-access.txt'), `YanServer owner access\n${origin}\n\nAccess code: ${code}\n\nEnter once using Owner access. This browser is remembered for 30 days.\nKeep this file private. Rotate with scripts/rotate-access.mjs while the server is stopped.\n`, { mode: 0o600, flag: 'wx' });
}
const monitor = new Monitor({ dataDir, collector: process.env.NO_COLLECTOR !== '1', caddyUrl: process.env.CADDY_API || undefined });
const attempts = new Map();
let activeLogins = 0;
const cookie = (token, age = 30 * 86400) => `yanserver_owner=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
const assets = new Map(await Promise.all(['index.html', 'style.css', 'app.js', 'favicon.svg'].map(async file => [file, await readFile(path.join(root, 'public', file))])));
function json(res, code, value, extra = {}) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...extra }); res.end(JSON.stringify(value)); }
async function body(req) {
  const parts = []; let length = 0;
  for await (const part of req) { length += part.length; if (length > 1024) throw new Error('Body too large'); parts.push(part); }
  return JSON.parse(Buffer.concat(parts).toString());
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('Vary', 'Cookie');
  try {
    const url = new URL(req.url, origin);
    const owner = validSession(sessionCookie(req), auth.secret);
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { status: 'ok', service: 'yanserver', commit: process.env.YANSERVER_COMMIT || 'development', hosting: 'finprint-host' });
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const snapshot = publicSnapshot(monitor.state);
      snapshot.owner = owner;
      snapshot.stale = !monitor.state.checkedAt || Date.now() - Date.parse(monitor.state.checkedAt) > 150000;
      snapshot.collectorStale = !monitor.state.collectorAt || Date.now() - Date.parse(monitor.state.collectorAt) > 90000;
      if (owner) snapshot.private = { ...monitor.state.private, sites: monitor.state.sites.map(s => ({ id: s.id, upstreams: s.upstreams, roots: s.roots })) };
      return json(res, 200, snapshot);
    }
    if (req.method === 'POST' && ['/api/login', '/api/logout'].includes(url.pathname)) {
      if (!sameOrigin(req, origin)) return json(res, 403, { error: 'Open the dashboard at its normal address and try again.' });
      if (url.pathname === '/api/logout') return json(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
      // Only the loopback-bound reverse proxy can connect. Caddy overwrites X-Forwarded-For.
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',').at(-1).trim();
      const now = Date.now();
      for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
      const rate = attempts.get(ip) || { count: 0, until: now + 15 * 60000 };
      if (rate.count >= 6 || activeLogins >= 3 || attempts.size >= 10000) return json(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' }, { 'Retry-After': '900' });
      rate.count++; attempts.set(ip, rate); activeLogins++;
      try {
        const input = await body(req);
        if (!await verifyCode(input.code, auth)) return json(res, 401, { error: 'That access code is not correct.' });
        attempts.delete(ip);
        return json(res, 200, { ok: true }, { 'Set-Cookie': cookie(signSession(auth.secret)) });
      } finally { activeLogins--; }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!assets.has(file)) return json(res, 404, { error: 'Not found' });
    const types = { html: 'text/html', css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml' };
    res.setHeader('Content-Type', `${types[file.split('.').at(-1)]}; charset=utf-8`);
    res.writeHead(200); res.end(req.method === 'HEAD' ? undefined : assets.get(file));
  } catch (e) { if (!res.headersSent) json(res, 400, { error: 'Invalid request' }); else res.end(); }
});
server.requestTimeout = 15000; server.headersTimeout = 10000;
server.listen(port, '127.0.0.1', () => console.log(`YanServer listening on 127.0.0.1:${port}`));
monitor.start().catch(e => { console.error('Startup:', e.message); process.exitCode = 1; server.close(); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await monitor.stop(); server.close(() => process.exit(0)); });
