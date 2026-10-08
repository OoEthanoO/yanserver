import os from 'node:os';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const DAY = 864e5;
const names = { chem: 'Chemistry', orgchem: 'Chemistry alias', coolroute: 'CoolRoute', cora: 'CORA', finprint: 'Finprint', freedom: 'Freedom', history: 'History', judge: 'Online Judge', learn: 'YanLearn', map: 'Site map', mystery: 'YanMystery', oj: 'Judge alias', presence: 'YanPresence', sgemm: 'Bare Metal Bard', stroj: 'Stroj', studio: 'YanStudio', tasks: 'YanTasks', tides: 'Tides', server: 'YanServer' };
export function displayName(domain) {
  if (domain === 'ethanyanxu.com') return 'Portfolio';
  if (domain === 'strhistory.ca') return 'STR History';
  if (domain.startsWith('www.')) return displayName(domain.slice(4)) + ' alias';
  return names[domain.split('.')[0]] || domain.split('.')[0];
}
export function discoverSites(config) {
  const found = new Map();
  function walk(value, hosts = []) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(v => walk(v, hosts)); return; }
    const own = (Array.isArray(value.match) ? value.match : []).flatMap(m => m.host || []).filter(h => typeof h === 'string' && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h) && !net.isIP(h) && h !== 'localhost');
    const active = own.length ? own : hosts;
    own.forEach(h => { if (!found.has(h)) found.set(h, { id: h, domain: h, name: displayName(h), kind: 'Website', upstreams: [], roots: [] }); });
    for (const host of active) {
      const site = found.get(host);
      if (!site) continue;
      if (value.handler === 'reverse_proxy') { site.kind = 'Application'; for (const u of value.upstreams || []) if (u.dial && !site.upstreams.includes(u.dial)) site.upstreams.push(u.dial); }
      if (value.handler === 'file_server' && site.kind !== 'Application') site.kind = 'Static site';
      if (value.handler === 'vars' && typeof value.root === 'string') site.roots.push(value.root);
    }
    Object.values(value).forEach(v => walk(v, active));
  }
  // Ignore auxiliary HTTP listeners; only the public TLS listener is an inventory source.
  for (const server of Object.values(config)) if ((server.listen || []).some(v => /:443$/.test(v))) walk(server.routes);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export function classifyStatus(code) {
  if (code >= 200 && code < 400) return 'up';
  if (code === 401 || code === 403) return 'restricted';
  if (code >= 400 && code < 500) return 'degraded';
  return 'down';
}
export function checkSite(site, options = {}) {
  return new Promise(resolve => {
    const start = performance.now();
    let done = false;
    const finish = result => { if (!done) { done = true; resolve({ ...result, checkedAt: new Date().toISOString() }); } };
    const req = https.request({ hostname: options.address || '127.0.0.1', port: options.port || 443, servername: site.domain, path: '/', method: 'GET', rejectUnauthorized: true, headers: { Host: site.domain, 'User-Agent': 'YanServer/1.0 health monitor', Accept: 'text/html' }, agent: false }, res => {
      const cert = res.socket.getPeerCertificate();
      const statusCode = res.statusCode;
      finish({ state: classifyStatus(statusCode), statusCode, latency: Math.round(performance.now() - start), certificateDays: cert?.valid_to ? Math.floor((Date.parse(cert.valid_to) - Date.now()) / DAY) : null, detail: statusCode === 401 || statusCode === 403 ? 'Access restricted' : statusCode >= 300 && statusCode < 400 ? 'Redirect responding' : statusCode >= 400 ? `HTTP ${statusCode}` : 'HTTPS responding' });
      res.destroy();
    });
    // Wall-clock deadline also covers connection establishment and TLS negotiation.
    const timer = setTimeout(() => req.destroy(new Error('deadline')), options.timeout || 7000);
    req.once('close', () => clearTimeout(timer));
    req.on('error', error => finish({ state: 'down', statusCode: null, latency: null, certificateDays: null, detail: /CERT|TLS|SSL|SELF_SIGNED/.test(error.code || '') ? 'TLS check failed' : 'HTTPS unavailable' }));
    req.end();
  });
}
export function summarizeChecks(checks, now = Date.now()) {
  const recent = checks.filter(c => c.at > now - DAY && c.at <= now);
  const good = recent.filter(c => c.state === 'up' || c.state === 'restricted').length;
  const history = Array.from({ length: 48 }, (_, i) => {
    const start = now - DAY + i * DAY / 48;
    const bucket = recent.filter(c => c.at >= start && c.at < start + DAY / 48);
    if (!bucket.length) return 'unknown';
    if (bucket.some(c => c.state === 'down')) return 'down';
    if (bucket.some(c => c.state === 'degraded')) return 'degraded';
    return 'up';
  });
  return { uptime: recent.length ? Math.round(good / recent.length * 10000) / 100 : null, samples: recent.length, history };
}
export async function writeAtomic(file, value) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, file);
}
export function readCaddyInventory(url) {
  return new Promise((resolve, reject) => {
    // Use a server HTTP client. Fetch adds browser Sec-Fetch-Mode headers,
    // which correctly trigger Caddy's admin origin protections.
    const req = http.get(url, { agent: false }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`Caddy inventory HTTP ${res.statusCode}`)); return; }
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) req.destroy(new Error('Caddy inventory exceeds size limit')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new Error('Invalid Caddy inventory')); } });
    });
    const timer = setTimeout(() => req.destroy(new Error('Caddy inventory timed out')), 5000);
    req.once('close', () => clearTimeout(timer)); req.on('error', reject);
  });
}

export class Monitor {
  constructor({ dataDir, caddyUrl = 'http://127.0.0.1:2019/config/apps/http/servers', collector = true }) {
    this.dataDir = dataDir; this.caddyUrl = caddyUrl; this.collectorEnabled = collector;
    this.state = { startedAt: new Date().toISOString(), historySince: new Date().toISOString(), metrics: {}, sites: [], history: [], events: [], collectorAt: null, checkedAt: null, discoveryAt: null, private: { tasks: [], services: [], processes: [], disks: [], gpus: [], warnings: [] } };
    this.checks = {}; this.cpuPrev = os.cpus(); this.processPrev = new Map(); this.timers = [];
  }
  async start() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const old = JSON.parse(await readFile(path.join(this.dataDir, 'history.json'), 'utf8'));
      if (old.version === 1) {
        this.state.history = (old.history || []).filter(p => Date.parse(p.at) > Date.now() - DAY);
        this.state.events = (old.events || []).filter(p => Date.parse(p.at) > Date.now() - 7 * DAY).slice(-200);
        this.checks = old.checks || {}; this.state.historySince = old.historySince || this.state.startedAt;
      }
    } catch (e) { if (e.code !== 'ENOENT') this.state.private.warnings.push('Saved history could not be read.'); }
    this.sampleResources();
    this.repeat(() => this.sampleResources(), 5000);
    this.repeat(() => this.sampleHistory(), 30000);
    this.repeat(() => this.collect(), 30000);
    this.repeat(() => this.pollSites(), 60000);
    this.repeat(() => this.persist(), 60000);
    await Promise.allSettled([this.collect(), this.pollSites()]);
    this.sampleHistory();
  }
  repeat(fn, ms) { this.timers.push(setInterval(() => { Promise.resolve().then(fn).catch(e => console.error('Monitor:', e.message)); }, ms)); }
  sampleResources() {
    const current = os.cpus(); let idle = 0; let total = 0;
    current.forEach((c, i) => { const p = this.cpuPrev[i]; if (p) { idle += c.times.idle - p.times.idle; for (const key of Object.keys(c.times)) total += c.times[key] - p.times[key]; } });
    this.cpuPrev = current;
    this.state.metrics = { ...this.state.metrics, at: new Date().toISOString(), cpu: total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : null, memory: Math.round((1 - os.freemem() / os.totalmem()) * 1000) / 10, uptime: Math.floor(os.uptime()) };
  }
  sampleHistory() {
    const sample = { ...this.state.metrics };
    if (!this.state.collectorAt || Date.now() - Date.parse(this.state.collectorAt) > 90000) {
      sample.gpu = null; sample.networkRx = null; sample.networkTx = null;
    }
    this.state.history.push(sample);
    this.state.history = this.state.history.filter(p => Date.parse(p.at) > Date.now() - DAY).slice(-2880);
  }
  async collect() {
    if (this.collecting || !this.collectorEnabled) return;
    this.collecting = true;
    try {
      const collectorPath = fileURLToPath(new URL('../scripts/collect.ps1', import.meta.url));
      const { stdout } = await exec('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', collectorPath], { windowsHide: true, timeout: 25000, maxBuffer: 2 * 1024 * 1024 });
      const data = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
      const now = Date.now();
      const seconds = this.collectPrev ? (now - this.collectPrev) / 1000 : 0;
      const processes = (data.processes || []).map(p => {
        const previous = this.processPrev.get(p.pid);
        const cpu = previous?.name === p.name && seconds > 0 ? Math.max(0, (p.cpuSeconds - previous.cpuSeconds) / seconds / os.cpus().length * 100) : null;
        return { pid: p.pid, name: p.name, memoryBytes: p.memoryBytes, cpu: cpu === null ? null : Math.min(100, Math.round(cpu * 10) / 10) };
      }).sort((a, b) => b.memoryBytes - a.memoryBytes).slice(0, 20);
      this.processPrev = new Map((data.processes || []).map(p => [p.pid, p]));
      const network = data.network;
      let rx = null; let tx = null;
      if (network && this.networkPrev && seconds > 0) {
        rx = Math.max(0, (network.received - this.networkPrev.received) / seconds);
        tx = Math.max(0, (network.sent - this.networkPrev.sent) / seconds);
      }
      this.networkPrev = network; this.collectPrev = now;
      const gpus = data.gpus || [];
      const diskTotal = (data.disks || []).reduce((n, d) => n + d.totalBytes, 0);
      const diskUsed = (data.disks || []).reduce((n, d) => n + d.totalBytes - d.freeBytes, 0);
      this.state.private = { ...data, processes, cpuModel: os.cpus()[0]?.model, logicalCores: os.cpus().length, totalMemory: os.totalmem(), hostname: os.hostname(), warnings: data.warnings || [] };
      this.state.collectorAt = new Date(now).toISOString();
      this.state.metrics = { ...this.state.metrics, gpu: gpus.length ? gpus[0].utilization : null, gpuTemperature: gpus.length ? gpus[0].temperature : null, networkRx: rx, networkTx: tx, disk: diskTotal ? Math.round(diskUsed / diskTotal * 1000) / 10 : null };
    } catch (e) { this.state.private.warnings = ['Windows metrics collection is delayed. Last successful readings are retained.']; console.error('Collector:', e.message.slice(0, 200)); }
    finally { this.collecting = false; }
  }
  async pollSites() {
    if (this.polling) return;
    this.polling = true;
    try {
      const discovered = discoverSites(await readCaddyInventory(this.caddyUrl));
      if (!discovered.length) throw new Error('Caddy returned no public hosts');
      this.state.discoveryAt = new Date().toISOString();
      const previous = new Map(this.state.sites.map(s => [s.id, s]));
      const queue = [...discovered]; const results = [];
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (queue.length) {
          const site = queue.shift(); const result = await checkSite(site);
          const records = this.checks[site.id] = [...(this.checks[site.id] || []).filter(c => c.at > Date.now() - DAY), { at: Date.now(), state: result.state }].slice(-1440);
          const oldState = previous.get(site.id)?.state || (records.length > 1 ? records.at(-2).state : null);
          if (oldState && oldState !== result.state) this.state.events.push({ at: result.checkedAt, name: site.name, state: result.state, scope: 'site', message: result.state === 'up' || result.state === 'restricted' ? 'Service recovered' : result.detail });
          results.push({ ...site, ...result, ...summarizeChecks(records) });
        }
      }));
      this.state.sites = results.sort((a, b) => a.name.localeCompare(b.name));
      const active = new Set(discovered.map(s => s.id));
      for (const key of Object.keys(this.checks)) if (!active.has(key)) delete this.checks[key];
      this.state.events = this.state.events.filter(e => Date.parse(e.at) > Date.now() - 7 * DAY).slice(-200);
      this.state.checkedAt = new Date().toISOString(); this.discoveryError = false;
    } catch (e) { this.discoveryError = true; console.error('Inventory:', e.message); }
    finally { this.polling = false; }
  }
  async persist() {
    if (this.persisting) return;
    this.persisting = true;
    try {
      // During a staged deployment only the activated release writes shared history.
      if (process.env.YANSERVER_COMMIT) {
        try {
          const active = JSON.parse(await readFile(path.join(this.dataDir, '..', 'active.json'), 'utf8'));
          if (active.commit !== process.env.YANSERVER_COMMIT) return;
        } catch { return; }
      }
      await writeAtomic(path.join(this.dataDir, 'history.json'), { version: 1, historySince: this.state.historySince, history: this.state.history, events: this.state.events, checks: this.checks });
    }
    finally { this.persisting = false; }
  }
  async stop() { this.timers.forEach(clearInterval); await this.persist(); }
}
