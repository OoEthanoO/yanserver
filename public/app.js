const $ = id => document.getElementById(id);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, digits = 1) => Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: digits }) : '—';
const percent = n => Number.isFinite(n) ? `${fmt(n)}%` : '—';
const bytes = n => { if (!Number.isFinite(n)) return '—'; if (n < 1024) return `${fmt(n, 0)} B`; if (n < 1024 ** 2) return `${fmt(n / 1024)} KB`; if (n < 1024 ** 3) return `${fmt(n / 1024 ** 2)} MB`; return `${fmt(n / 1024 ** 3)} GB`; };
const localTime = date => new Date(date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const relative = date => { if (!date) return 'Not yet checked'; const sec = Math.max(0, (Date.now() - Date.parse(date)) / 1000); return sec < 10 ? 'Just now' : sec < 60 ? `${Math.floor(sec)}s ago` : sec < 3600 ? `${Math.floor(sec / 60)}m ago` : `${Math.floor(sec / 3600)}h ago`; };
let snapshot = null, view = 'overview', range = 1, loading = false, failed = false;
const titles = { overview: ['Server overview', 'Resources, uptime, and everything running at home.'], websites: ['Websites', 'Every public address served by finprint-host.'], system: ['Host & processes', 'A closer look at your hardware and background services.'], activity: ['Activity', 'Service interruptions and recoveries, as they happen.'] };
const icon = name => {
  const paths = { cpu: '<rect x="5" y="5" width="14" height="14" rx="3"/><path d="M9 1v4m6-4v4M9 19v4m6-4v4M1 9h4m-4 6h4m14-6h4m-4 6h4"/>', memory: '<rect x="3" y="6" width="18" height="11" rx="2"/><path d="M7 10v3m5-3v3m5-3v3M7 17v3m5-3v3m5-3v3"/>', gpu: '<rect x="2" y="5" width="20" height="13" rx="2"/><circle cx="14" cy="11.5" r="3.5"/><path d="M6 9v5M5 18v3m5-3v3"/>', network: '<path d="M7 3v17m-4-4 4 4 4-4M17 21V4m-4 4 4-4 4 4"/>' };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.cpu}</svg>`;
};
function spark(key, color) {
  const points = (snapshot.history || []).slice(-24).map(p => p[key]).filter(Number.isFinite);
  if (points.length < 2) return '';
  const max = key === 'networkRx' ? Math.max(1, ...points) : 100;
  const line = points.map((p, i) => `${i * 90 / (points.length - 1)},${30 - p / max * 27}`).join(' ');
  return `<svg class="mini-chart" viewBox="0 0 93 33" aria-hidden="true"><polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`;
}
function setView(next) {
  if (next === 'system' && !snapshot?.owner) { showOwner(); return; }
  view = next;
  document.querySelectorAll('[data-view]').forEach(button => { button.classList.toggle('active', button.dataset.view === view); if (button.dataset.view === view) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  for (const id of ['overview', 'system', 'activity']) $(`view-${id}`).hidden = id !== view;
  $('sites-panel').hidden = !['overview', 'websites'].includes(view);
  $('page-title').textContent = titles[view][0]; $('page-description').textContent = titles[view][1];
  if (snapshot) renderSites();
}
function showOwner() {
  $('login-content').hidden = !!snapshot?.owner;
  $('signed-in-content').hidden = !snapshot?.owner;
  $('access-code').required = !snapshot?.owner;
  $('login-error').textContent = '';
  $('owner-dialog').showModal();
}
function statusPill(state, label) { return `<span class="status-pill ${escapeHTML(state)}"><span class="dot"></span>${escapeHTML(label || ({ up: 'Operational', restricted: 'Restricted', degraded: 'Degraded', down: 'Unavailable', unknown: 'Unknown' }[state] || state))}</span>`; }
function renderMetrics() {
  const m = snapshot.metrics;
  const stale = snapshot.collectorStale;
  const metrics = [
    { key: 'cpu', name: 'CPU usage', value: fmt(m.cpu), unit: '%', label: 'Whole-host utilization', hint: '5s', color: '#8ce3bc' },
    { key: 'memory', name: 'Memory', value: fmt(m.memory), unit: '%', label: snapshot.owner ? `${bytes(m.memory / 100 * snapshot.private.totalMemory)} of ${bytes(snapshot.private.totalMemory)}` : 'Physical memory in use', hint: '5s', color: '#82aaff' },
    { key: 'gpu', name: 'GPU usage', value: stale ? '—' : fmt(m.gpu), unit: '%', label: stale ? 'Sensor readings delayed' : Number.isFinite(m.gpuTemperature) ? `${fmt(m.gpuTemperature, 0)}°C GPU temperature` : 'Waiting for GPU sensor', hint: '30s', color: '#bb9cef' },
    { key: 'network', name: 'Network', value: stale ? '—' : fmt(m.networkRx === null || m.networkRx === undefined ? null : m.networkRx * 8 / 1e6, 2), unit: 'Mbps', label: stale ? 'Network readings delayed' : `↓ received · ↑ ${Number.isFinite(m.networkTx) ? fmt(m.networkTx * 8 / 1e6, 2) : '—'} Mbps sent`, hint: '30s', color: '#edc67b' },
  ];
  $('metrics-grid').innerHTML = metrics.map(m => `<article class="metric-card"><div class="metric-top"><span class="metric-icon">${icon(m.key)}${m.name}</span><span class="metric-indicator">${m.hint}</span></div><div class="metric-value">${m.value}<span>${m.unit}</span></div><div class="metric-bottom">${escapeHTML(m.label)}</div>${spark(m.key === 'network' ? 'networkRx' : m.key, m.color)}</article>`).join('');
  const seconds = m.uptime || 0, days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600), minutes = Math.floor(seconds % 3600 / 60);
  $('uptime-display').innerHTML = `${days}<span>d</span> ${hours}<span>h</span> ${minutes}<span>m</span>`;
  const healthy = snapshot.sites.filter(s => ['up', 'restricted'].includes(s.state)).length;
  const certs = snapshot.sites.map(s => s.certificateDays).filter(Number.isFinite);
  const certDays = certs.length ? Math.min(...certs) : null;
  $('host-facts').innerHTML = `<div class="fact-row"><span>Websites responding</span><strong class="${healthy === snapshot.sites.length && !snapshot.stale ? 'good-text' : ''}">${snapshot.stale ? 'Stale' : `${healthy} / ${snapshot.sites.length}`}</strong></div><div class="fact-row"><span>Next TLS expiry</span><strong>${certDays === null ? '—' : `${certDays} days`}</strong></div><div class="fact-row"><span>Monitor started</span><strong>${localTime(snapshot.startedAt)}</strong></div>`;
  $('storage-value').textContent = stale ? '—' : percent(m.disk);
  $('storage-bar').value = stale ? 0 : m.disk || 0;
  $('storage-note').textContent = stale ? 'Disk readings delayed' : snapshot.owner ? `${bytes(snapshot.private.disks.reduce((n, d) => n + d.freeBytes, 0))} free across ${snapshot.private.disks.length} volume(s)` : 'Across local fixed drives';
  $('private-teaser').hidden = snapshot.owner;
}
function renderChart() {
  const width = Math.max(250, $('resource-chart').clientWidth), height = 195, left = 30, right = 8, top = 10, bottom = 29;
  const chartWidth = width - left - right, chartHeight = height - top - bottom;
  const end = Date.now(), start = end - range * 3600000;
  const points = (snapshot.history || []).filter(p => Date.parse(p.at) >= start);
  const x = time => left + (time - start) / (end - start) * chartWidth;
  const y = value => top + chartHeight * (1 - Math.min(100, Math.max(0, value)) / 100);
  let svg = [0, 25, 50, 75, 100].map(n => `<line class="chart-grid" x1="${left}" x2="${width - right}" y1="${y(n)}" y2="${y(n)}"/><text x="0" y="${y(n) + 4}">${n}</text>`).join('');
  const ticks = width < 420 ? 2 : 4;
  for (let i = 0; i <= ticks; i++) { const t = start + i * (end - start) / ticks; svg += `<text x="${x(t)}" y="${height - 2}" text-anchor="${i === 0 ? 'start' : i === ticks ? 'end' : 'middle'}">${localTime(t)}</text>`; }
  for (const [key, color] of [['gpu', '#bb9cef'], ['memory', '#82aaff'], ['cpu', '#8ce3bc']]) {
    let previous = null, path = '';
    for (const p of points) {
      if (!Number.isFinite(p[key])) { previous = null; continue; }
      const at = Date.parse(p.at), contiguous = previous !== null && at - previous < 90000;
      path += `${contiguous ? 'L' : 'M'}${x(at).toFixed(1)},${y(p[key]).toFixed(1)} `;
      previous = at;
    }
    svg += `<path class="chart-path" d="${path}" stroke="${color}"/>`;
    const last = points.at(-1); if (last && Number.isFinite(last[key])) svg += `<circle cx="${x(Date.parse(last.at))}" cy="${y(last[key])}" r="2.5" fill="${color}"/>`;
  }
  $('resource-chart').innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">${svg}</svg>${points.length < 4 ? '<div class="chart-empty">Collecting live history. New samples appear every 30 seconds.</div>' : ''}`;
  $('resource-chart').setAttribute('aria-label', `Resource usage over ${range} hour(s). Current CPU ${percent(snapshot.metrics.cpu)}, memory ${percent(snapshot.metrics.memory)}, GPU ${percent(snapshot.metrics.gpu)}. ${points.length} measurements.`);
  const since = snapshot.monitoring.historySince;
  $('chart-note').textContent = `Recording since ${new Date(since).toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${localTime(since)}`;
}
function renderSites() {
  const query = $('site-search').value.toLowerCase().trim(), filter = $('status-filter').value;
  const all = snapshot.sites.filter(s => `${s.name} ${s.domain}`.toLowerCase().includes(query) && (filter === 'all' || (filter === 'healthy' ? ['up', 'restricted'].includes(s.state) : !['up', 'restricted'].includes(s.state))));
  const visible = view === 'overview' && !query && filter === 'all' ? all.slice(0, 8) : all;
  $('site-count').textContent = snapshot.sites.length;
  $('nav-count').textContent = snapshot.sites.length;
  $('sites-body').innerHTML = visible.length ? visible.map((site, index) => {
    const state = snapshot.stale ? 'unknown' : site.state;
    return `<tr><td><div class="site-identity"><span class="site-avatar ${['', 'blue', 'purple'][index % 3]}">${escapeHTML(site.name.slice(0, 2).toUpperCase())}</span><div><a class="site-name" href="https://${escapeHTML(site.domain)}" target="_blank" rel="noopener noreferrer">${escapeHTML(site.name)}</a><div class="site-domain">${escapeHTML(site.domain)}</div></div></div></td><td title="${escapeHTML(site.detail)}">${statusPill(state)}</td><td><span class="response-value">${snapshot.stale ? '—' : fmt(site.latency, 0)}</span><span class="response-unit">ms</span></td><td class="history-cell"><div class="history-strips" role="img" aria-label="24-hour history; gray means no observations">${(site.history || []).map((s, i) => `<span class="history-strip ${s}" title="${24 - i / 2}–${23.5 - i / 2} hours ago: ${s === 'unknown' ? 'no observations' : s}"></span>`).join('')}</div></td><td class="uptime-cell"><span class="availability" title="${site.samples} observed checks; not a guarantee of uptime between checks">${site.samples ? fmt(site.uptime, 2) + '%' : '—'}</span></td><td class="tls-cell"><span class="tls-value ${site.certificateDays < 14 ? 'warn' : ''}" title="Certificate expires in this many days">${Number.isFinite(site.certificateDays) ? `${site.certificateDays}d` : '—'}</span></td></tr>`;
  }).join('') : `<tr><td colspan="6" class="empty">${snapshot.sites.length ? 'No websites match your search.' : 'Waiting for the first website checks…'}</td></tr>`;
  $('sites-footer').textContent = `${visible.length} of ${snapshot.sites.length} addresses · availability uses observed checks · gray = no history`;
  $('show-all-sites').hidden = view !== 'overview' || visible.length >= all.length;
}
function renderPrivate() {
  if (!snapshot.owner) {
    for (const id of ['hardware-grid', 'process-body', 'windows-services', 'listeners', 'jobs-body', 'routes-body']) $(id).replaceChildren();
    return;
  }
  const p = snapshot.private;
  const gpu = p.gpus?.[0];
  $('hardware-grid').innerHTML = `<article class="hardware-card"><h3>Processor</h3><strong>${escapeHTML(p.cpuModel || 'Waiting for readings')}</strong><p>${fmt(p.logicalCores, 0)} logical cores · ${escapeHTML(p.os)}</p></article><article class="hardware-card"><h3>Memory & storage</h3><strong>${bytes(p.totalMemory)} system memory</strong>${(p.disks || []).map(d => `<p>${escapeHTML(d.name)} ${bytes(d.totalBytes - d.freeBytes)} / ${bytes(d.totalBytes)} used</p><progress max="100" value="${(1 - d.freeBytes / d.totalBytes) * 100}" aria-label="${escapeHTML(d.name)} storage usage"></progress>`).join('')}</article><article class="hardware-card"><h3>Graphics</h3><strong>${escapeHTML(gpu?.name || 'No GPU readings')}</strong><p>${gpu ? `${fmt(gpu.memoryUsedMb, 0)} / ${fmt(gpu.memoryTotalMb, 0)} MB VRAM · ${fmt(gpu.powerWatts)} W` : 'GPU sensors not available'}</p><p>${escapeHTML(p.hostname)} · Booted ${p.boot ? new Date(p.boot).toLocaleString() : '—'}</p></article>`;
  $('process-body').innerHTML = (p.processes || []).map(proc => `<tr><td>${escapeHTML(proc.name)}</td><td class="response-value">${proc.pid}</td><td>${percent(proc.cpu)}</td><td>${bytes(proc.memoryBytes)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Waiting for process readings</td></tr>';
  $('windows-services').innerHTML = (p.services || []).map(s => `<div class="service-row"><div>${escapeHTML(s.displayName)}<span>${escapeHTML(s.startMode)} startup</span></div>${statusPill(s.state === 'Running' ? 'up' : 'degraded', s.state)}</div>`).join('') || '<p class="empty">No matching Windows services</p>';
  $('listeners').innerHTML = [...new Set((p.listeners || []).map(l => `${l.address}:${l.port}`))].map(l => `<span class="listener">${escapeHTML(l)}</span>`).join('');
  $('job-count').textContent = (p.tasks || []).length;
  $('jobs-body').innerHTML = (p.tasks || []).map(t => `<tr><td>${escapeHTML(t.name)}</td><td>${statusPill(t.state === 'running' || t.state === 'ready' ? 'up' : 'degraded', t.state === 'ready' ? 'Scheduled' : t.state.charAt(0).toUpperCase() + t.state.slice(1))}</td><td title="${escapeHTML(t.lastRun)}">${relative(t.lastRun)}</td><td title="Windows Task Scheduler result">${t.lastResult === 267009 ? 'Running' : t.lastResult === 0 ? 'Success' : `0x${t.lastResult.toString(16).toUpperCase()}`}</td><td class="response-value">${escapeHTML(t.commit || '—')}</td></tr>`).join('');
  $('routes-body').innerHTML = (p.sites || []).map(s => `<tr><td>${escapeHTML(s.id)}</td><td class="route-path">${[...(s.upstreams || []), ...(s.roots || [])].map(escapeHTML).join('<br>') || 'Redirect / managed route'}</td></tr>`).join('');
}
function renderActivity() {
  const events = [...snapshot.events].reverse();
  $('activity-list').innerHTML = events.length ? events.map(e => `<article class="activity-item">${statusPill(e.state, '')}<div><strong>${escapeHTML(e.name)}</strong><p>${escapeHTML(e.message)}</p></div><time datetime="${escapeHTML(e.at)}">${new Date(e.at).toLocaleString()}</time></article>`).join('') : '<div class="empty">No status changes recorded yet.<br>Interruptions and recoveries will appear here automatically.</div>';
}
function render() {
  if (!snapshot) return;
  const unhealthy = snapshot.sites.filter(s => !['up', 'restricted'].includes(s.state));
  const warnings = snapshot.owner ? snapshot.private?.warnings || [] : [];
  $('health-title').textContent = snapshot.stale ? 'Website checks are delayed' : unhealthy.length ? `${unhealthy.length} website${unhealthy.length === 1 ? '' : 's'} need${unhealthy.length === 1 ? 's' : ''} attention` : 'All websites operational';
  $('health-subtitle').textContent = snapshot.stale ? 'Last known states are shown. Waiting for fresh checks.' : `${snapshot.sites.length - unhealthy.length} of ${snapshot.sites.length} websites responding · TLS verified at the server`;
  $('health-banner').classList.toggle('warning', snapshot.stale || unhealthy.length > 0);
  $('mode-label').textContent = snapshot.owner ? 'Owner view' : 'Public view';
  $('mode-label').classList.toggle('is-owner', snapshot.owner);
  $('owner-button-label').textContent = snapshot.owner ? 'Owner settings' : 'Owner access';
  $('owner-button').setAttribute('aria-label', snapshot.owner ? 'Owner settings' : 'Owner access');
  $('lock-indicator').hidden = snapshot.owner;
  if (!snapshot.owner && view === 'system') setView('overview');
  $('error-banner').hidden = !snapshot.collectorStale && !warnings.length;
  $('error-banner').textContent = warnings.length ? warnings.join(' ') : 'Extended resource readings are delayed. CPU and memory still update live.';
  renderMetrics(); renderChart(); renderSites(); renderPrivate(); renderActivity(); updateClock();
}
function updateClock() {
  $('clock').textContent = new Date().toLocaleTimeString('en-US', { timeZone: 'America/Toronto', hour: '2-digit', minute: '2-digit', hour12: false }) + ' Toronto';
  if (!snapshot) return;
  $('last-update').textContent = `Checked ${relative(snapshot.checkedAt).toLowerCase()}`;
  $('connection-title').textContent = failed ? 'Connection lost' : 'Live connection';
  $('connection-sub').textContent = failed ? 'Retrying automatically' : 'Resources refresh every 5s';
  $('connection-dot').classList.toggle('live-dot', !failed);
  $('footer-updated').textContent = `Metrics ${relative(snapshot.metrics.at).toLowerCase()}`;
}
async function refresh() {
  if (loading || (document.hidden && snapshot)) return;
  loading = true; $('refresh-button').disabled = true;
  try {
    const response = await fetch('/api/status', { cache: 'no-store', signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error('Status unavailable');
    snapshot = await response.json(); failed = false; render();
  } catch {
    failed = true;
    // A stale green state must never look like a live healthy response.
    $('error-banner').hidden = false;
    $('error-banner').textContent = 'Connection lost. These are the last received readings; reconnecting automatically.';
    $('health-title').textContent = 'Live connection interrupted';
    $('health-subtitle').textContent = 'The server or network may be unavailable. Retrying automatically.';
    $('health-banner').classList.add('warning');
    if (snapshot) { snapshot.stale = true; renderSites(); }
    updateClock();
  } finally { loading = false; $('refresh-button').disabled = false; }
}
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
document.querySelectorAll('[data-range]').forEach(b => b.addEventListener('click', () => { range = Number(b.dataset.range); document.querySelectorAll('[data-range]').forEach(other => { other.classList.toggle('selected', other === b); other.setAttribute('aria-pressed', String(other === b)); }); if (snapshot) renderChart(); }));
$('site-search').addEventListener('input', () => snapshot && renderSites());
$('status-filter').addEventListener('change', () => snapshot && renderSites());
$('refresh-button').addEventListener('click', refresh);
$('owner-button').addEventListener('click', showOwner);
$('teaser-unlock').addEventListener('click', showOwner);
$('close-dialog').addEventListener('click', () => $('owner-dialog').close());
$('show-all-sites').addEventListener('click', () => { setView('websites'); window.scrollTo({ top: 0, behavior: 'smooth' }); });
$('go-system').addEventListener('click', () => { $('owner-dialog').close(); setView('system'); });
$('owner-dialog').addEventListener('click', e => { if (e.target === $('owner-dialog')) { const r = e.target.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.target.close(); } });
$('owner-form').addEventListener('submit', async e => {
  e.preventDefault(); $('login-submit').disabled = true; $('login-error').textContent = '';
  try {
    const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('access-code').value.trim() }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    $('access-code').value = ''; $('owner-dialog').close(); await refresh();
  } catch (err) { $('login-error').textContent = err.message || 'Could not sign in. Try again.'; }
  finally { $('login-submit').disabled = false; }
});
$('logout-button').addEventListener('click', async () => {
  $('logout-button').disabled = true;
  try {
    const response = await fetch('/api/logout', { method: 'POST' });
    if (!response.ok) throw new Error('Sign-out failed. Try again.');
    $('owner-dialog').close(); snapshot.owner = false; delete snapshot.private; renderPrivate(); setView('overview'); await refresh();
  } catch (e) { $('logout-button').textContent = e.message; }
  finally { $('logout-button').disabled = false; }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.addEventListener('resize', () => { if (snapshot && view === 'overview') renderChart(); });
setInterval(refresh, 5000); setInterval(updateClock, 1000); refresh(); updateClock();
