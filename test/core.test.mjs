import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { hashCode, verifyCode, signSession, validSession, sessionCookie, publicSnapshot, sameOrigin } from '../lib/security.mjs';
import { discoverSites, classifyStatus, summarizeChecks, readCaddyInventory } from '../lib/monitor.mjs';

test('owner code verification rejects wrong or malformed credentials', async () => {
  const config = await hashCode('a-long-example-secret-code');
  assert.equal(await verifyCode('a-long-example-secret-code', config), true);
  assert.equal(await verifyCode('a-long-incorrect-secret-code', config), false);
  assert.equal(await verifyCode(null, config), false);
});
test('owner sessions reject tampering, expired tokens, and a rotated secret', () => {
  const now = Date.now(), token = signSession('test-key', now);
  assert.equal(validSession(token, 'test-key', now + 100), true);
  assert.equal(validSession(token + 'x', 'test-key', now), false);
  assert.equal(validSession(token, 'different-key', now), false);
  assert.equal(validSession(token, 'test-key', now + 31 * 864e5), false);
  assert.equal(validSession('bad.input', 'test-key'), false);
  assert.equal(sessionCookie({ headers: { cookie: `other=123; yanserver_owner=${token}` } }), token);
});
test('login and logout require an exact trusted Origin', () => {
  assert.equal(sameOrigin({ headers: { origin: 'https://server.ethanyanxu.com' } }, 'https://server.ethanyanxu.com'), true);
  assert.equal(sameOrigin({ headers: { origin: 'https://attacker.example' } }, 'https://server.ethanyanxu.com'), false);
  assert.equal(sameOrigin({ headers: {} }, 'https://server.ethanyanxu.com'), false);
});
test('public snapshot cannot expose paths, internal endpoints, processes, or collector extras', () => {
  const state = { metrics: { cpu: 3, password: 'private-marker' }, sites: [{ id: 'site', domain: 'site.example.com', upstreams: ['private-marker'], roots: ['private-marker'], unknownFutureField: 'private-marker' }], history: [{ cpu: 5, path: 'private-marker' }], events: [{ scope: 'private', message: 'private-marker' }, { scope: 'site', name: 'site', message: 'Recovered', secret: 'private-marker' }], private: { processes: ['private-marker'] } };
  const output = publicSnapshot(state);
  assert.equal(JSON.stringify(output).includes('private-marker'), false);
  assert.equal(output.sites.length, 1);
  assert.equal(output.events.length, 1);
});
test('Caddy inventory recursively discovers apps, static sites, aliases and excludes auxiliary listeners', () => {
  const config = { public: { listen: [':443'], routes: [{ match: [{ host: ['alpha.example.com', 'www.example.com', '127.0.0.1', '*.example.com'] }], handle: [{ handler: 'subroute', routes: [{ handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: '127.0.0.1:3000' }] }] }] }] }, { match: [{ host: ['static.example.com'] }], handle: [{ handler: 'vars', root: 'C:/site' }, { handler: 'file_server' }] }] }, auxiliary: { listen: ['127.0.0.1:8097'], routes: [{ match: [{ host: ['private.example.com'] }] }] } };
  const sites = discoverSites(config);
  assert.equal(sites.length, 3);
  assert.equal(sites.find(s => s.domain === 'alpha.example.com').kind, 'Application');
  assert.deepEqual(sites.find(s => s.domain === 'static.example.com').roots, ['C:/site']);
  assert.equal(sites.some(s => s.domain === 'private.example.com'), false);
  config.public.routes[0].handle.push({ handler: 'rewrite', path_regexp: [{ match: '(.*)', replace: '/$1' }] });
  assert.equal(discoverSites(config).length, 3);
});
test('availability represents observed checks and leaves unobserved history unknown', () => {
  const now = Date.now();
  const result = summarizeChecks([{ at: now - 90000, state: 'up' }, { at: now - 60000, state: 'down' }, { at: now - 30000, state: 'restricted' }, { at: now - 90000000, state: 'down' }], now);
  assert.equal(result.samples, 3); assert.equal(result.uptime, 66.67);
  assert.equal(result.history.filter(s => s === 'unknown').length, 47);
  assert.equal(result.history.at(-1), 'down');
  assert.equal(summarizeChecks([], now).uptime, null);
});
test('HTTP error pages cannot be labeled operational', () => {
  assert.equal(classifyStatus(200), 'up'); assert.equal(classifyStatus(302), 'up');
  assert.equal(classifyStatus(401), 'restricted'); assert.equal(classifyStatus(403), 'restricted');
  assert.equal(classifyStatus(404), 'degraded'); assert.equal(classifyStatus(503), 'down');
});
test('server inventory client does not send browser fetch metadata', async () => {
  const server = http.createServer((req, res) => {
    assert.equal(req.headers['sec-fetch-mode'], undefined);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ public: { listen: [':443'] } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { assert.deepEqual(await readCaddyInventory(`http://127.0.0.1:${server.address().port}`), { public: { listen: [':443'] } }); }
  finally { await new Promise(resolve => server.close(resolve)); }
});
