// Backlog view: swim lanes by project, a project page (dependency graph + table), and a ticket drawer.
// Reads /api/backlog (the local `bl` SQLite database). Read-only.
import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';

const $ = s => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const md = text => { const d = el('div', 'md'); d.innerHTML = DOMPurify.sanitize(marked.parse(text || '')); return d; };
const store = {
  get(k, d) { try { const v = localStorage.getItem('chito.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('chito.' + k, JSON.stringify(v)); } catch { } },
};

export const STATES = ['backlog', 'todo', 'in_progress', 'in_review', 'failed', 'done', 'canceled'];
const LABEL = { backlog: 'Backlog', todo: 'Todo', in_progress: 'In progress', in_review: 'In review', failed: 'Failed', done: 'Done', canceled: 'Canceled' };
const FINAL = new Set(['done', 'canceled']);
const ICON = {
  backlog: '<circle cx="12" cy="12" r="8" stroke-dasharray="3 3"/>',
  todo: '<circle cx="12" cy="12" r="8"/>',
  in_progress: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none"/>',
  in_review: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 1 1-8 8h8z" fill="currentColor" stroke="none"/>',
  done: '<circle cx="12" cy="12" r="9" fill="currentColor" stroke="none"/><path d="M8 12.5l2.7 2.7L16 9.8" stroke="var(--color-sheet)" stroke-width="2.4"/>',
  failed: '<circle cx="12" cy="12" r="9" fill="currentColor" stroke="none"/><path d="M9 9l6 6M15 9l-6 6" stroke="var(--color-sheet)" stroke-width="2.4"/>',
  canceled: '<circle cx="12" cy="12" r="8"/><path d="M8 16L16 8"/>',
};
const SESSION_ICON = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6.5h14a2 2 0 0 1 2 2V15a2 2 0 0 1-2 2h-6l-4 3.5V17H5a2 2 0 0 1-2-2V8.5a2 2 0 0 1 2-2z"/></svg>';

let ctx = null;          // { openSession, toast, fmtRel, fmtDateTime }
const bl = { data: null, byKey: new Map(), blockers: new Map(), dependents: new Map(), depth: new Map(), order: new Map(), error: null, timer: null, ticket: null, ticketKey: null };
const ui = { closed: store.get('blClosed', store.get('blShowDone', false) ? 'recent' : 'none'), q: '', sort: store.get('blSort', { col: 'order', dir: 1 }), milestone: null,
  collapsed: new Set(store.get('blCollapsed', [])) };
const saveCollapsed = () => store.set('blCollapsed', [...ui.collapsed]);
ui.refresh = store.get('blRefresh', 60);

export function statePill(st) {
  const s = el('span', `bl-pill bl-${st}`);
  s.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[st] || ICON.todo}</svg>`;
  s.append(LABEL[st] || st);
  return s;
}
const stateIcon = st => { const s = el('span', `bl-ico bl-${st}`); s.title = LABEL[st] || st; s.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[st] || ICON.todo}</svg>`; return s; };

// A row of facts separated by space, not punctuation.
const factRow = (cls, ...parts) => { const m = el('span', `bl-meta${cls ? ' ' + cls : ''}`); for (const x of parts.filter(v => v != null && v !== '')) m.append(typeof x === 'string' ? el('span', null, x) : x); return m; };

// ---------- data ----------
function index(d) {
  bl.byKey = new Map(d.tickets.map(t => [t.key, t]));
  bl.blockers = new Map(); bl.dependents = new Map();
  for (const t of d.tickets) { bl.blockers.set(t.key, []); bl.dependents.set(t.key, []); }
  for (const e of d.deps) {
    if (bl.blockers.has(e.ticket)) bl.blockers.get(e.ticket).push(e.blocker);
    if (bl.dependents.has(e.blocker)) bl.dependents.get(e.blocker).push(e.ticket);
  }
  // Depth = longest chain of blockers inside the graph; order = topological, then priority, then id.
  bl.depth = new Map();
  const visit = (k, seen = new Set()) => {
    if (bl.depth.has(k)) return bl.depth.get(k);
    if (seen.has(k)) return 0; seen.add(k);
    const bs = (bl.blockers.get(k) || []).filter(b => bl.byKey.has(b));
    const d = bs.length ? 1 + Math.max(...bs.map(b => visit(b, seen))) : 0;
    bl.depth.set(k, d); return d;
  };
  d.tickets.forEach(t => visit(t.key));
  // Tree view of the DAG: each ticket hangs under its deepest in-project blocker (ties: earliest).
  // Other blockers still show as chips. Order = depth-first walk of that tree.
  const topo = (a, b) => bl.depth.get(a.key) - bl.depth.get(b.key) || a.priority - b.priority || a.id - b.id;
  bl.treeParent = new Map();
  bl.children = new Map();
  for (const t of d.tickets) {
    const cands = (bl.blockers.get(t.key) || []).map(k => bl.byKey.get(k)).filter(b => b && b.project === t.project);
    cands.sort((a, b) => bl.depth.get(b.key) - bl.depth.get(a.key) || a.id - b.id);
    const par = cands[0]?.key || null;
    bl.treeParent.set(t.key, par);
    if (par) { if (!bl.children.has(par)) bl.children.set(par, []); bl.children.get(par).push(t); }
  }
  for (const list of bl.children.values()) list.sort(topo);
  const order = [];
  const seen = new Set();
  const walk = t => { if (seen.has(t.key)) return; seen.add(t.key); order.push(t); for (const c of bl.children.get(t.key) || []) walk(c); };
  const byProj = [...d.tickets].sort((a, b) => a.project.localeCompare(b.project) || topo(a, b));
  for (const t of byProj) if (!bl.treeParent.get(t.key)) walk(t);
  for (const t of byProj) walk(t);
  bl.order = new Map(order.map((t, i) => [t.key, i]));
  bl.milestones = new Map((d.milestones || []).map(m => [m.key, m]));
}

const isBlocked = t => t.state === 'todo' && (bl.blockers.get(t.key) || []).some(b => !FINAL.has(bl.byKey.get(b)?.state ?? 'done'));
const isReady = t => t.state === 'todo' && !isBlocked(t) && t.assignee !== 'human';
const needsYou = t => t.state === 'failed' || t.state === 'in_review' || (t.state === 'todo' && t.assignee === 'human' && !isBlocked(t));

export async function loadBacklog() {
  try {
    const r = await fetch('/api/backlog');
    const d = await r.json();
    bl.error = null;
    bl.data = d;
    if (d.available) index(d);
  } catch (e) { bl.error = e.message; }
  updateCount();
}

function updateCount() {
  const n = bl.data?.available ? bl.data.tickets.filter(t => t.state === 'in_progress' || needsYou(t)).length : 0;
  const c = $('#bl-count'); if (c) c.textContent = n ? String(n) : '';
}

function setting(project, key, def) {
  const s = bl.data.settings;
  const pick = scope => s.find(x => x.scope === scope && x.key === key);
  return (pick(`project:${project}`) || pick('global'))?.value ?? def;
}

const liveRun = project => (bl.data.runs || []).find(r => r.project === project && r.status === 'running' && r.alive);

// ---------- routing ----------
export function parseBacklogPath(pathname) {
  const m = pathname.match(/^\/backlog(?:\/([^/]+))?(?:\/([^/]+))?\/?$/);
  if (!m) return null;
  return { project: m[1] ? decodeURIComponent(m[1]) : null, ticket: m[2] ? decodeURIComponent(m[2]) : null };
}

function go(path) {
  if (location.pathname !== path) history.pushState({}, '', path);
  renderBacklog();
}

function linkTo(a, path) {
  a.href = path;
  a.addEventListener('click', e => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation(); go(path);
  });
  return a;
}
const projPath = p => `/backlog/${encodeURIComponent(p)}`;
const ticketPath = t => `/backlog/${encodeURIComponent(t.project)}/${encodeURIComponent(t.key)}`;

function sessionLink(s, label) {
  const a = el('a', 'bl-sess');
  a.href = `/s/${s.id}`;
  a.title = `${s.title || s.id}${s.role ? ` (${s.role})` : ''}`;
  a.innerHTML = SESSION_ICON;
  if (label) a.append(el('span', null, label));
  a.addEventListener('click', e => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation(); ctx.openSession(s.id);
  });
  return a;
}

// ---------- render ----------
export function renderBacklog() {
  const root = $('#backlog-inner');
  if (!root) return;
  const route = parseBacklogPath(location.pathname) || {};
  root.textContent = '';
  if (bl.error) { root.append(el('div', 'board-status', `Could not load the backlog: ${bl.error}`)); return; }
  if (!bl.data) { root.append(el('div', 'prs-empty', 'Loading…')); return; }
  if (!bl.data.available) {
    const s = el('div', 'board-status');
    s.append('No backlog database found at ', el('code', null, bl.data.db), '. Create one with ', el('code', null, 'bl init'), ', or set ', el('code', null, 'CHITO_BACKLOG_DB'), '.');
    root.append(head('Backlog', ''), s);
    return;
  }
  const project = route.project && bl.data.projects.find(p => p.key === route.project.toUpperCase());
  if (route.project && !project) { root.append(head('Backlog', ''), el('div', 'prs-empty', `No project ${route.project}.`)); }
  else if (project) { document.title = `${project.key} · Backlog · chito`; renderProject(root, project); }
  else { document.title = 'Backlog · chito'; renderLanes(root); }
  renderDrawer(route.ticket ? route.ticket.toUpperCase() : null);
}

function head(title, sub, extra) {
  const h = el('div', 'board-head');
  const left = el('div');
  left.append(el('h1', null, title));
  if (sub) { const p = el('p'); if (typeof sub === 'string') p.textContent = sub; else p.append(...sub); left.append(p); }
  h.append(left);
  if (extra) h.append(extra);
  return h;
}

function controls(withSearch = true) {
  const row = el('div', 'board-controls');
  if (withSearch) {
    const box = el('div', 'search board-search');
    box.innerHTML = '<svg viewBox="0 0 24 24" class="search-icon"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
    const inp = el('input'); inp.type = 'search'; inp.placeholder = 'Search key, title or label'; inp.id = 'blq'; inp.value = ui.q; inp.autocomplete = 'off'; inp.spellcheck = false;
    inp.addEventListener('input', () => { ui.q = inp.value; const pos = inp.selectionStart; renderBacklog(); const n = $('#blq'); n.focus(); n.setSelectionRange(pos, pos); });
    inp.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); if (inp.value) { ui.q = ''; renderBacklog(); } else inp.blur(); } });
    box.append(inp);
    row.append(box);
  }
  const seg = el('div', 'seg'); seg.setAttribute('role', 'radiogroup');
  for (const [v, label, tip] of [['none', 'Open', 'Open tickets only'], ['recent', '+ 24h', 'Open, plus tickets closed in the last 24 hours'], ['all', 'All', 'Every ticket, however old']]) {
    const b = el('button', null, label); b.setAttribute('aria-checked', String(ui.closed === v)); b.title = tip;
    b.addEventListener('click', () => { ui.closed = v; store.set('blClosed', v); renderBacklog(); });
    seg.append(b);
  }
  const cap = el('span', 'bl-cap', 'Tickets'); row.append(cap, seg);
  return row;
}

// Closed tickets: shown by the Open / + 24h / All toggle; a search also digs up older ones (the newest few).
const DAY_MS = 864e5, SEARCH_OLD_CAP = 30;
const closedAt = t => new Date(t.finished || t.updated || 0).getTime();
const closedRecently = t => Date.now() - closedAt(t) < DAY_MS;
const showsClosed = () => ui.closed !== 'none' || !!ui.q.trim();
function visibleTickets(list) {
  const out = [], old = [];
  for (const t of list) {
    if (!FINAL.has(t.state) || ui.closed === 'all' || (ui.closed === 'recent' && closedRecently(t))) out.push(t);
    else if (ui.q.trim() && matches(t)) old.push(t);
  }
  old.sort((a, b) => closedAt(b) - closedAt(a));
  return out.concat(old.slice(0, SEARCH_OLD_CAP));
}
const matches = t => {
  if (!ui.q.trim()) return true;
  const hay = `${t.key} ${t.title} ${(t.labels || []).join(' ')} ${t.assignee || ''} ${t.claimed_by || ''}`.toLowerCase();
  return ui.q.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w));
};

const REFRESH = [[0, 'Off'], [60, '1m'], [300, '5m'], [600, '10m'], [1800, '30m'], [3600, '1h']];
function refreshSelect() {
  const wrap = el('label', 'bl-sel bl-refresh'); wrap.title = 'Auto-refresh this page';
  wrap.append(el('span', null, 'Auto-refresh'));
  const s = el('select');
  for (const [v, t] of REFRESH) { const o = el('option', null, t); o.value = String(v); if (v === ui.refresh) o.selected = true; s.append(o); }
  s.addEventListener('change', () => { ui.refresh = Number(s.value); store.set('blRefresh', ui.refresh); startBacklogPolling(); ctx.toast(ui.refresh ? `Refreshing every ${REFRESH.find(r => r[0] === ui.refresh)[1]}` : 'Auto-refresh off'); });
  wrap.append(s);
  return wrap;
}
function headRight(extra) {
  const r = el('div', 'bl-head-right');
  if (extra) r.append(extra);
  r.append(refreshSelect(), refreshBtn());
  return r;
}
function refreshBtn() {
  const b = el('button', 'btn'); b.title = 'Reload from the database';
  b.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.9-3.9M4 5v4h4M4 13a8 8 0 0 0 14.9 3.9M20 19v-4h-4"/></svg><span>Refresh</span>';
  b.addEventListener('click', async () => { await loadBacklog(); renderBacklog(); ctx.toast('Up to date'); });
  return b;
}

function progress(tks) {
  const total = tks.filter(t => t.state !== 'canceled').length;
  const done = tks.filter(t => t.state === 'done').length;
  const bar = el('div', 'bl-progress'); bar.title = `${done} of ${total} done`;
  for (const st of ['done', 'in_review', 'in_progress', 'failed', 'todo', 'backlog']) {
    const n = tks.filter(t => t.state === st).length;
    if (!n || !total) continue;
    const seg = el('i', `bl-${st}`); seg.style.flexGrow = String(n); bar.append(seg);
  }
  const wrap = el('div', 'bl-prog-wrap');
  wrap.append(bar, el('span', 'num', `${done}/${total}`));
  return wrap;
}

function runBadge(project) {
  const r = liveRun(project.key);
  if (!r) return null;
  const s = el('span', 'bl-run'); s.title = `Orchestrator pid ${r.pid}, started ${ctx.fmtDateTime(r.started)}, last heartbeat ${ctx.fmtRel(r.heartbeat)} ago`;
  s.append(el('span', 'live-dot busy'), 'Running');
  return s;
}

// ---- controls (each one runs an allowlisted `bl` command on the server) ----
async function act(action, key, value) {
  try {
    const r = await fetch('/api/backlog/action', { method: 'POST', headers: { 'content-type': 'application/json', 'x-chito': '1' }, body: JSON.stringify({ action, key, value }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    ctx.toast(j.out ? `${key ? key + ': ' : ''}${j.out.split('\n')[0]}` : 'Done');
  } catch (e) { ctx.toast(`Failed: ${e.message}`); }
  await loadBacklog();
  if (bl.ticketKey) bl.ticket = null;
  renderBacklog();
}

function actBtn(label, action, key, value, { confirm = false, primary = false, title } = {}) {
  const b = el('button', `btn${primary ? ' primary' : ''} bl-act`, label);
  b.type = 'button'; if (title) b.title = title;
  let armed = null;
  b.addEventListener('click', e => {
    e.preventDefault(); e.stopPropagation();
    if (confirm && !armed) {
      b.textContent = `Confirm ${label.toLowerCase()}?`; b.classList.add('armed');
      armed = setTimeout(() => { armed = null; b.textContent = label; b.classList.remove('armed'); }, 3000);
      return;
    }
    clearTimeout(armed); b.disabled = true; act(action, key, value);
  });
  return b;
}

const PSTATE = { planning: 'Planning', executing: 'Executing', paused: 'Paused', done: 'Done', archived: 'Archived', active: 'Executing' };
function projState(p) {
  const orphan = isOrphan(p);
  const s = el('span', `bl-pstate ps-${p.status}${orphan ? ' orphan' : ''}`, orphan ? 'Orphaned' : PSTATE[p.status] || p.status);
  s.title = orphan ? `Executing, but its owner (${p.owner}) stopped responding. Resume it with /backlog-run, or let the daemon adopt it.` : `Project is ${p.status}`;
  return s;
}
function isOrphan(p) {
  if (p.status !== 'executing' || p.executor !== 'session' || !p.owner || p.owner === 'daemon') return false;
  if ((bl.data.runs || []).some(r => r.project === p.key && r.status === 'running' && r.alive)) return false;
  const lease = setting(p.key, 'lease_minutes', 30);
  return !p.owner_heartbeat || Date.now() - new Date(p.owner_heartbeat).getTime() > lease * 60e3;
}
const MODES = {
  session: { short: 'SO', kind: 'Orchestrated', title: 'Session orchestrator: you start /backlog-run in a session and it orchestrates until done' },
  auto: { short: 'DSO', kind: 'Orchestrated', title: 'Daemon session orchestrator: the daemon starts an orchestrator session whenever tickets are ready, and again when more arrive' },
  daemon: { short: 'DQ', kind: 'Queue', title: 'Daemon queue: one Claude per ready ticket, no coordinating session' },
};
const CEDAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l4.5 6h-2.5l4 5h-2.5l4 5.5H4.5l4-5.5H6l4-5H7.5z" fill="currentColor"/><path d="M12 19v3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
function evergreenIcon() {
  const s = el('span', 'bl-ever'); s.innerHTML = CEDAR; s.title = 'Evergreen: this project never finishes; new tickets keep flowing'; s.setAttribute('role', 'img'); s.setAttribute('aria-label', 'Evergreen');
  return s;
}
// Lane header chips: the status only when it is news (not Executing), the mode once, evergreen as an icon.
function laneBadges(p) {
  const out = [];
  if (p.status !== 'executing' || isOrphan(p)) out.push(projState(p));
  out.push(execBadge(p));
  if (p.evergreen) out.push(evergreenIcon());
  return out;
}
function execBadge(p) {
  const m = MODES[p.executor] || MODES.session;
  const s = el('span', 'bl-mode', m.short);
  s.title = m.title;
  return s;
}
function lifecycleButtons(p, compact) {
  const box = el('div', 'bl-ctl');
  if (p.status === 'planning') box.append(actBtn('Start', 'project-start', p.key, null, { primary: true, title: 'Move to executing so its executor picks up ready tickets' }));
  if (p.status === 'executing') box.append(actBtn('Pause', 'project-pause', p.key, null, { title: 'Running work finishes; nothing new is claimed' }));
  if (p.status === 'paused') box.append(actBtn('Resume', 'project-resume', p.key, null, { primary: true }));
  if (!compact) {
    if (p.status !== 'planning') box.append(actBtn('Back to planning', 'project-plan', p.key));
    const seg = el('div', 'seg bl-seg'); seg.title = 'Mode: who runs this project';
    for (const ex of ['session', 'auto', 'daemon']) {
      const b = el('button', null, MODES[ex].short); b.title = MODES[ex].title; b.setAttribute('aria-checked', String(p.executor === ex));
      b.addEventListener('click', () => { if (p.executor !== ex) act('project-executor', p.key, ex); });
      seg.append(b);
    }
    const lab = el('span', 'bl-cap', 'Mode'); box.append(lab, seg);
    const eg = el('button', `chip${p.evergreen ? ' on' : ''}`, 'Evergreen'); eg.title = 'Evergreen projects never finish; new tickets keep flowing';
    eg.addEventListener('click', () => act('project-evergreen', p.key, !p.evergreen));
    box.append(eg, actBtn('Archive', 'project-archive', p.key, null, { confirm: true }));
  }
  return box;
}

function daemonBar() {
  const d = bl.data.daemon;
  const bar = el('div', 'bl-daemon');
  const cap = setting(null, 'global_max_parallel', 6);
  const dot = el('span', 'live-dot' + (d?.alive && d.enabled ? ' busy' : ''));
  const label = !d || !d.alive ? 'Daemon not running' : d.enabled ? 'Daemon running' : 'Daemon paused';
  const t = el('b', null, label);
  const facts = el('span', 'bl-daemon-facts');
  const workers = bl.data.tickets.filter(x => x.state === 'in_progress' && (x.claimed_by || '').startsWith('daemon:')).length;
  const rel = d?.heartbeat ? ctx.fmtRel(d.heartbeat) : '';
  const hb = d?.heartbeat ? el('span', null, rel === 'now' ? 'heartbeat just now' : `heartbeat ${rel} ago`) : null;
  if (hb) hb.title = ctx.fmtDateTime(d.heartbeat);
  const runs = d?.runsToday ?? 0;
  facts.append(factRow('', workers ? `${workers} queue worker${workers === 1 ? '' : 's'}` : null, `${runs} run${runs === 1 ? '' : 's'} today`, `up to ${cap} at once`, hb));
  bar.append(dot, t, facts);
  if (d?.quota?.until) {
    const q = el('div', 'bl-quota');
    q.append(el('b', null, 'Usage limit hit.'), ` Nothing new starts until ${ctx.fmtDateTime(d.quota.until)}; the tickets that hit it went back to todo without using an attempt.`);
    if (d.quota.last?.ticket) q.append(' Last: ', d.quota.last.ticket, '.');
    q.append(actBtn('Retry now', 'quota-clear', null, null, { title: 'Clear the pause; the next claims try again' }));
    bar.append(q);
  }
  if (d?.alive) bar.append(d.enabled ? actBtn('Pause daemon', 'daemon-pause', null, null, { title: 'Workers already running finish; nothing new starts' }) : actBtn('Resume daemon', 'daemon-resume', null, null, { primary: true }));
  else { const hint = el('span', 'bl-daemon-hint'); hint.append('Start it with ', el('code', null, 'bl daemon install')); bar.append(hint); }
  return bar;
}

function executorOf(t) {
  const c = t.claimed_by || '';
  if (c.startsWith('daemon:')) return ['Queue worker', 'ex-queue'];
  if (c.startsWith('orchs:')) return ['DSO session', 'ex-orch'];
  if (c.startsWith('orch:')) return ['bl run', 'ex-orch'];
  if (c.startsWith('cc:')) return ['Session', 'ex-session'];
  if (c === 'chito') return ['chito', ''];
  return [c || '', ''];
}
function workerSession(t) {
  const ws = (t.sessions || []).filter(s => !s.missing);
  return ws.find(s => s.role === 'worker') || ws[0] || null;
}
function inFlight(tks) {
  const rows = tks.filter(t => t.state === 'in_progress').sort((a, b) => (a.started || '') < (b.started || '') ? -1 : 1);
  const wrap = el('div', 'bl-flight');
  if (!rows.length) { wrap.append(el('div', 'bl-flight-empty', 'Nothing running right now.')); return wrap; }
  for (const t of rows) {
    const r = linkTo(el('a', 'bl-flight-row'), ticketPath(t));
    const [ex, cls] = executorOf(t);
    const since = t.spawn?.at || t.started;
    const sess = workerSession(t);
    r.append(stateIcon('in_progress'), el('span', 'num bl-flight-key', t.key), el('span', 'bl-flight-title', t.title),
      el('span', 'bl-flight-model', t.spawn?.model || ''),
      el('span', 'num bl-flight-since', since ? ctx.fmtRel(since) : ''));
    r.lastChild.title = since ? `Started ${ctx.fmtDateTime(since)}${t.attempts > 1 ? ` · attempt ${t.attempts}` : ''}` : '';
    r.title = `${ex}${t.claimed_by ? ` (${t.claimed_by})` : ''}`;
    if (sess) { const a = sessionLink(sess, 'Session'); a.classList.add('bl-flight-sess'); r.append(a); }
    else r.append(el('span', 'bl-flight-sess none', 'no session yet'));
    wrap.append(r);
  }
  return wrap;
}

// ---- who is executing a project ----
// The orchestrator session is where general instructions for a project go, so its link is a button, not a footnote.
function orchLink(s, compact, last = false) {
  const a = sessionLink(s, compact ? (last ? 'Last orchestrator' : 'Orchestrator') : (last ? 'Open the last orchestrator session' : 'Open the orchestrator session'));
  a.classList.add('btn', 'bl-orch-link');
  a.title = `${s.title || s.id}: give the orchestrator general instructions for this project here`;
  return a;
}
// Standing instructions: every orchestrator run and every worker prompt in this project gets them, and a running
// orchestrator re-reads them each round (bl instructions KEY).
function instructionsBox(p) {
  const box = el('details', 'bl-instr'); if (p.instructions) box.open = true;
  const sum = el('summary', null, 'Standing instructions');
  sum.append(el('span', 'bl-instr-hint', p.instructions ? ' every orchestrator and worker in this project follows these' : ' none yet: guidance every orchestrator and worker here should follow'));
  const ta = el('textarea'); ta.value = p.instructions || ''; ta.rows = 4; ta.placeholder = 'For example: deploy only at milestones. Always add a unit test. Leave the billing code alone.';
  ta.addEventListener('keydown', e => e.stopPropagation());
  const save = el('button', 'btn primary', 'Save'); save.type = 'button';
  save.addEventListener('click', () => { save.disabled = true; act('project-instructions', p.key, ta.value); });
  const row = el('div', 'bl-instr-row'); row.append(save, el('span', 'bl-instr-hint', 'A running orchestrator picks changes up at its next round.'));
  box.append(sum, ta, row);
  return box;
}
function execLine(p, compact) {
  const ex = p.execution || {};
  const box = el('div', 'bl-execline');
  if (p.status !== 'executing') return null;
  if (p.executor === 'auto') {
    const d = bl.data.daemon;
    const o = ex.orchestrator;
    if (o) {
      const row = el('span', 'bl-execrun');
      row.append(el('span', 'live-dot busy'), el('span', null, 'Orchestrator running'), orchLink(o, compact));
      box.append(row);
    } else {
      box.append(el('span', null, !d?.alive ? 'Daemon not running' : !d.enabled ? 'Daemon paused' : d.quota?.until ? 'Waiting for the usage limit to reset' : compact ? 'Idle' : 'Idle; the daemon starts an orchestrator when tickets are ready'));
      if (!d?.alive || !d?.enabled || d?.quota?.until) box.classList.add('warn');
      const last = (p.orchSessions || [])[0];
      if (last) box.append(orchLink(last, compact, true));
    }
    return box;
  }
  if (p.executor === 'daemon') {
    const d = bl.data.daemon;
    const n = (ex.workers || []).length;
    box.append(el('span', null, !d?.alive ? 'Daemon not running' : !d.enabled ? 'Daemon paused' : n ? `${n} working` : 'Idle'));
    if (!d?.alive || !d?.enabled) box.classList.add('warn');
    return box;
  }
  if (ex.runs?.length) {
    for (const r of ex.runs) {
      const row = el('span', 'bl-execrun');
      row.append(el('span', 'live-dot busy'), el('span', null, `Orchestrator pid ${r.pid}`));
      if (r.session) row.append(orchLink(r.session, compact)); else row.append(el('span', null, 'launching its session'));
      row.title = `bl run started ${ctx.fmtDateTime(r.started)}; heartbeat ${ctx.fmtRel(r.heartbeat)} ago`;
      box.append(row);
    }
    return box;
  }
  if (ex.owner?.session) {
    const row = el('span', 'bl-execrun');
    row.append(el('span', 'live-dot' + (isOrphan(p) ? '' : ' busy')), el('span', null, isOrphan(p) ? 'Owner session went quiet' : 'Run by session'),
      orchLink(ex.owner.session, compact));
    box.append(row);
    if (isOrphan(p)) box.classList.add('warn');
    return box;
  }
  const ready = bl.data.tickets.filter(t => t.project === p.key && isReady(t)).length;
  if (!ready) return null;
  box.classList.add('warn');
  box.append(el('span', null, `${ready} ready, no orchestrator running`));
  const hint = el('code', null, `/backlog-run ${p.key}`); hint.title = 'Run it from a Claude Code session, or switch the executor to Daemon';
  box.append(hint);
  return box;
}

// ---- usage (nominal cost from transcripts) ----
const fmtTok = n => n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n || 0);
const fmtCost = u => u ? `$${u.cost < 10 ? u.cost.toFixed(2) : Math.round(u.cost)}${u.unpriced ? '+' : ''}` : '';
function usageTitle(u) {
  if (!u) return '';
  return `Nominal list-price cost (not billed on a subscription)\n${u.turns} model turns · ${(u.models || []).join(', ')}\n` +
    `input ${fmtTok(u.input)} · output ${fmtTok(u.output)} · cache read ${fmtTok(u.cacheRead)} · cache write ${fmtTok(u.cacheWrite)}`;
}
function usageStat(label, u) {
  const s = el('span', 'bl-usage');
  s.append(el('span', null, label), el('b', 'num', fmtCost(u)), factRow('num', `${u.turns} turns`, `${fmtTok(u.tokens)} tokens`));
  s.title = usageTitle(u);
  return s;
}

// ---- PRs ----
function prChips(t, max = 3) {
  const out = [];
  for (const pr of (t.prs || []).slice(0, max)) {
    const gh = ctx.getPr ? ctx.getPr(pr.url) : null;
    const st = gh?.state || 'UNKNOWN';
    const a = el('a', `bl-pr st-${st}`);
    a.href = pr.url; a.target = '_blank'; a.rel = 'noopener';
    a.title = `${pr.repo || ''} #${pr.number}${gh?.title ? ' · ' + gh.title : ''} · ${st.toLowerCase()}`;
    a.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7M18 15.5V9a3 3 0 0 0-3-3h-3"/></svg>';
    a.append(el('span', 'num', `#${pr.number}`));
    a.addEventListener('click', e => e.stopPropagation());
    out.push(a);
  }
  if ((t.prs || []).length > max) out.push(el('span', 'num bl-pr-more', `+${t.prs.length - max}`));
  return out;
}

// ---- milestones ----
const MS_LABEL = { planned: 'Planned', active: 'Active', reached: 'Reached', showcased: 'Showcased', canceled: 'Canceled' };
function msTrigger(m) {
  if (m.trigger === 'deploy') return `On deploy (${m.gate || '?'})`;
  if (m.trigger === 'manual') return 'Manual';
  return 'When all done';
}
function msTickets(m) { return bl.data.tickets.filter(t => t.milestone === m.key && t.key !== m.showcase_ticket); }
function showcaseItems(m, big) {
  const box = el('div', big ? 'bl-shows big' : 'bl-shows');
  for (const sc of m.showcases || []) {
    const it = el('div', `bl-show k-${sc.kind}`);
    if (sc.file && /\.(png|jpe?g|gif|webp|svg)$/i.test(sc.file)) {
      const a = el('a'); a.href = `/api/backlog/showcase?f=${encodeURIComponent(sc.file)}`; a.target = '_blank'; a.rel = 'noopener';
      const img = el('img'); img.src = a.href; img.alt = sc.note || 'showcase'; img.loading = 'lazy';
      a.append(img); it.append(a);
    } else if (sc.file) {
      const a = el('a', 'bl-show-link', sc.file.split('/').pop()); a.href = `/api/backlog/showcase?f=${encodeURIComponent(sc.file)}`; a.target = '_blank'; a.rel = 'noopener'; it.append(a);
    }
    if (sc.url) { const a = el('a', 'bl-show-link', sc.url.replace(/^https?:\/\//, '')); a.href = sc.url; a.target = '_blank'; a.rel = 'noopener'; it.append(a); }
    if (sc.note) it.append(el('div', 'bl-show-note', sc.note.length > 220 && !big ? sc.note.slice(0, 220) + '…' : sc.note));
    box.append(it);
  }
  return box;
}
function roadmap(p) {
  const ms = (bl.data.milestones || []).filter(m => m.project === p.key && (ui.closed === 'all' || m.status !== 'canceled'));
  if (!ms.length) return null;
  const wrap = el('div', 'bl-roadmap');
  for (const m of ms) {
    const tks = msTickets(m);
    const card = el('button', `bl-ms ms-${m.status}${ui.milestone === m.key ? ' on' : ''}`);
    card.type = 'button';
    card.title = ui.milestone === m.key ? 'Show all tickets' : 'Show only this milestone\'s tickets';
    card.addEventListener('click', e => { if (e.target.closest('a')) return; ui.milestone = ui.milestone === m.key ? null : m.key; renderBacklog(); });
    const top = el('div', 'bl-ms-top');
    top.append(el('span', 'num bl-ms-key', m.key.slice(p.key.length + 1)), el('span', `bl-ms-state ms-${m.status}`, MS_LABEL[m.status] || m.status));
    if (m.due) { const due = el('span', 'bl-ms-due', `due ${m.due}`); if (m.due < new Date().toISOString().slice(0, 10) && !['reached', 'showcased'].includes(m.status)) due.classList.add('late'); top.append(due); }
    card.append(top, el('div', 'bl-ms-title', m.title));
    const meta = el('div', 'bl-ms-meta'); meta.append(el('span', null, msTrigger(m)));
    if (m.showcase_kind && m.showcase_kind !== 'none') meta.append(el('span', null, `showcase: ${m.showcase_kind}`));
    card.append(meta, progress(tks));
    if (m.showcases?.length) card.append(showcaseItems(m));
    else if (m.showcase_ticket) {
      const st = bl.byKey.get(m.showcase_ticket);
      if (st) { const l = linkTo(el('a', 'bl-ms-st'), ticketPath(st)); l.append(stateIcon(st.state), el('span', null, `Showcase ${st.key.slice(p.key.length + 1)}: ${LABEL[st.state].toLowerCase()}`)); card.append(l); }
    }
    wrap.append(card);
  }
  const none = bl.data.tickets.filter(t => t.project === p.key && !t.milestone && !t.meta?.showcase_for && !FINAL.has(t.state)).length;
  if (none) {
    const c = el('button', `bl-ms ms-none${ui.milestone === '-' ? ' on' : ''}`); c.type = 'button';
    c.append(el('div', 'bl-ms-title', `${none} open ticket${none === 1 ? '' : 's'} without a milestone`));
    c.addEventListener('click', () => { ui.milestone = ui.milestone === '-' ? null : '-'; renderBacklog(); });
    wrap.append(c);
  }
  const sc = el('div', 'bl-roadmap-scroll'); sc.append(wrap);
  return sc;
}
function nextMilestone(p) {
  return (bl.data.milestones || []).filter(m => m.project === p.key && ['planned', 'active', 'reached'].includes(m.status)).sort((a, b) => a.seq - b.seq)[0];
}

// ---- needs you: what is asked and where to answer ----
const PHASE = { preparing: 'Preparing your handoff', awaiting: 'Ready for you', discussing: 'In discussion' };
function needReason(t) {
  const ph = t.meta?.handoff?.phase;
  if (t.assignee === 'human' && PHASE[ph]) return PHASE[ph];
  if (t.state === 'failed') return 'Failed, decide: retry, fix the spec or cancel';
  if (t.state === 'in_review') return 'Review the PR, then approve';
  return 'Your decision';
}
function answerSession(t) {
  const hs = t.meta?.handoff?.session;
  if (hs) return { ...(t.sessions || []).find(s => s.id === hs), id: hs, kind: 'Handoff session' };
  const b = t.meta?.brief;
  if (b?.session) return { ...(t.sessions || []).find(s => s.id === b.session), id: b.session, kind: 'Briefing' };
  const ws = workerSession(t);
  if (ws) return { ...ws, kind: 'Worker session' };
  const p = bl.data.projects.find(x => x.key === t.project);
  const o = p?.execution?.orchestrator || p?.orchSessions?.[0] || p?.execution?.runs?.[0]?.session || p?.execution?.owner?.session;
  return o ? { ...o, kind: 'Orchestrator session' } : null;
}
async function openInTerminal(id) {
  try {
    const r = await fetch(`/api/sessions/${id}/open`, { method: 'POST', headers: { 'x-chito': '1' } });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    ctx.toast(j.action === 'focused' ? 'Focused its terminal' : j.action === 'forked' ? 'Still running in the background, so this opened a forked copy; the running session will not see what you type there' : 'Opened in a terminal');
  } catch (e) { ctx.toast(`Could not open: ${e.message}`); }
}
function needsYouPanel(tks) {
  const items = tks.filter(needsYou);
  const ms = (bl.data.milestones || []).filter(m => m.status === 'showcased' && tks.some(t => t.project === m.project));
  if (!items.length && !ms.length) return null;
  const box = el('div', 'bl-needs');
  const h = el('div', 'bl-needs-head'); h.append(el('b', null, 'Waiting on you'), el('span', 'num', String(items.length + ms.length)));
  box.append(h);
  for (const t of items) {
    const row = el('div', 'bl-needs-row');
    const title = linkTo(el('a', 'bl-needs-title'), ticketPath(t));
    title.append(el('span', 'num', t.key), el('span', null, t.title));
    const why = el('span', 'bl-needs-why', needReason(t));
    const act = el('div', 'bl-needs-act');
    const b = t.meta?.brief;
    const sess = answerSession(t);
    if (t.meta?.handoff?.packet) act.append(linkTo(el('a', 'btn primary bl-open-handoff', 'Open handoff'), ticketPath(t)));
    else if (b?.pending) act.append(el('span', 'bl-needs-pending', 'Preparing a briefing'));
    if (sess) {
      const open = sessionLink(sess, sess.kind === 'Briefing' ? 'Read the briefing' : sess.kind);
      const term = el('button', `btn${sess.kind === 'Briefing' && !t.meta?.handoff?.packet ? ' primary' : ''}`, 'Answer in terminal'); term.type = 'button';
      term.title = `Resume ${sess.title || 'the session'} in your terminal and reply there`;
      term.addEventListener('click', e => { e.stopPropagation(); openInTerminal(sess.id); });
      act.append(open, term);
    } else if (!b?.pending) act.append(el('span', 'bl-needs-pending', 'No session yet'));
    if (b?.error) act.append(el('span', 'bl-needs-pending', 'Briefing failed; the daemon retries after a restart'));
    if (t.meta?.handoff?.phase) row.classList.add(`ph-${t.meta.handoff.phase}`);
    row.append(title, why, act);
    box.append(row);
  }
  for (const m of ms) {
    const row = el('div', 'bl-needs-row');
    const title = linkTo(el('a', 'bl-needs-title'), projPath(m.project)); title.append(el('span', 'num', m.key), el('span', null, m.title));
    row.append(title, el('span', 'bl-needs-why', 'Review the showcase, then accept or reopen'), el('div', 'bl-needs-act'));
    box.append(row);
  }
  return box;
}

// ---- swim lanes ----
const LANE_COLS = ['backlog', 'todo', 'in_progress', 'in_review', 'failed', 'done'];

function card(t) {
  const c = el('a', `bl-card bl-${t.state}${isBlocked(t) ? ' blocked' : ''}${needsYou(t) ? ' needs-you' : ''}`);
  linkTo(c, ticketPath(t));
  const top = el('div', 'bl-card-top');
  const kk = el('span', 'bl-key num', t.key.slice(t.project.length + 1)); kk.title = t.key;
  top.append(stateIcon(t.state), kk);
  if (t.priority <= 1) top.append(el('span', `bl-prio p${t.priority}`, t.priority === 0 ? 'Urgent' : 'High'));
  c.append(top, el('div', 'bl-card-title', t.title));
  const meta = el('div', 'bl-card-meta');
  const bs = (bl.blockers.get(t.key) || []).filter(b => !FINAL.has(bl.byKey.get(b)?.state ?? 'done'));
  if (t.state === 'todo') {
    if (bs.length) meta.append(el('span', 'wait', `Waits on ${bs.map(b => b.startsWith(t.project + '-') ? b.slice(t.project.length + 1) : b).join(', ')}`));
    else if (t.assignee === 'human') meta.append(el('span', 'bad', 'Needs you'));
    else meta.append(el('span', 'ok', 'Ready'));
  }
  if (t.state === 'in_progress' && t.attempts > 1) meta.append(el('span', null, `try ${t.attempts}`));
  if (t.state === 'failed') meta.append(el('span', 'bad', `${t.attempts} attempt${t.attempts === 1 ? '' : 's'}`));
  if (t.state === 'in_review') meta.append(el('span', 'wait', 'Waiting for approval'));
  if (t.assignee === 'human' && t.state !== 'todo') meta.append(el('span', null, 'human'));
  meta.append(...prChips(t, 2));
  if (t.sessions?.length) meta.append(sessionLink(t.sessions[0], t.sessions.length > 1 ? String(t.sessions.length) : null));
  if (meta.childNodes.length) c.append(meta);
  return c;
}

function renderLanes(root) {
  const d = bl.data;
  const projects = d.projects.filter(p => p.status !== 'archived');
  const all = d.tickets;
  const running = all.filter(t => t.state === 'in_progress').length;
  const you = all.filter(needsYou).length;
  const sub = [factRow('', `${projects.length} project${projects.length === 1 ? '' : 's'}`, `${running} in progress`, you ? `${you} waiting on you` : 'nothing waiting on you')];
  root.append(head('Backlog', sub, headRight()), daemonBar());
  const ctl = controls();
  const visible = projects.map(p => p.key);
  const allCollapsed = visible.length && visible.every(k => ui.collapsed.has(k));
  const tog = el('button', 'btn bl-collapse-all', allCollapsed ? 'Expand all' : 'Collapse all');
  tog.title = allCollapsed ? 'Show every project\'s tickets' : 'Show projects only';
  tog.addEventListener('click', () => { if (allCollapsed) visible.forEach(k => ui.collapsed.delete(k)); else visible.forEach(k => ui.collapsed.add(k)); saveCollapsed(); renderBacklog(); });
  ctl.insertBefore(tog, ctl.querySelector('.bl-cap'));
  const ny = needsYouPanel(all); if (ny) root.append(ny);
  root.append(el('h2', 'bl-h2', 'In flight'), inFlight(all), el('h2', 'bl-h2', 'Projects'), ctl);
  const cols = LANE_COLS.filter(st => (showsClosed() || st !== 'done') && (st === 'todo' || st === 'in_progress' || all.some(t => t.state === st)));
  const grid = el('div', 'bl-lanes');
  grid.style.setProperty('--cols', String(cols.length));
  const hdr = el('div', 'bl-lane-head');
  hdr.append(el('div', 'bl-lane-corner'));
  for (const st of cols) {
    const h = el('div', 'bl-col-head'); h.append(stateIcon(st), el('span', null, LABEL[st]));
    const n = visibleTickets(all).filter(t => t.state === st && matches(t)).length; if (n) h.append(el('span', 'num', String(n)));
    hdr.append(h);
  }
  if (!(visible.length && visible.every(k => ui.collapsed.has(k)))) grid.append(hdr);
  if (!projects.length) grid.append(el('div', 'prs-empty', 'No projects yet. Create one with bl project add.'));
  for (const p of projects) {
    const tks = all.filter(t => t.project === p.key);
    const shown = visibleTickets(tks).filter(matches);
    if (ui.q.trim() && !shown.length) continue;
    if (tks.length && !visibleTickets(tks).length) continue;
    const lane = el('div', 'bl-lane');
    const side = el('div', 'bl-lane-side');
    const collapsed = ui.collapsed.has(p.key);
    const chev = el('button', `bl-chev${collapsed ? '' : ' open'}`);
    chev.type = 'button'; chev.title = collapsed ? 'Show tickets' : 'Hide tickets';
    chev.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
    chev.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); if (collapsed) ui.collapsed.delete(p.key); else ui.collapsed.add(p.key); saveCollapsed(); renderBacklog(); });
    const name = linkTo(el('a', 'bl-lane-name'), projPath(p.key));
    name.append(el('span', 'bl-lane-key num', p.key), el('span', 'bl-lane-title', p.name));
    const nameRow = el('div', 'bl-lane-namerow'); nameRow.append(chev, name);
    if (collapsed) {
      const lane2 = el('div', 'bl-lane'); 
      const row = el('div', 'bl-lane-compact');
      const head = el('div', 'bl-compact-head');
      name.title = `${p.key} ${p.name}`;
      head.append(nameRow);
      const b2 = el('div', 'bl-lane-badges'); b2.append(...laneBadges(p)); head.append(b2);
      const counts = el('div', 'bl-compact-counts');
      for (const st of LANE_COLS) { const n = shown.filter(t => t.state === st).length; if (n) { const x = statePill(st); x.append(el('span', 'num', String(n))); counts.append(x); } }
      const you = tks.filter(needsYou).length; if (you) counts.append(el('span', 'bl-compact-you', `${you} need${you === 1 ? 's' : ''} you`));
      head.append(counts, progress(tks));
      row.append(head);
      const run = shown.filter(t => t.state === 'in_progress').sort((a, b) => (a.started || '') < (b.started || '') ? -1 : 1);
      if (run.length) {
        const list = el('div', 'bl-compact-run');
        for (const t of run.slice(0, 3)) {
          const r = linkTo(el('a', 'bl-compact-row'), ticketPath(t));
          const ws = workerSession(t);
          r.append(stateIcon('in_progress'), el('span', 'num', t.key.slice(p.key.length + 1)), el('span', 'bl-compact-title', t.title),
            el('span', 'num bl-compact-since', t.started ? ctx.fmtRel(t.spawn?.at || t.started) : ''));
          if (ws) r.append(sessionLink(ws));
          list.append(r);
        }
        if (run.length > 3) list.append(el('span', 'bl-compact-more', `and ${run.length - 3} more running`));
        row.append(list);
      }
      lane2.append(row);
      grid.append(lane2);
      continue;
    }
    const badges = el('div', 'bl-lane-badges'); badges.append(...laneBadges(p));
    side.append(nameRow, badges, progress(tks));
    const nm = nextMilestone(p);
    if (nm) {
      const mt = msTickets(nm);
      const l = linkTo(el('a', 'bl-lane-ms'), projPath(p.key));
      l.append(el('span', `bl-ms-state ms-${nm.status}`, MS_LABEL[nm.status]), el('span', null, `${nm.key.slice(p.key.length + 1)} ${nm.title}`),
        el('span', 'num', `${mt.filter(t => t.state === 'done').length}/${mt.length}`));
      side.append(l);
    }
    const exl = execLine(p, true); if (exl) side.append(exl);
    side.append(lifecycleButtons(p, true));
    const facts = el('div', 'bl-lane-facts');
    const you = tks.filter(needsYou).length; if (you) facts.append(el('span', 'bad', `${you} need${you === 1 ? 's' : ''} you`));
    side.append(facts);
    lane.append(side);
    for (const st of cols) {
      const col = el('div', `bl-col bl-col-${st}`);
      let list = shown.filter(t => t.state === st).sort((a, b) => bl.order.get(a.key) - bl.order.get(b.key));
      if (st === 'done') list = list.sort((a, b) => ((b.finished || '') > (a.finished || '') ? 1 : -1));
      const cap = st === 'done' ? 4 : 50;
      for (const t of list.slice(0, cap)) col.append(card(t));
      if (list.length > cap) col.append(linkTo(el('a', 'bl-more', `${list.length - cap} more`), projPath(p.key)));
      lane.append(col);
    }
    grid.append(lane);
  }
  root.append(grid);
}

// ---- project page ----
function renderProject(root, p) {
  const tks = bl.data.tickets.filter(t => t.project === p.key);
  const back = linkTo(el('a', 'bl-back'), '/backlog');
  back.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>';
  back.append('All projects');
  root.append(back);
  const sub = [];
  if (p.repo) sub.push(el('span', 'num', p.repo.replace(/^\/Users\/[^/]+/, '~')));
  sub.push(el('span', null, `review ${setting(p.key, 'review', 'ask')}`), el('span', null, `parallel ${setting(p.key, 'max_parallel', 3)}`));
  if (p.doc_slug) {
    const base = bl.data.artiBase;
    if (base) { const a = el('a', null, `doc: ${p.doc_slug}`); a.href = `${base.replace(/\/$/, '')}/s/${encodeURIComponent(p.doc_slug)}`; a.target = '_blank'; a.rel = 'noopener'; sub.push(a); }
    else sub.push(el('span', null, `doc: ${p.doc_slug}`));
  }
  const subWrap = [factRow('', ...sub)];
  const right = headRight(runBadge(p));
  root.append(head(`${p.name}`, subWrap, right));
  const ctl = el('div', 'bl-proj-ctl'); ctl.append(projState(p), execBadge(p), lifecycleButtons(p, false));
  root.append(ctl);
  const exl = execLine(p, false); if (exl) root.append(exl);
  root.append(instructionsBox(p));
  if (tks.some(t => t.state === 'in_progress')) root.append(el('h2', 'bl-h2', 'In flight'), inFlight(tks));

  const stats = el('div', 'bl-stats');
  stats.append(progress(tks));
  for (const st of STATES) { const n = tks.filter(t => t.state === st).length; if (n) { const x = statePill(st); x.append(el('span', 'num', String(n))); stats.append(x); } }
  root.append(stats);
  if (p.usage) {
    const us = el('div', 'bl-usage-row');
    us.append(usageStat('Total', p.usage));
    if (p.sharedUsage) us.append(usageStat('Orchestration and shared sessions', p.sharedUsage));
    us.append(el('span', 'bl-usage-note', 'Nominal list prices from transcripts; not billed on a subscription.'));
    root.append(us);
  }

  const nyp = needsYouPanel(tks); if (nyp) root.append(nyp);

  const rm = roadmap(p);
  if (rm) root.append(el('h2', 'bl-h2', 'Roadmap'), rm);
  else if (ui.milestone) ui.milestone = null;
  root.append(el('h2', 'bl-h2', 'Dependency graph'), graph(tks));
  const msOk = t => !ui.milestone || (ui.milestone === '-' ? !t.milestone && !t.meta?.showcase_for : t.milestone === ui.milestone);
  const th = el('h2', 'bl-h2', 'Tickets');
  if (ui.milestone) { const x = el('button', 'chip on', `${ui.milestone === '-' ? 'No milestone' : ui.milestone} ×`); x.addEventListener('click', () => { ui.milestone = null; renderBacklog(); }); th.append(' ', x); }
  root.append(th, controls(), table(visibleTickets(tks).filter(t => matches(t) && msOk(t))));
}

function graph(tks, big = false) {
  const wrap = el('div', 'bl-graph' + (big ? ' big' : ''));
  const shown = tks.filter(t => t.state !== 'canceled' || ui.closed === 'all');
  if (!shown.length) { wrap.append(el('div', 'prs-empty', 'No tickets.')); return wrap; }
  const W = big ? 250 : 200, H = big ? 86 : 58, GX = big ? 80 : 64, GY = big ? 26 : 20, PAD = 12;
  const cols = new Map();
  for (const t of [...shown].sort((a, b) => bl.order.get(a.key) - bl.order.get(b.key))) {
    const d = bl.depth.get(t.key) || 0;
    if (!cols.has(d)) cols.set(d, []);
    cols.get(d).push(t);
  }
  const pos = new Map();
  const depths = [...cols.keys()].sort((a, b) => a - b);
  // Order each column by the average row of its blockers (barycenter), so edges cross less.
  const row = new Map();
  depths.forEach((d, ci) => {
    const col = cols.get(d);
    if (ci > 0) {
      const bc = t => { const rs = (bl.blockers.get(t.key) || []).map(k => row.get(k)).filter(v => v != null); return rs.length ? rs.reduce((x, y) => x + y, 0) / rs.length : Infinity; };
      col.sort((a, b) => bc(a) - bc(b) || bl.order.get(a.key) - bl.order.get(b.key));
    }
    col.forEach((t, ri) => row.set(t.key, ri));
  });
  depths.forEach((d, ci) => cols.get(d).forEach((t, ri) => pos.set(t.key, { x: PAD + ci * (W + GX), y: PAD + ri * (H + GY) })));
  const width = PAD * 2 + depths.length * W + (depths.length - 1) * GX;
  const height = PAD * 2 + Math.max(...[...cols.values()].map(c => c.length)) * (H + GY) - GY;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.setAttribute('width', width); svg.setAttribute('height', height);
  for (const t of shown) {
    for (const b of bl.blockers.get(t.key) || []) {
      const a = pos.get(b), z = pos.get(t.key); if (!a || !z) continue;
      const x1 = a.x + W, y1 = a.y + H / 2, x2 = z.x, y2 = z.y + H / 2, mx = (x1 + x2) / 2;
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 4},${y2}`);
      path.setAttribute('class', `bl-edge${FINAL.has(bl.byKey.get(b)?.state) ? ' met' : ''}`);
      path.dataset.from = b; path.dataset.to = t.key;
      svg.append(path);
      const tip = document.createElementNS(NS, 'path');
      tip.setAttribute('d', `M${x2 - 8},${y2 - 4} L${x2 - 2},${y2} L${x2 - 8},${y2 + 4}`);
      tip.setAttribute('class', `bl-edge${FINAL.has(bl.byKey.get(b)?.state) ? ' met' : ''}`);
      svg.append(tip);
    }
  }
  // Nodes are HTML so they can use the same pill styles and links; edges are drawn on top so none hide behind a box.
  const layer = el('div', 'bl-nodes'); layer.style.width = width + 'px'; layer.style.height = height + 'px';
  for (const t of shown) {
    const p = pos.get(t.key);
    const n = linkTo(el('a', `bl-node bl-${t.state}${isReady(t) ? ' ready' : ''}${bl.ticketKey === t.key ? ' sel' : ''}`), ticketPath(t));
    n.style.left = p.x + 'px'; n.style.top = p.y + 'px'; n.style.width = W + 'px'; n.style.height = H + 'px';
    n.title = `${t.key} · ${LABEL[t.state]}${isReady(t) ? ' · ready' : ''}\n${t.title}`;
    const top = el('div', 'bl-node-top'); top.append(stateIcon(t.state), el('span', 'num', t.project === tks[0].project ? t.key.slice(t.project.length + 1) : t.key));
    n.addEventListener('mouseenter', () => svg.querySelectorAll(`[data-from="${t.key}"], [data-to="${t.key}"]`).forEach(e => e.classList.add('hl')));
    n.addEventListener('mouseleave', () => svg.querySelectorAll('.hl').forEach(e => e.classList.remove('hl')));
    if (t.assignee === 'human') top.append(el('span', 'bl-node-tag', 'human'));
    else if (isReady(t)) top.append(el('span', 'bl-node-tag ok', 'ready'));
    n.append(top, el('div', 'bl-node-title', t.title));
    layer.append(n);
  }
  wrap.append(svg, layer);
  const scroller = el('div', 'bl-graph-scroll'); scroller.append(wrap);
  if (big) return scroller;
  const box = el('div', 'bl-graph-box');
  const ex = el('button', 'btn bl-graph-expand'); ex.type = 'button'; ex.title = 'Open a larger view';
  ex.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg><span>Expand</span>';
  ex.addEventListener('click', () => openGraphModal(tks));
  box.title = 'Click anywhere to expand';
  box.addEventListener('click', e => { if (e.target.closest('.bl-node, .bl-graph-expand')) return; openGraphModal(tks); });
  box.append(ex, scroller);
  return box;
}

function openGraphModal(tks) {
  const m = el('div', 'bl-modal');
  const card = el('div', 'bl-modal-card');
  const head = el('div', 'bl-modal-head');
  head.append(el('b', null, 'Dependency graph'), el('span', null, 'Hover a ticket to highlight its edges; click to open it.'));
  const close = el('button', 'btn icon'); close.title = 'Close (Esc)';
  close.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  head.append(close);
  card.append(head, graph(tks, true));
  m.append(card);
  const done = () => { m.remove(); document.removeEventListener('keydown', esc, true); };
  const esc = e => { if (e.key === 'Escape') { e.stopPropagation(); done(); } };
  close.addEventListener('click', done);
  m.addEventListener('click', e => { if (e.target === m) done(); });
  card.addEventListener('click', e => { if (e.target.closest('.bl-node')) done(); });
  document.addEventListener('keydown', esc, true);
  document.body.append(m);
  // Fill the window: zoom the graph up (never down past 1) to fit the available area.
  const sc = card.querySelector('.bl-graph-scroll'), g = card.querySelector('.bl-graph');
  if (sc && g) {
    const z = Math.min((sc.clientWidth - 48) / g.offsetWidth, (sc.clientHeight - 48) / g.offsetHeight, 1.8);
    if (z > 1) g.style.zoom = String(z);
  }
}

const COLS = [
  ['order', '#', t => bl.order.get(t.key)],
  ['key', 'Key', t => [t.project, t.id]],
  ['title', 'Title', t => t.title.toLowerCase()],
  ['state', 'State', t => STATES.indexOf(t.state)],
  ['deps', 'Waits on', t => (bl.blockers.get(t.key) || []).length],
  ['blocks', 'Blocks', t => (bl.dependents.get(t.key) || []).length],
  ['priority', 'P', t => t.priority],
  ['attempts', 'Tries', t => t.attempts],
  ['who', 'Who', t => t.claimed_by || t.assignee || ''],
  ['ms', 'Milestone', t => bl.milestones.get(t.milestone)?.seq ?? 1e9],
  ['prs', 'PRs', t => (t.prs || []).length],
  ['cost', 'Cost', t => t.usage?.cost ?? -1],
  ['updated', 'Updated', t => t.updated || ''],
];

function cmp(a, b) {
  if (Array.isArray(a)) { for (let i = 0; i < a.length; i++) { const c = cmp(a[i], b[i]); if (c) return c; } return 0; }
  return a < b ? -1 : a > b ? 1 : 0;
}

function depChip(k, proj = bl.byKey.get(bl.ticketKey || '')?.project) {
  const t = bl.byKey.get(k);
  if (!t) return el('span', 'bl-chip', k);
  const c = linkTo(el('a', `bl-chip bl-${t.state}`), ticketPath(t)); c.title = `${t.title} · ${LABEL[t.state]}`;
  c.append(stateIcon(t.state), el('span', 'num', t.project === proj ? k.slice(t.project.length + 1) : k));
  if (FINAL.has(t.state)) c.classList.add('met');
  return c;
}

function table(tks) {
  const wrap = el('div', 'bl-table-wrap');
  const tbl = el('table', 'bl-table');
  const thead = el('thead'); const tr = el('tr');
  const has = {
    ms: tks.some(t => t.milestone) || (bl.data.milestones || []).some(m => tks[0] && m.project === tks[0].project),
    prs: tks.some(t => t.prs?.length),
    usage: tks.some(t => t.usage),
    who: tks.some(t => t.claimed_by || t.assignee),
  };
  const cols = COLS.filter(([id]) => !(id === 'ms' && !has.ms) && !(id === 'prs' && !has.prs) && !(id === 'cost' && !has.usage) && !(id === 'who' && !has.who));
  const on = id => cols.some(c => c[0] === id);
  for (const [id, label] of cols) {
    const th = el('th', `c-${id}`); const b = el('button', null, label);
    if (ui.sort.col === id) { th.setAttribute('aria-sort', ui.sort.dir > 0 ? 'ascending' : 'descending'); b.append(el('span', 'bl-sort', ui.sort.dir > 0 ? '↑' : '↓')); }
    b.addEventListener('click', () => { ui.sort = { col: id, dir: ui.sort.col === id ? -ui.sort.dir : (id === 'updated' ? -1 : 1) }; store.set('blSort', ui.sort); renderBacklog(); });
    th.append(b); tr.append(th);
  }
  thead.append(tr); tbl.append(thead);
  const key = cols.find(c => c[0] === ui.sort.col)?.[2] || COLS[0][2];
  const rows = [...tks].sort((a, b) => ui.sort.dir * cmp(key(a), key(b)) || bl.order.get(a.key) - bl.order.get(b.key));
  const tbody = el('tbody');
  const treeMode = ui.sort.col === 'order' && ui.sort.dir > 0;
  // Tree geometry over the visible rows: depth, and which ancestor levels continue below this row.
  const geo = new Map();
  if (treeMode) {
    const vis = new Set(rows.map(t => t.key));
    const parentOf = k => { let p = bl.treeParent.get(k); while (p && !vis.has(p)) p = bl.treeParent.get(p); return p; };
    const kids = new Map();
    for (const t of rows) { const p = parentOf(t.key); if (p) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(t.key); } }
    const walk = (k, depth, cont) => {
      const ks = kids.get(k) || [];
      ks.forEach((c, i) => { const last = i === ks.length - 1; geo.set(c, { depth, cont, last }); walk(c, depth + 1, [...cont, !last]); });
    };
    for (const t of rows) if (!parentOf(t.key)) { geo.set(t.key, { depth: 0, cont: [], last: true }); walk(t.key, 1, []); }
    for (const [k, ks] of kids) if (geo.has(k)) geo.get(k).kids = ks.length;
  }
  // Tree gutter: each title has a node dot; lines run between dots, left of the text, so they never cross it.
  const STEP = 18, PAD = 8, DOT = 5, TEXT = 16, MAXD = 8;
  for (const t of rows) {
    const r = el('tr', `bl-${t.state}${bl.ticketKey === t.key ? ' sel' : ''}${needsYou(t) ? ' needs-you' : ''}`);
    r.addEventListener('click', e => { if (e.target.closest('a')) return; go(ticketPath(t)); });
    const td = (cls, ...kids) => { const c = el('td', cls); c.append(...kids); r.append(c); return c; };
    td('c-order num', String(bl.order.get(t.key) - Math.min(...tks.map(x => bl.order.get(x.key))) + 1));
    const kl = linkTo(el('a', null, t.key.slice(t.project.length + 1)), ticketPath(t)); kl.title = t.key;
    td('c-key num', kl);
    const ttl = el('div', 'bl-tt');
    // A blocked ticket has nothing to open yet: its title is plain text.
    // The title links only to a session that is the ticket's own (its worker, briefing or handoff), never an orchestrator's.
    const own = (t.sessions || []).find(s => s.own && !s.missing) || null;
    const ho = t.meta?.handoff?.session || t.meta?.brief?.session;
    const wsess = needsYou(t) && ho ? { ...(t.sessions || []).find(s => s.id === ho), id: ho } : own;
    if (wsess) {
      const a = el('a', 'bl-tt-text linked'); a.href = `/s/${wsess.id}`;
      a.title = `Open the session: ${wsess.title || wsess.id}${t.sessions.length > 1 ? ` (${t.sessions.length} sessions; all in the details)` : ''}`;
      a.append(t.title);
      const ic = el('span', 'bl-tt-sess'); ic.innerHTML = SESSION_ICON; a.append(ic);
      a.addEventListener('click', e => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); e.stopPropagation(); ctx.openSession(wsess.id); });
      ttl.append(a);
    } else ttl.append(el('span', 'bl-tt-text', t.title));
    if (t.labels?.length) for (const l of t.labels) ttl.append(el('span', 'bl-label', l));
    if (t.usage) { const u = el('div', 'bl-tt-usage num'); u.append(factRow('', `${t.usage.turns} turns`, `${fmtTok(t.usage.tokens)} tokens`, fmtCost(t.usage))); u.title = usageTitle(t.usage); ttl.append(u); }
    const tcell = td('c-title', ttl);
    const g = geo.get(t.key);
    if (g) {
      tcell.classList.add('tree');
      const d = Math.min(g.depth, MAXD);
      const x = lvl => PAD + Math.min(lvl, MAXD) * STEP + DOT;     // centre of the dot at this level
      ttl.style.marginLeft = `${d * STEP + TEXT}px`;
      g.cont.forEach((cont, i) => { if (cont && i < MAXD) { const v = el('i', 'bl-guide'); v.style.left = `${x(i)}px`; tcell.append(v); } });
      if (g.depth) {
        const e = el('i', 'bl-elbow'); e.style.left = `${x(g.depth - 1)}px`; e.style.width = `${x(g.depth) - x(g.depth - 1) - DOT}px`;
        tcell.append(e);
        if (!g.last) { const v = el('i', 'bl-guide'); v.style.left = `${x(g.depth - 1)}px`; tcell.append(v); }
      }
      if (g.kids) { const st = el('i', 'bl-stem'); st.style.left = `${x(g.depth)}px`; tcell.append(st); }
      const dot = el('i', `bl-node-dot bl-${t.state}`); dot.style.left = `${x(g.depth) - DOT}px`; tcell.append(dot);
    }
    td('c-state', statePill(t.state), ...(needsYou(t) ? [el('span', 'bl-needs-tag', 'Needs you')] : isReady(t) ? [el('span', 'bl-ready', 'ready')] : isBlocked(t) ? [el('span', 'bl-blocked', 'blocked')] : []));
    td('c-deps', ...(bl.blockers.get(t.key) || []).map(k => depChip(k, t.project)));
    td('c-blocks', ...(bl.dependents.get(t.key) || []).map(k => depChip(k, t.project)));
    td(`c-priority num p${t.priority}`, String(t.priority));
    td('c-attempts num', t.attempts ? `${t.attempts}${t.max_attempts ? '/' + t.max_attempts : ''}` : '');
    if (on('who')) td('c-who', el('span', 'bl-who', t.claimed_by ? executorOf(t)[0] : (t.assignee || '')));
    const ms = bl.milestones.get(t.milestone);
    if (on('ms')) { td('c-ms', ...(ms ? [el('span', `bl-ms-chip ms-${ms.status}`, ms.key.slice(t.project.length + 1))] : [])); if (ms) r.lastChild.title = ms.title; }
    if (on('prs')) td('c-prs', ...prChips(t, 3));
    if (on('cost')) td('c-cost num', fmtCost(t.usage)).title = usageTitle(t.usage);
    const up = td('c-updated', t.updated ? ctx.fmtRel(t.updated) : ''); up.title = `Updated ${ctx.fmtDateTime(t.updated)}`;
    tbody.append(r);
  }
  if (!rows.length) { const r = el('tr'); const c = el('td', 'prs-empty', ui.q ? 'No tickets match that search.' : ui.closed === 'none' ? 'No open tickets. Switch to + 24h or All to see finished ones.' : 'Nothing open or closed in the last 24 hours. Switch to All, or search.'); c.colSpan = cols.length; r.append(c); tbody.append(r); }
  tbl.append(tbody); wrap.append(tbl);
  return wrap;
}

// ---- ticket drawer ----
async function renderDrawer(key) {
  const box = $('#bl-drawer');
  bl.ticketKey = key;
  if (!key) { box.hidden = true; box.textContent = ''; return; }
  box.hidden = false;
  if (!bl.ticket || bl.ticket.key !== key) {
    box.textContent = '';
    box.append(el('div', 'prs-empty', 'Loading…'));
  } else drawDrawer(box, bl.ticket);
  try {
    const r = await fetch(`/api/backlog/ticket/${encodeURIComponent(key)}`);
    if (!r.ok) throw new Error(r.status === 404 ? `No ticket ${key}` : `HTTP ${r.status}`);
    const t = await r.json();
    if (bl.ticketKey !== key) return;
    bl.ticket = t;
    drawDrawer(box, t);
  } catch (e) { if (bl.ticketKey === key) { box.textContent = ''; box.append(closeBtn(), el('div', 'board-status', e.message)); } }
}

function closeBtn() {
  const b = el('button', 'btn icon bl-close'); b.title = 'Close (Esc)'; b.setAttribute('aria-label', 'Close');
  b.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  b.addEventListener('click', closeDrawer);
  return b;
}

export function closeDrawer() {
  const r = parseBacklogPath(location.pathname);
  if (r?.ticket) { go(projPath(r.project)); return true; }
  return false;
}

function drawDrawer(box, t) {
  const keepScroll = box.dataset.key === t.key ? box.scrollTop : 0;
  box.dataset.key = t.key;
  box.textContent = '';
  const top = el('div', 'bl-d-top');
  top.append(el('span', 'num bl-d-key', t.key), statePill(t.state), closeBtn());
  box.append(top, el('h3', 'bl-d-title', t.title), ticketActions(t));
  const ho = handoffView(t);
  if (ho) box.append(ho);

  const dl = el('dl', 'bl-d-meta');
  const row = (k, ...v) => { if (!v.length || v.every(x => x == null || x === '')) return; dl.append(el('dt', null, k)); const dd = el('dd'); dd.append(...v.filter(x => x != null)); dl.append(dd); };
  const prio = ['Urgent', 'High', 'Normal', 'Low', 'None'][t.priority] ?? String(t.priority);
  row('Priority', `${prio} (${t.priority})`);
  if (t.state === 'todo') row('Status', isBlocked(bl.byKey.get(t.key) || t) ? 'Blocked by open tickets' : t.assignee === 'human' ? 'Ready, waiting on you' : 'Ready to run');
  row('Assignee', t.assignee || null);
  row('Claimed by', t.claimed_by || null);
  if (t.lease_until && t.state === 'in_progress') row('Lease until', ctx.fmtDateTime(t.lease_until));
  row('Attempts', t.attempts ? `${t.attempts}${t.max_attempts ? ' of ' + t.max_attempts : ''}` : null);
  row('Labels', t.labels?.length ? t.labels.join(', ') : null);
  row('Locks', t.locks?.length ? t.locks.join(', ') : null);
  const meta = { ...t.meta }; for (const k of ['sessions', 'brief', 'handoff', 'showcase_for']) delete meta[k];
  if (meta.review) { row('Review', meta.review); delete meta.review; }
  if (meta.size) { row('Size', meta.size); delete meta.size; }
  for (const [k, v] of Object.entries(meta)) row(k, typeof v === 'string' ? v : JSON.stringify(v));
  if (t.doc_slug) {
    const base = bl.data?.artiBase;
    if (base) { const a = el('a', null, t.doc_slug); a.href = `${base.replace(/\/$/, '')}/s/${encodeURIComponent(t.doc_slug)}`; a.target = '_blank'; a.rel = 'noopener'; row('Design doc', a); }
    else row('Design doc', t.doc_slug);
  }
  const tu = bl.byKey.get(t.key)?.usage;
  if (tu) { const x = factRow('', fmtCost(tu), `${tu.turns} turns`, `${fmtTok(tu.tokens)} tokens`); x.title = usageTitle(tu); row('Usage', x); }
  row('Created', ctx.fmtDateTime(t.created));
  if (t.started) row('Started', ctx.fmtDateTime(t.started));
  if (t.finished) row('Finished', ctx.fmtDateTime(t.finished));
  box.append(dl);

  if (t.blockers.length || t.dependents.length) {
    const deps = el('div', 'bl-d-deps');
    if (t.blockers.length) { const r = el('div'); r.append(el('span', 'bl-d-lbl', 'Waits on'), ...t.blockers.map(b => depChip(b.key))); deps.append(r); }
    if (t.dependents.length) { const r = el('div'); r.append(el('span', 'bl-d-lbl', 'Blocks'), ...t.dependents.map(b => depChip(b.key))); deps.append(r); }
    box.append(deps);
  }

  if (t.prs?.length) {
    box.append(el('h4', 'bl-d-h', 'Pull requests'));
    const list = el('div', 'bl-d-prs');
    for (const pr of t.prs) {
      const gh = ctx.getPr ? ctx.getPr(pr.url) : null;
      const a = el('a', `bl-d-pr st-${gh?.state || 'UNKNOWN'}`); a.href = pr.url; a.target = '_blank'; a.rel = 'noopener';
      a.append(el('span', 'num', `${(pr.repo || '').split('/').pop()} #${pr.number}`), el('span', 'bl-d-pr-title', gh?.title || ''), el('span', 'bl-d-pr-state', (gh?.state || '').toLowerCase()));
      list.append(a);
    }
    box.append(list);
  }
  if (t.sessions.length) {
    box.append(el('h4', 'bl-d-h', 'Sessions'));
    const list = el('div', 'bl-d-sessions');
    for (const s of t.sessions) {
      const a = el('a', 'bl-d-sess');
      a.href = `/s/${s.id}`;
      a.addEventListener('click', e => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); ctx.openSession(s.id); });
      a.innerHTML = SESSION_ICON;
      a.append(el('span', 'bl-d-sess-title', s.title || (s.missing ? 'Transcript not found' : s.id.slice(0, 8))), factRow('bl-d-sess-meta', s.role, s.lastTime ? `${ctx.fmtRel(s.lastTime)} ago` : ''));
      list.append(a);
    }
    box.append(list);
  }

  if (t.result) { box.append(el('h4', 'bl-d-h', t.result.startsWith('FAILED') ? 'Last failure' : 'Result')); box.append(md(t.result)); }
  box.append(el('h4', 'bl-d-h', 'Spec'));
  box.append(t.body ? md(t.body) : el('p', 'bl-d-empty', 'No body. The title is the spec.'));

  if (t.events.length) {
    box.append(el('h4', 'bl-d-h', 'Activity'));
    const ev = el('ol', 'bl-d-events');
    for (const e of [...t.events].reverse()) {
      const li = el('li', `ev-${e.kind}`);
      const head = el('div', 'bl-ev-head');
      const when = el('span', 'num', ctx.fmtRel(e.at) + ' ago'); when.title = ctx.fmtDateTime(e.at);
      head.append(el('b', null, e.kind), el('span', null, e.actor || ''), when);
      if (e.session_id) head.append(sessionLink({ id: e.session_id, title: 'Open the session that wrote this' }));
      if (e.data?.log) { const lg = el('span', 'num bl-ev-log', e.data.log.split('/').pop()); lg.title = e.data.log; head.append(lg); }
      li.append(head);
      if (e.body) li.append(e.kind === 'comment' ? md(e.body) : el('div', 'bl-ev-body', e.body));
      ev.append(li);
    }
    box.append(ev);
  }
  box.scrollTop = keepScroll;
}

// ---------- lifecycle ----------
export function initBacklog(c) {
  ctx = c;
  document.addEventListener('click', e => {
    const d = $('#bl-drawer');
    if (!d || d.hidden || !e.isTrusted) return;
    if (e.target.closest('#bl-drawer, .bl-card, .bl-node, .bl-table tbody tr, .bl-chip, .bl-flight-row, .toast, .modal, a[href^="/backlog/"]')) return;
    if (!document.body.contains(e.target)) return; // re-rendered under the click
    closeDrawer();
  });
  loadBacklog().then(() => { if (!$('#backlog').hidden) renderBacklog(); });
}

export function startBacklogPolling() {
  stopBacklogPolling();
  if (!ui.refresh) return;
  bl.timer = setInterval(async () => {
    if (document.hidden) return;
    await loadBacklog();
    if (document.activeElement?.id === 'blq') return; // don't steal focus mid-typing
    const scroller = $('#backlog'); const y = scroller.scrollTop;
    renderBacklog();
    scroller.scrollTop = y;
  }, ui.refresh * 1000);
}
export function stopBacklogPolling() { clearInterval(bl.timer); bl.timer = null; }
export function backlogRefreshCount() { return loadBacklog(); }

function ticketActions(t) {
  const box = el('div', 'bl-d-actions');
  if (['failed', 'canceled', 'done'].includes(t.state)) box.append(actBtn('Reopen', 'ticket-reopen', t.key, null, { primary: t.state === 'failed', title: 'Back to todo with attempts reset' }));
  if (t.assignee === 'human' && !FINAL.has(t.state)) box.append(actBtn('Mark done', 'ticket-resolve', t.key, null, { primary: true, title: 'Close this human ticket as done (bl resolve)' }));
  if (t.state === 'in_review') box.append(actBtn('Approve', 'ticket-approve', t.key, null, { primary: true, title: 'Mark done (after the PR is merged)' }));
  if (t.state === 'backlog') box.append(actBtn('Move to todo', 'ticket-move', t.key, 'todo', { primary: true }));
  if (t.state === 'todo') box.append(actBtn('Move to backlog', 'ticket-move', t.key, 'backlog'));
  if (!['done', 'canceled'].includes(t.state)) box.append(actBtn('Cancel', 'ticket-cancel', t.key, null, { confirm: true, title: 'Cancel: dependents become unblocked' }));
  const sel = (label, action, options, cur) => {
    const wrap = el('label', 'bl-sel'); wrap.append(el('span', null, label));
    const s = el('select');
    for (const [v, txt] of options) { const o = el('option', null, txt); o.value = v; if (String(v) === String(cur)) o.selected = true; s.append(o); }
    s.addEventListener('change', () => act(action, t.key, s.value));
    wrap.append(s); return wrap;
  };
  box.append(sel('Priority', 'ticket-priority', [[0, 'Urgent'], [1, 'High'], [2, 'Normal'], [3, 'Low'], [4, 'None']], t.priority));
  box.append(sel('Model', 'ticket-model', [['', 'Default (opus)'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']], t.meta?.model || ''));
  box.append(sel('Assignee', 'ticket-assignee', [['', 'Agents'], ['human', 'Human']], t.assignee === 'human' ? 'human' : ''));
  const pms = (bl.data?.milestones || []).filter(m => m.project === t.project && m.status !== 'canceled');
  if (pms.length && !t.meta?.showcase_for) box.append(sel('Milestone', 'ticket-milestone', [['', 'None'], ...pms.map(m => [m.key, `${m.key.slice(t.project.length + 1)} ${m.title}`])], t.milestone || ''));
  return box;
}

// A list of steps the reader ticks off as they go; ticks stay in this browser.
function tickList(key, items, render) {
  const ticked = store.get(key, []);
  const ul = el('ul', 'bl-ho-tests');
  items.forEach((x, i) => {
    const li = el('li');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = ticked.includes(i); cb.id = `${key}-${i}`.replace(/[^\w-]/g, '-');
    cb.addEventListener('change', () => { const now = store.get(key, []).filter(v => v !== i); if (cb.checked) now.push(i); store.set(key, now); li.classList.toggle('ticked', cb.checked); });
    const lab = el('label'); lab.htmlFor = cb.id; lab.append(...render(x).filter(Boolean));
    li.append(cb, lab); if (cb.checked) li.classList.add('ticked');
    ul.append(li);
  });
  return ul;
}

// ---- the handoff packet: a short doc shaped to the ticket, plus what is asked ----
function handoffView(t) {
  const h = t.meta?.handoff;
  if (!h || (!h.packet && h.phase !== 'preparing')) return null;
  const box = el('section', `bl-handoff ph-${h.phase || 'awaiting'}`);
  const head = el('div', 'bl-ho-head');
  head.append(el('b', null, 'Handoff'), el('span', `bl-ho-phase ph-${h.phase}`, PHASE[h.phase] || h.phase || ''));
  if (h.ready_at) { const w = el('span', 'bl-ho-when', `ready ${ctx.fmtRel(h.ready_at)} ago`); w.title = ctx.fmtDateTime(h.ready_at); head.append(w); }
  box.append(head);
  if (!h.packet) { box.append(el('p', 'bl-d-empty', 'The AI is compiling what was done, how to see it and what to test. You will be notified.')); return box; }
  const pk = h.packet;
  box.append(el('p', 'bl-ho-summary', pk.summary));
  if (pk.see) {
    const see = el('div', 'bl-ho-see');
    if (pk.see.url) { const a = el('a', 'btn primary', 'Open the preview'); a.href = pk.see.url; a.target = '_blank'; a.rel = 'noopener'; see.append(a, el('code', null, pk.see.url)); }
    if (pk.see.how) see.append(el('div', 'bl-ho-how', pk.see.how));
    box.append(see);
  }
  if (pk.links?.length) {
    const l = el('div', 'bl-ho-links');
    for (const x0 of pk.links) { const x = typeof x0 === 'string' ? { url: (x0.match(/https?:\/\/[^\s)]+/) || [])[0], label: x0 } : x0; if (!x.url) continue; const a = el('a', null, x.label || x.url); a.href = x.url; a.target = '_blank'; a.rel = 'noopener'; l.append(a); }
    box.append(l);
  }
  if (pk.body) box.append(Object.assign(md(pk.body), { className: 'md bl-ho-body' }));
  if (pk.checklist?.length) box.append(el('h4', 'bl-d-h', pk.checklist_title || 'Checklist'), tickList(`handoff.${t.key}.check`, pk.checklist.map(x => typeof x === 'string' ? { item: x } : x), x => [el('span', 'bl-ho-step', x.item), x.detail ? el('span', 'bl-ho-detail', x.detail) : null]));
  if (pk.done?.length) {
    box.append(el('h4', 'bl-d-h', "What's done and new"));
    const ol = el('ol', 'bl-ho-done');
    for (const d0 of pk.done) { const d = typeof d0 === 'string' ? { title: d0 } : d0; const li = el('li'); li.append(el('b', null, d.title)); if (d.ref) li.append(' ', el('span', 'num', d.ref)); if (d.what) li.append(el('div', null, d.what)); ol.append(li); }
    box.append(ol);
  }
  if (pk.tests?.length) {
    const key = `handoff.${t.key}`;
    const ticked = store.get(key, []);
    box.append(el('h4', 'bl-d-h', 'What to test'));
    const ul = el('ul', 'bl-ho-tests');
    pk.tests.forEach((x0, i) => {
      const x = typeof x0 === 'string' ? { step: x0 } : x0;
      const li = el('li');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = ticked.includes(i); cb.id = `ho-${t.key}-${i}`;
      cb.addEventListener('change', () => { const now = store.get(key, []).filter(v => v !== i); if (cb.checked) now.push(i); store.set(key, now); li.classList.toggle('ticked', cb.checked); });
      const lab = el('label'); lab.htmlFor = cb.id; lab.append(el('span', 'bl-ho-step', x.step));
      if (x.good) lab.append(el('span', 'bl-ho-good', `Good: ${x.good}`));
      if (x.bad) lab.append(el('span', 'bl-ho-bad', `Bad: ${x.bad}`));
      li.append(cb, lab); if (cb.checked) li.classList.add('ticked');
      ul.append(li);
    });
    box.append(ul);
  }
  if (pk.gaps?.length) {
    box.append(el('h4', 'bl-d-h', 'Known gaps'));
    const ul = el('ul', 'bl-ho-gaps'); for (const g of pk.gaps) ul.append(el('li', null, g)); box.append(ul);
  }
  if (pk.questions?.length) {
    box.append(el('h4', 'bl-d-h', 'Asked of you'));
    const ol = el('ol', 'bl-ho-questions'); for (const q of pk.questions) ol.append(el('li', null, q)); box.append(ol);
  }
  const asks = (pk.asks || []).map(a => typeof a === 'string' ? { q: a } : a);
  const sess = answerSession(bl.byKey.get(t.key) || t);
  if (asks.length && !(sess && t.state !== 'done')) {
    box.append(el('h4', 'bl-d-h', 'Asked of you'));
    const ol = el('ol', 'bl-ho-questions'); for (const a of asks) ol.append(el('li', null, a.q)); box.append(ol);
  }
  if (sess && t.state !== 'done') {
    const form = el('form', 'bl-ho-reply');
    const answers = asks.map(() => ({ v: '' }));
    if (asks.length) {
      form.append(el('h4', 'bl-d-h', 'Asked of you'));
      asks.forEach((a, i) => {
        const f = el('fieldset', 'bl-ask');
        f.append(el('legend', null, `${i + 1}. ${a.q}`));
        if (a.note) f.append(el('div', 'bl-ask-note', a.note));
        if (a.options?.length) {
          const g = el('div', 'bl-ask-opts'); g.setAttribute('role', 'radiogroup'); g.setAttribute('aria-label', a.q);
          a.options.forEach(o => {
            const b = el('button', 'bl-ask-opt', o); b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', 'false');
            b.addEventListener('click', () => { const on = answers[i].v !== o; answers[i].v = on ? o : ''; for (const x of g.children) x.setAttribute('aria-checked', String(on && x === b)); });
            g.append(b);
          });
          f.append(g);
        } else {
          const inp = el('input', 'bl-ask-text'); inp.type = 'text'; inp.placeholder = 'Your answer';
          inp.addEventListener('input', () => { answers[i].v = inp.value.trim(); });
          inp.addEventListener('keydown', e => e.stopPropagation());
          f.append(inp);
        }
        form.append(f);
      });
    }
    const ta = el('textarea'); ta.rows = 4; ta.placeholder = asks.length ? 'Anything else, in your own words (optional when the choices above say it all).' : 'Your feedback, answers or "go". It goes to the handoff session, which files fixes and closes the ticket.';
    const row = el('div', 'bl-ho-reply-row');
    const send = el('button', 'btn primary', 'Send to the session'); send.type = 'submit';
    const term = el('button', 'btn', 'Answer in terminal'); term.type = 'button';
    term.addEventListener('click', () => openInTerminal(sess.id));
    row.append(sessionLink(sess, sess.title || 'Session'), term, send);
    form.append(ta, row);
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const picked = asks.map((a, i) => answers[i].v ? `${i + 1}. ${a.q} -> ${answers[i].v}` : null).filter(Boolean);
      const free = ta.value.trim();
      const text = [...picked, free].filter(Boolean).join('\n'); if (!text) return;
      send.disabled = true;
      try {
        const r = await fetch(`/api/sessions/${sess.id}/send`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-chito': '1' }, body: JSON.stringify({ text: `[${t.key} handoff feedback] ${text}` }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || r.statusText);
        ta.value = ''; for (const a of answers) a.v = '';
        ctx.toast(j.action === 'typed' ? 'Typed into the live session' : 'Resumed the session in your terminal with your message');
        act('ticket-handoff', t.key, 'discussing');
      } catch (err) { ctx.toast(`Not sent: ${err.message}`); }
      send.disabled = false;
    });
    box.append(form);
  }
  return box;
}
