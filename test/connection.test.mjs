import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('a failed status request visibly marks retained data stale and recovers on reconnect', async () => {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, { value: id === 'status-filter' ? 'all' : '', textContent: '', innerHTML: '', clientWidth: 350, hidden: false, disabled: false, classList: { add: v => classes.add(v), toggle: (v, flag) => flag ? classes.add(v) : classes.delete(v), contains: v => classes.has(v) }, setAttribute() {}, addEventListener() {}, replaceChildren() { this.innerHTML = ''; } });
    }
    return elements.get(id);
  }
  const now = new Date().toISOString();
  const state = { owner: false, stale: false, collectorStale: false, startedAt: now, monitoring: { historySince: now }, checkedAt: now, metrics: { at: now, cpu: 10, memory: 30, gpu: 0, uptime: 3600 }, sites: [{ id: 'test.example.com', domain: 'test.example.com', name: 'Example', state: 'up', latency: 10, history: [], samples: 1, uptime: 100 }], history: [], events: [] };
  const context = vm.createContext({ document: { hidden: false, getElementById: element, querySelectorAll: () => [], addEventListener() {} }, window: { addEventListener() {} }, fetch: async () => ({ ok: true, json: async () => structuredClone(state) }), AbortSignal, setInterval() {}, console });
  vm.runInContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  await new Promise(setImmediate);
  assert.equal(element('health-title').textContent, 'All websites operational');
  assert(!element('chart-note').textContent.includes('Invalid Date'));
  context.fetch = async () => { throw new Error('connection lost'); };
  await vm.runInContext('refresh()', context);
  assert.equal(element('health-title').textContent, 'Live connection interrupted');
  assert(element('health-banner').classList.contains('warning'));
  assert.match(element('sites-body').innerHTML, /Unknown/);
  assert.match(element('error-banner').textContent, /last received readings/);
  context.fetch = async () => ({ ok: true, json: async () => structuredClone(state) });
  await vm.runInContext('refresh()', context);
  assert.equal(element('health-title').textContent, 'All websites operational');
  assert.equal(element('error-banner').hidden, true);
});
