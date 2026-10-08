import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
export async function hashCode(code, salt = randomBytes(24).toString('hex')) {
  return { salt, hash: (await derive(code, salt, 64)).toString('hex') };
}
export async function verifyCode(code, config) {
  if (typeof code !== 'string' || code.length < 12 || code.length > 160 || !config?.hash) return false;
  const hash = await derive(code, config.salt, 64);
  const expected = Buffer.from(config.hash, 'hex');
  return expected.length === hash.length && timingSafeEqual(expected, hash);
}
export function signSession(secret, now = Date.now()) {
  const value = Buffer.from(JSON.stringify({ expires: now + 30 * 864e5, nonce: randomBytes(16).toString('hex') })).toString('base64url');
  return `${value}.${createHmac('sha256', secret).update(value).digest('base64url')}`;
}
export function validSession(token, secret, now = Date.now()) {
  try {
    if (!token || token.length > 512) return false;
    const [value, sig, extra] = token.split('.');
    if (extra || !value || !sig) return false;
    const expected = createHmac('sha256', secret).update(value).digest();
    const actual = Buffer.from(sig, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
    const { expires, nonce } = JSON.parse(Buffer.from(value, 'base64url').toString());
    return typeof nonce === 'string' && Number.isFinite(expires) && expires > now && expires <= now + 31 * 864e5;
  } catch { return false; }
}
export function sessionCookie(req) {
  return (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('yanserver_owner='))?.slice(16);
}
export function sameOrigin(req, origin) { return req.headers.origin === origin; }

// Public responses use an explicit allowlist. Never spread collector objects here.
export function publicSnapshot(state) {
  const metrics = state.metrics;
  return {
    now: new Date().toISOString(), startedAt: state.startedAt,
    metrics: { at: metrics.at, cpu: metrics.cpu, memory: metrics.memory, gpu: metrics.gpu, gpuTemperature: metrics.gpuTemperature, networkRx: metrics.networkRx, networkTx: metrics.networkTx, uptime: metrics.uptime, disk: metrics.disk },
    collectorAt: state.collectorAt, checkedAt: state.checkedAt, discoveryAt: state.discoveryAt,
    monitoring: { intervalSeconds: 60, resourceSeconds: 5, source: 'Local HTTPS checks on finprint-host', historySince: state.historySince },
    sites: state.sites.map(s => ({ id: s.id, name: s.name, domain: s.domain, kind: s.kind, state: s.state, statusCode: s.statusCode, latency: s.latency, checkedAt: s.checkedAt, certificateDays: s.certificateDays, uptime: s.uptime, samples: s.samples, history: s.history, detail: s.detail })),
    history: state.history.map(p => ({ at: p.at, cpu: p.cpu, memory: p.memory, gpu: p.gpu, networkRx: p.networkRx, networkTx: p.networkTx })),
    events: state.events.filter(e => e.scope === 'site').map(e => ({ at: e.at, name: e.name, state: e.state, message: e.message })),
  };
}
