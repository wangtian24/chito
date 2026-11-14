// Backlog view: a main page with Overview and Projects tabs (swim lanes by project), a project page (dependency graph + table), and a ticket drawer.
// Reads /api/backlog (the local `bl` SQLite database). Read-only.
import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
// `t` is a ticket everywhere in this file, so the translator is tr / trp.
import { t as tr, tp as trp, lang, LOCALE } from '/i18n.js';

const $ = s => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const md = text => { const d = el('div', 'md'); d.innerHTML = DOMPurify.sanitize(marked.parse(text || '')); return d; };
const store = {
  get(k, d) { try { const v = localStorage.getItem('chito.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('chito.' + k, JSON.stringify(v)); } catch { } },
};

export const STATES = ['backlog', 'todo', 'in_progress', 'in_review', 'failed', 'done', 'canceled'];
const LABEL = { backlog: tr('Backlog'), todo: tr('Todo'), in_progress: tr('In progress'), in_review: tr('In review'), failed: tr('Failed'), done: tr('Done'), canceled: tr('Canceled') };
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

let ctx = null;          // { openSession, toast, fmtRel, fmtRelAgo, fmtDateTime, getPr }
const bl = { data: null, byKey: new Map(), blockers: new Map(), dependents: new Map(), depth: new Map(), order: new Map(), error: null, timer: null, ticket: null, ticketKey: null };
// View settings are per page and remembered per browser, each under its own key so nothing leaks between pages:
// the project page defaults to All tickets sorted by last updated (newest first); the Projects tab to every lane
// expanded and Open; Overview's list is fixed (collapsed, open tickets) and reads none of them.
const CLOSED_OPTS = ['none', 'recent', 'all', 'finished'];
const VIEW_KEYS = { project: ['blProjClosed', 'all'], lanes: ['blLanesClosed', 'none'] };
const savedClosed = pg => { const [k, d] = VIEW_KEYS[pg]; const v = store.get(k, d); return CLOSED_OPTS.includes(v) ? v : d; };
const savedSort = () => { const v = store.get('blProjSort', null); return v && typeof v.col === 'string' && (v.dir === 1 || v.dir === -1) ? v : { col: 'updated', dir: -1 }; };
const savedCollapsed = () => { const v = store.get('blLanesCollapsed', []); return new Set(Array.isArray(v) ? v : []); };
const ui = { page: 'lanes', closedBy: { project: savedClosed('project'), lanes: savedClosed('lanes') }, q: '', sort: savedSort(), milestone: null,
  collapsed: savedCollapsed(),
  get closed() { return this.closedBy[this.page] || 'none'; } };
function setClosed(v) { if (!VIEW_KEYS[ui.page]) return; ui.closedBy[ui.page] = v; store.set(VIEW_KEYS[ui.page][0], v); }
const saveCollapsed = () => store.set('blLanesCollapsed', [...ui.collapsed]);
try { for (const k of ['blCollapsed', 'blClosed2', 'blSort']) localStorage.removeItem('chito.' + k); } catch { }
ui.refresh = store.get('blRefresh', 60);
ui.finSort = { col: 'finished', dir: -1 };

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
  // /projects is the board's home; /backlog is the old name, still accepted (the server redirects it too).
  const m = pathname.match(/^\/(?:projects|backlog)(?:\/([^/]+))?(?:\/([^/]+))?\/?$/);
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
const projPath = p => `/projects/${encodeURIComponent(p)}`;
const ticketPath = t => `/projects/${encodeURIComponent(t.project)}/${encodeURIComponent(t.key)}`;

function sessionLink(s, label) {
  const a = el('a', 'bl-sess');
  a.href = `/s/${s.id}`;
  a.title = `${s.title || s.id}${s.role ? ` (${ROLE[s.role] || s.role})` : ''}`;
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
  if (bl.error) { root.append(el('div', 'board-status', tr('Could not load the backlog: {error}', { error: bl.error }))); return; }
  if (!bl.data) { root.append(el('div', 'prs-empty', tr('Loading…'))); return; }
  if (!bl.data.available) {
    const s = el('div', 'board-status');
    s.append(tr('No backlog database found at '), el('code', null, bl.data.db), tr('. Create one with '), el('code', null, 'bl init'), tr(', or set '), el('code', null, 'CHITO_BACKLOG_DB'), tr('.'));
    root.append(head(tr('Projects'), ''), s);
    return;
  }
  const project = route.project && bl.data.projects.find(p => p.key === route.project.toUpperCase());
  ui.page = route.project ? 'project' : currentTab() === 'overview' ? 'overview' : 'lanes';
  if (route.project && !project) { root.append(head(tr('Projects'), ''), el('div', 'prs-empty', tr('No project {key}.', { key: route.project }))); }
  else if (project) { document.title = `${project.key} · ${tr('Projects')} · chito`; renderProject(root, project); }
  else { document.title = `${tr('Projects')} · chito`; renderLanes(root); }
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
    const inp = el('input'); inp.type = 'search'; inp.placeholder = tr('Search key, title or label'); inp.id = 'blq'; inp.value = ui.q; inp.autocomplete = 'off'; inp.spellcheck = false;
    inp.addEventListener('input', () => { ui.q = inp.value; const pos = inp.selectionStart; renderBacklog(); const n = $('#blq'); n.focus(); n.setSelectionRange(pos, pos); });
    inp.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); if (inp.value) { ui.q = ''; renderBacklog(); } else inp.blur(); } });
    box.append(inp);
    row.append(box);
  }
  const seg = el('div', 'seg'); seg.setAttribute('role', 'radiogroup');
  for (const [v, label, tip] of [['none', tr('Open|tickets'), tr('Open tickets only')], ['recent', tr('+ 24h'), tr('Open, plus tickets closed in the last 24 hours')], ['all', tr('All'), tr('Every ticket, however old')], ['finished', tr('Finished'), tr('Only tickets finished (done, canceled or failed) in the last 7 days, across all projects, newest first')]]) {
    const b = el('button', null, label); b.setAttribute('aria-checked', String(ui.closed === v)); b.title = tip;
    b.addEventListener('click', () => { setClosed(v); renderBacklog(); });
    seg.append(b);
  }
  const cap = el('span', 'bl-cap', tr('Tickets')); row.append(cap, seg);
  return row;
}

// Closed tickets: shown by the Open / + 24h / All toggle; a search also digs up older ones (the newest few).
// Finished: only tickets that ended (done, canceled, failed) in the last 7 days, newest first.
const DAY_MS = 864e5, WEEK_MS = 7 * DAY_MS, SEARCH_OLD_CAP = 30;
const ENDED = new Set(['done', 'canceled', 'failed']);
const closedAt = t => new Date(t.finished || t.updated || 0).getTime();
// The Updated column's moment: when an ended ticket finished; for an open one, its last state change (else its last edit).
const shownAt = t => (ENDED.has(t.state) ? t.finished : t.changed) || t.updated || '';
// Exact relative time: '12m ago', '1h 20m ago'; from 2 h on, the Pacific clock time ('14:35 PT', 'Nov 12, 14:35 PT', 'Nov 12 2025, 14:35 PT').
// In Chinese: '12分钟前', '1小时20分钟前', '14:35 PT', '11月12日 14:35 PT', '2025年11月12日 14:35 PT'.
const PT_PARTS = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: lang === 'zh' ? 'numeric' : 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const ptParts = d => Object.fromEntries(PT_PARTS.formatToParts(d).map(p => [p.type, p.value]));
export function fmtAgo(iso, now = new Date()) {
  if (!iso) return '';
  const d = new Date(iso);
  const min = Math.floor((now - d) / 60000);
  if (min < 1) return tr('just now');
  if (min < 60) return tr('{n}m ago', { n: min });
  if (min < 120) return min === 60 ? tr('{n}h ago', { n: 1 }) : tr('{h}h {m}m ago', { h: 1, m: min - 60 });
  const p = ptParts(d), n = ptParts(now);
  const clock = `${p.hour}:${p.minute} PT`;
  if (p.year === n.year && p.month === n.month && p.day === n.day) return clock;
  if (lang === 'zh') return `${p.year === n.year ? '' : p.year + '年'}${p.month}月${p.day}日 ${clock}`;
  return `${p.month} ${p.day}${p.year === n.year ? '' : ' ' + p.year}, ${clock}`;
}
const closedRecently = t => Date.now() - closedAt(t) < DAY_MS;
const showsClosed = () => ui.closed !== 'none' || !!ui.q.trim();
const finishedMode = () => ui.closed === 'finished';
function visibleTickets(list) {
  if (finishedMode()) return list.filter(t => ENDED.has(t.state) && Date.now() - closedAt(t) < WEEK_MS).sort((a, b) => closedAt(b) - closedAt(a));
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

const REFRESH = [[0, tr('Off')], [60, tr('{n}m', { n: 1 })], [300, tr('{n}m', { n: 5 })], [600, tr('{n}m', { n: 10 })], [1800, tr('{n}m', { n: 30 })], [3600, tr('{n}h', { n: 1 })]];
function refreshSelect() {
  const wrap = el('label', 'bl-sel bl-refresh'); wrap.title = tr('Auto-refresh this page');
  wrap.append(el('span', null, tr('Auto-refresh')));
  const s = el('select');
  for (const [v, t] of REFRESH) { const o = el('option', null, t); o.value = String(v); if (v === ui.refresh) o.selected = true; s.append(o); }
  s.addEventListener('change', () => { ui.refresh = Number(s.value); store.set('blRefresh', ui.refresh); startBacklogPolling(); ctx.toast(ui.refresh ? tr('Refreshing every {every}', { every: REFRESH.find(r => r[0] === ui.refresh)[1] }) : tr('Auto-refresh off')); });
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
  const b = el('button', 'btn'); b.title = tr('Reload from the database');
  b.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.9-3.9M4 5v4h4M4 13a8 8 0 0 0 14.9 3.9M20 19v-4h-4"/></svg>';
  b.append(el('span', null, tr('Refresh')));
  b.addEventListener('click', async () => { await loadBacklog(); renderBacklog(); ctx.toast(tr('Up to date')); });
  return b;
}

function progress(tks) {
  const total = tks.filter(t => t.state !== 'canceled').length;
  const done = tks.filter(t => t.state === 'done').length;
  const bar = el('div', 'bl-progress'); bar.title = tr('{done} of {total} done', { done, total });
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
  const s = el('span', 'bl-run'); s.title = tr('Orchestrator pid {pid}, started {started}, last heartbeat {ago}', { pid: r.pid, started: ctx.fmtDateTime(r.started), ago: ctx.fmtRelAgo(r.heartbeat) });
  s.append(el('span', 'live-dot busy'), tr('Running'));
  return s;
}

// ---- controls (each one runs an allowlisted `bl` command on the server) ----
async function act(action, key, value) {
  try {
    const r = await fetch('/api/backlog/action', { method: 'POST', headers: { 'content-type': 'application/json', 'x-chito': '1' }, body: JSON.stringify({ action, key, value }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    ctx.toast(j.out ? `${key ? key + ': ' : ''}${j.out.split('\n')[0]}` : tr('Done'));
  } catch (e) { ctx.toast(tr('Failed: {error}', { error: e.message })); }
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
      b.textContent = tr('Confirm {action}?', { action: lang === 'zh' ? label : label.toLowerCase() }); b.classList.add('armed');
      armed = setTimeout(() => { armed = null; b.textContent = label; b.classList.remove('armed'); }, 3000);
      return;
    }
    clearTimeout(armed); b.disabled = true; act(action, key, value);
  });
  return b;
}

// Words that come from the database as codes; anything not listed shows as stored.
const ROLE = { worker: tr('worker'), created: tr('created'), touched: tr('touched') };
const EVENT = { created: tr('created'), state: tr('state'), claim: tr('claim'), comment: tr('comment'), edit: tr('edit'), dep: tr('dep'), spawn: tr('spawn'), handoff: tr('handoff'), brief: tr('brief'), run: tr('run'), quota: tr('quota'), milestone: tr('milestone'), project: tr('project'), daemon: tr('daemon'), orchestrator: tr('orchestrator') };
const SESS_KIND = { 'Handoff session': tr('Handoff session'), Briefing: tr('Briefing'), 'Worker session': tr('Worker session'), 'Orchestrator session': tr('Orchestrator session') };
const PRIO = [tr('Urgent'), tr('High'), tr('Normal'), tr('Low'), tr('None')];
const PSTATE = { planning: tr('Planning'), executing: tr('Executing'), paused: tr('Paused'), done: tr('Done'), archived: tr('Archived'), active: tr('Executing') };
function projState(p) {
  const orphan = isOrphan(p);
  const s = el('span', `bl-pstate ps-${p.status}${orphan ? ' orphan' : ''}`, orphan ? tr('Orphaned') : PSTATE[p.status] || p.status);
  s.title = orphan ? tr('Executing, but its owner ({owner}) stopped responding. Resume it with /backlog-run, or let the daemon adopt it.', { owner: p.owner }) : tr('Project is {status}', { status: PSTATE[p.status] || p.status });
  return s;
}
function isOrphan(p) {
  if (p.status !== 'executing' || p.executor !== 'session' || !p.owner || p.owner === 'daemon') return false;
  if ((bl.data.runs || []).some(r => r.project === p.key && r.status === 'running' && r.alive)) return false;
  const lease = setting(p.key, 'lease_minutes', 30);
  return !p.owner_heartbeat || Date.now() - new Date(p.owner_heartbeat).getTime() > lease * 60e3;
}
const MODES = {
  session: { short: tr('Manual'), title: tr('Manual (SO): you start /backlog-run in a session and it orchestrates until done') },
  auto: { short: tr('Auto'), title: tr('Auto (DSO): the daemon starts an orchestrator session whenever tickets are ready, and again when more arrive') },
  daemon: { short: tr('Simple'), title: tr('Simple (DQ): the daemon runs one Claude per ready ticket, with no orchestrator session') },
};
const CEDAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l4.5 6h-2.5l4 5h-2.5l4 5.5H4.5l4-5.5H6l4-5H7.5z" fill="currentColor"/><path d="M12 19v3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
function evergreenIcon() {
  const s = el('span', 'bl-ever'); s.innerHTML = CEDAR; s.title = tr('Evergreen: this project never finishes; new tickets keep flowing'); s.setAttribute('role', 'img'); s.setAttribute('aria-label', tr('Evergreen'));
  return s;
}
// Project page: click the name to rename it; Enter or leaving the field saves, Escape cancels.
function nameEditor(p) {
  const t = el('button', 'bl-name-edit', p.name); t.title = tr('Click to rename');
  t.addEventListener('click', () => {
    const inp = el('input', 'bl-name-input'); inp.value = p.name; inp.maxLength = 120; const fit = () => { inp.size = Math.max(12, inp.value.length + 2); }; fit(); inp.addEventListener('input', fit); inp.setAttribute('aria-label', tr('Project name'));
    let done = false;
    const finish = save => {
      if (done) return; done = true;
      const v = inp.value.replace(/\s+/g, ' ').trim();
      if (save && v && v !== p.name) { t.textContent = v; act('project-name', p.key, v); }
      inp.replaceWith(t);
    };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
    inp.addEventListener('blur', () => finish(true));
    t.replaceWith(inp); inp.focus(); inp.select();
  });
  return t;
}
// Project page: a tree beside the title, filled when evergreen, hollow when not; click to switch.
function evergreenToggle(p) {
  const on = !!p.evergreen;
  const b = el('button', `bl-ever-toggle${on ? ' on' : ''}`);
  b.innerHTML = on ? CEDAR : CEDAR.replaceAll('fill="currentColor"', 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"');
  b.setAttribute('aria-pressed', String(on));
  b.setAttribute('aria-label', tr('Evergreen'));
  b.title = on ? tr('Evergreen: this project never finishes; new tickets keep flowing in. Click to make it a normal project.') : tr('Not evergreen: the project finishes when its tickets are done. Click to make it evergreen.');
  b.addEventListener('click', () => act('project-evergreen', p.key, !on));
  return b;
}
// Lane header chips: the status only when it is news (not Executing), the mode once, evergreen as an icon.
function laneBadges(p) {
  const out = [];
  out.push(execBadge(p));   // the mode chip first, so chips line up across rows; the status word follows it
  if (p.status !== 'executing' || isOrphan(p)) out.push(projState(p));
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
  if (p.status === 'planning') box.append(actBtn(tr('Start'), 'project-start', p.key, null, { primary: true, title: tr('Move to executing so its executor picks up ready tickets') }));
  if (p.status === 'executing') box.append(actBtn(tr('Pause'), 'project-pause', p.key, null, { title: tr('Running work finishes; nothing new is claimed') }));
  if (p.status === 'paused') box.append(actBtn(tr('Resume'), 'project-resume', p.key, null, { primary: true }));
  if (!compact) {
    if (p.status !== 'planning') box.append(actBtn(tr('Back to planning'), 'project-plan', p.key));
    const seg = el('div', 'seg bl-seg'); seg.title = tr('Orchestration: who runs this project');
    for (const ex of ['session', 'auto', 'daemon']) {
      const b = el('button', null, MODES[ex].short); b.title = MODES[ex].title; b.setAttribute('aria-checked', String(p.executor === ex));
      b.addEventListener('click', () => { if (p.executor !== ex) act('project-executor', p.key, ex); });
      seg.append(b);
    }
    const lab = el('span', 'bl-cap', tr('Orchestration')); box.append(lab, seg);
    box.append(actBtn(tr('Archive'), 'project-archive', p.key, null, { confirm: true }));
  }
  return box;
}

function daemonBar() {
  const d = bl.data.daemon;
  const bar = el('div', 'bl-daemon');
  const cap = setting(null, 'global_max_parallel', 6);
  const dot = el('span', 'live-dot' + (d?.alive && d.enabled ? ' busy' : ''));
  const label = !d || !d.alive ? tr('Daemon not running') : d.enabled ? tr('Daemon running') : tr('Daemon paused');
  const t = el('b', null, label);
  const facts = el('span', 'bl-daemon-facts');
  const workers = bl.data.tickets.filter(x => x.state === 'in_progress' && (x.claimed_by || '').startsWith('daemon:')).length;
  const hb = d?.heartbeat ? el('span', null, tr('heartbeat {ago}', { ago: ctx.fmtRelAgo(d.heartbeat) })) : null;
  if (hb) hb.title = ctx.fmtDateTime(d.heartbeat);
  const runs = d?.runsToday ?? 0;
  facts.append(factRow('', workers ? trp(workers, '{n} queue worker', '{n} queue workers') : null, trp(runs, '{n} run today', '{n} runs today'), tr('up to {n} at once', { n: cap }), hb));
  bar.append(dot, t, facts);
  if (d?.quota?.until) {
    const q = el('div', 'bl-quota');
    q.append(el('b', null, tr('Usage limit hit.')), tr(' Nothing new starts until {until}; the tickets that hit it went back to todo without using an attempt.', { until: ctx.fmtDateTime(d.quota.until) }));
    if (d.quota.last?.ticket) q.append(tr(' Last: {key}.', { key: d.quota.last.ticket }));
    q.append(actBtn(tr('Retry now'), 'quota-clear', null, null, { title: tr('Clear the pause; the next claims try again') }));
    bar.append(q);
  }
  if (d?.alive) bar.append(d.enabled ? actBtn(tr('Pause daemon'), 'daemon-pause', null, null, { title: tr('Workers already running finish; nothing new starts') }) : actBtn(tr('Resume daemon'), 'daemon-resume', null, null, { primary: true }));
  else { const hint = el('span', 'bl-daemon-hint'); hint.append(tr('Start it with '), el('code', null, 'bl daemon install')); bar.append(hint); }
  return bar;
}

function executorOf(t) {
  const c = t.claimed_by || '';
  if (c.startsWith('daemon:')) return [tr('Queue worker'), 'ex-queue'];
  if (c.startsWith('orchs:')) return [tr('Auto orchestrator'), 'ex-orch'];
  if (c.startsWith('orch:')) return ['bl run', 'ex-orch'];
  if (c.startsWith('cc:')) return [tr('Session'), 'ex-session'];
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
  if (!rows.length) { wrap.append(el('div', 'bl-flight-empty', tr('Nothing running right now.'))); return wrap; }
  for (const t of rows) {
    const r = linkTo(el('a', 'bl-flight-row'), ticketPath(t));
    const [ex, cls] = executorOf(t);
    const since = t.spawn?.at || t.started;
    const sess = workerSession(t);
    r.append(stateIcon('in_progress'), el('span', 'num bl-flight-key', t.key), el('span', 'bl-flight-title', t.title),
      el('span', 'bl-flight-model', t.spawn?.model || ''),
      el('span', 'num bl-flight-since', since ? ctx.fmtRel(since) : ''));
    r.lastChild.title = since ? `${tr('Started {when}', { when: ctx.fmtDateTime(since) })}${t.attempts > 1 ? ` · ${tr('attempt {n}', { n: t.attempts })}` : ''}` : '';
    r.title = `${ex}${t.claimed_by ? ` (${t.claimed_by})` : ''}`;
    if (sess) { const a = sessionLink(sess, tr('Session')); a.classList.add('bl-flight-sess'); r.append(a); }
    else r.append(el('span', 'bl-flight-sess none', tr('no session yet')));
    wrap.append(r);
  }
  return wrap;
}

// ---- who is executing a project ----
// The orchestrator session is where general instructions for a project go, so its link is a button, not a footnote.
function orchLink(s, compact, last = false) {
  const a = sessionLink(s, compact ? (last ? tr('Last orchestrator') : tr('Orchestrator')) : (last ? tr('Open the last orchestrator session') : tr('Open the orchestrator session')));
  a.classList.add('btn', 'bl-orch-link');
  a.title = tr('{title}: give the orchestrator general instructions for this project here', { title: s.title || s.id });
  return a;
}
// Standing instructions: every orchestrator run and every worker prompt in this project gets them, and a running
// orchestrator re-reads them each round (bl instructions KEY).
function instructionsBox(p) {
  const box = el('details', 'bl-instr'); if (p.instructions) box.open = true;
  const sum = el('summary', null, tr('Standing instructions'));
  sum.append(el('span', 'bl-instr-hint', p.instructions ? tr(' every orchestrator and worker in this project follows these') : tr(' none yet: guidance every orchestrator and worker here should follow')));
  const ta = el('textarea'); ta.value = p.instructions || ''; ta.rows = 4; ta.placeholder = tr('For example: deploy only at milestones. Always add a unit test. Leave the billing code alone.');
  ta.addEventListener('keydown', e => e.stopPropagation());
  const save = el('button', 'btn primary', tr('Save')); save.type = 'button';
  save.addEventListener('click', () => { save.disabled = true; act('project-instructions', p.key, ta.value); });
  const row = el('div', 'bl-instr-row'); row.append(save, el('span', 'bl-instr-hint', tr('A running orchestrator picks changes up at its next round.')));
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
      row.append(el('span', 'live-dot busy'), el('span', null, tr('Orchestrator running')), orchLink(o, compact));
      box.append(row);
    } else {
      box.append(el('span', null, !d?.alive ? tr('Daemon not running') : !d.enabled ? tr('Daemon paused') : d.quota?.until ? tr('Waiting for the usage limit to reset') : compact ? tr('Idle') : tr('Idle; the daemon starts an orchestrator when tickets are ready')));
      if (!d?.alive || !d?.enabled || d?.quota?.until) box.classList.add('warn');
      const last = (p.orchSessions || [])[0];
      if (last) box.append(orchLink(last, compact, true));
    }
    return box;
  }
  if (p.executor === 'daemon') {
    const d = bl.data.daemon;
    const n = (ex.workers || []).length;
    box.append(el('span', null, !d?.alive ? tr('Daemon not running') : !d.enabled ? tr('Daemon paused') : n ? tr('{n} working', { n }) : tr('Idle')));
    if (!d?.alive || !d?.enabled) box.classList.add('warn');
    return box;
  }
  if (ex.runs?.length) {
    for (const r of ex.runs) {
      const row = el('span', 'bl-execrun');
      row.append(el('span', 'live-dot busy'), el('span', null, tr('Orchestrator pid {pid}', { pid: r.pid })));
      if (r.session) row.append(orchLink(r.session, compact)); else row.append(el('span', null, tr('launching its session')));
      row.title = tr('bl run started {started}; heartbeat {ago}', { started: ctx.fmtDateTime(r.started), ago: ctx.fmtRelAgo(r.heartbeat) });
      box.append(row);
    }
    return box;
  }
  if (ex.owner?.session) {
    const row = el('span', 'bl-execrun');
    row.append(el('span', 'live-dot' + (isOrphan(p) ? '' : ' busy')), el('span', null, isOrphan(p) ? tr('Owner session went quiet') : tr('Run by session')),
      orchLink(ex.owner.session, compact));
    box.append(row);
    if (isOrphan(p)) box.classList.add('warn');
    return box;
  }
  const ready = bl.data.tickets.filter(t => t.project === p.key && isReady(t)).length;
  if (!ready) return null;
  box.classList.add('warn');
  box.append(el('span', null, tr('{n} ready, no orchestrator running', { n: ready })));
  const hint = el('code', null, `/backlog-run ${p.key}`); hint.title = tr('Run it from a Claude Code session, or switch the executor to Daemon');
  box.append(hint);
  return box;
}

// ---- usage (nominal cost from transcripts) ----
const fmtTok = n => n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n || 0);
const fmtCost = u => u ? `$${u.cost < 10 ? u.cost.toFixed(2) : Math.round(u.cost)}${u.unpriced ? '+' : ''}` : '';
function usageTitle(u) {
  if (!u) return '';
  return `${tr('Nominal list-price cost (not billed on a subscription)')}\n${tr('{n} model turns', { n: u.turns })} · ${(u.models || []).join(', ')}\n` +
    tr('input {input} · output {output} · cache read {cacheRead} · cache write {cacheWrite}', { input: fmtTok(u.input), output: fmtTok(u.output), cacheRead: fmtTok(u.cacheRead), cacheWrite: fmtTok(u.cacheWrite) });
}
function usageStat(label, u) {
  const s = el('span', 'bl-usage');
  s.append(el('span', null, label), el('b', 'num', fmtCost(u)), factRow('num', tr('{n} turns', { n: u.turns }), tr('{n} tokens', { n: fmtTok(u.tokens) })));
  s.title = usageTitle(u);
  return s;
}

// ---- results ----
// Under a finished ticket's title: links to what it made (arti docs, other pages; PRs have their own column) and one line of what it did.
const URL_RE = /https?:\/\/[^\s)\]>,'"]+/g;
const BOILER_RE = /^(pr \d+ merged|merged|squash|db:|not deployed|deployed|pr #|pr https|arti:|local main|live |where the code is)/i;
function resultLine(t) {
  if (t.state !== 'done' || !t.result) return null;
  const urls = [...new Set((t.result.match(URL_RE) || []).map(u => u.replace(/[.;:]+$/, '')))];
  const links = [];
  for (const u of urls) {
    if (/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(u)) continue;      // PRs come from t.prs below
    let label;
    try { const x = new URL(u); label = /arti\./.test(x.host) ? tr('doc: {slug}', { slug: x.pathname.split('/')[2] || x.host }) : x.host.replace(/^www\./, ''); } catch { continue; }
    if (/^localhost|^127\./.test(label)) continue;
    const a = el('a', 'bl-res-link', label); a.href = u; a.target = '_blank'; a.rel = 'noopener'; a.title = u;
    a.addEventListener('click', e => e.stopPropagation());
    links.push(a);
    if (links.length >= 2) break;
  }
  const text = t.result.replace(URL_RE, '').replace(/[*_`#>]/g, '').replace(/\(\s*\)/g, '').replace(/\s+/g, ' ').trim();
  const sentences = text.split(/(?<=[.!?])\s+|\s\|\s/).map(x => x.trim()).filter(Boolean);
  let one = sentences.find(x => !BOILER_RE.test(x) && x.length > 12) || '';
  if (one.length > 140) one = one.slice(0, 137).replace(/\s\S*$/, '') + '…';
  if (!links.length && !one) return null;
  const row = el('div', 'bl-res');
  row.append(...links);
  if (one) row.append(el('span', 'bl-res-text', one));
  row.title = tr('Result: the full text is in the details');
  return row;
}

// ---- PRs ----
function prChips(t, max = 3) {
  const out = [];
  for (const pr of (t.prs || []).slice(0, max)) {
    const gh = ctx.getPr ? ctx.getPr(pr.url) : null;
    const st = gh?.state || 'UNKNOWN';
    const a = el('a', `bl-pr st-${st}`);
    a.href = pr.url; a.target = '_blank'; a.rel = 'noopener';
    a.title = `${pr.repo || ''} #${pr.number}${gh?.title ? ' · ' + gh.title : ''} · ${PR_STATE[st] || st.toLowerCase()}`;
    a.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7M18 15.5V9a3 3 0 0 0-3-3h-3"/></svg>';
    a.append(el('span', 'num', `#${pr.number}`));
    a.addEventListener('click', e => e.stopPropagation());
    out.push(a);
  }
  if ((t.prs || []).length > max) out.push(el('span', 'num bl-pr-more', `+${t.prs.length - max}`));
  return out;
}

// ---- milestones ----
const PR_STATE = { OPEN: tr('open'), DRAFT: tr('draft'), MERGED: tr('merged'), CLOSED: tr('closed'), UNKNOWN: tr('unknown') };
const MS_LABEL = { planned: tr('Planned'), active: tr('Active|milestone'), reached: tr('Reached'), showcased: tr('Showcased'), canceled: tr('Canceled') };
function msTrigger(m) {
  if (m.trigger === 'deploy') return tr('On deploy ({gate})', { gate: m.gate || '?' });
  if (m.trigger === 'manual') return tr('Manual');
  return tr('When all done');
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
    card.title = ui.milestone === m.key ? tr('Show all tickets') : tr("Show only this milestone's tickets");
    card.addEventListener('click', e => { if (e.target.closest('a')) return; ui.milestone = ui.milestone === m.key ? null : m.key; renderBacklog(); });
    const top = el('div', 'bl-ms-top');
    top.append(el('span', 'num bl-ms-key', m.key.slice(p.key.length + 1)), el('span', `bl-ms-state ms-${m.status}`, MS_LABEL[m.status] || m.status));
    if (m.due) { const due = el('span', 'bl-ms-due', tr('due {date}', { date: m.due })); if (m.due < new Date().toISOString().slice(0, 10) && !['reached', 'showcased'].includes(m.status)) due.classList.add('late'); top.append(due); }
    card.append(top, el('div', 'bl-ms-title', m.title));
    const meta = el('div', 'bl-ms-meta'); meta.append(el('span', null, msTrigger(m)));
    if (m.showcase_kind && m.showcase_kind !== 'none') meta.append(el('span', null, tr('showcase: {kind}', { kind: m.showcase_kind })));
    card.append(meta, progress(tks));
    if (m.showcases?.length) card.append(showcaseItems(m));
    else if (m.showcase_ticket) {
      const st = bl.byKey.get(m.showcase_ticket);
      if (st) { const l = linkTo(el('a', 'bl-ms-st'), ticketPath(st)); l.append(stateIcon(st.state), el('span', null, tr('Showcase {key}: {state}', { key: st.key.slice(p.key.length + 1), state: lang === 'zh' ? LABEL[st.state] : LABEL[st.state].toLowerCase() }))); card.append(l); }
    }
    wrap.append(card);
  }
  const none = bl.data.tickets.filter(t => t.project === p.key && !t.milestone && !t.meta?.showcase_for && !FINAL.has(t.state)).length;
  if (none) {
    const c = el('button', `bl-ms ms-none${ui.milestone === '-' ? ' on' : ''}`); c.type = 'button';
    c.append(el('div', 'bl-ms-title', trp(none, '{n} open ticket without a milestone', '{n} open tickets without a milestone')));
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
const PHASE = { preparing: tr('Preparing your handoff'), awaiting: tr('Ready for you'), discussing: tr('In discussion') };
function needReason(t) {
  const ph = t.meta?.handoff?.phase;
  if (t.assignee === 'human' && PHASE[ph]) return PHASE[ph];
  if (t.state === 'failed') return tr('Failed, decide: retry, fix the spec or cancel');
  if (t.state === 'in_review') return tr('Review the PR, then approve');
  return tr('Your decision');
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
    ctx.toast(j.action === 'focused' ? tr('Focused its terminal') : j.action === 'forked' ? tr('Still running in the background, so this opened a forked copy; the running session will not see what you type there') : tr('Opened in a terminal'));
  } catch (e) { ctx.toast(tr('Could not open: {error}', { error: e.message })); }
}
function needsYouPanel(tks) {
  const items = tks.filter(needsYou);
  const ms = (bl.data.milestones || []).filter(m => m.status === 'showcased' && tks.some(t => t.project === m.project));
  if (!items.length && !ms.length) return null;
  const open = store.get('blNeedsOpen', true);
  const box = el('div', `bl-needs${open ? '' : ' folded'}`);
  // The header is the toggle: folding keeps the count in view, so nothing hides silently.
  const h = el('button', 'bl-needs-head'); h.type = 'button';
  h.innerHTML = '<svg class="bl-needs-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
  h.append(el('b', null, tr('Waiting on you')), el('span', 'num', String(items.length + ms.length)));
  const sync = o => { box.classList.toggle('folded', !o); h.setAttribute('aria-expanded', String(o)); h.title = o ? tr('Fold this list') : tr('Show what is waiting on you'); };
  sync(open);
  h.addEventListener('click', () => { const o = box.classList.contains('folded'); store.set('blNeedsOpen', o); sync(o); });
  box.append(h);
  for (const t of items) {
    const row = el('div', 'bl-needs-row');
    const title = linkTo(el('a', 'bl-needs-title'), ticketPath(t));
    title.append(el('span', 'num', t.key), el('span', null, t.title));
    const why = el('span', 'bl-needs-why', needReason(t));
    const act = el('div', 'bl-needs-act');
    const b = t.meta?.brief;
    const sess = answerSession(t);
    if (t.meta?.handoff?.packet) act.append(linkTo(el('a', 'btn primary bl-open-handoff', tr('Open handoff')), ticketPath(t)));
    else if (b?.pending) act.append(el('span', 'bl-needs-pending', tr('Preparing a briefing')));
    if (sess) {
      const open = sessionLink(sess, sess.kind === 'Briefing' ? tr('Read the briefing') : SESS_KIND[sess.kind] || sess.kind);
      const term = el('button', `btn${sess.kind === 'Briefing' && !t.meta?.handoff?.packet ? ' primary' : ''}`, tr('Answer in terminal')); term.type = 'button';
      term.title = sess.title ? tr('Resume {title} in your terminal and reply there', { title: sess.title }) : tr('Resume the session in your terminal and reply there');
      term.addEventListener('click', e => { e.stopPropagation(); openInTerminal(sess.id); });
      act.append(open, term);
    } else if (!b?.pending) act.append(el('span', 'bl-needs-pending', tr('No session yet')));
    if (b?.error) act.append(el('span', 'bl-needs-pending', tr('Briefing failed; the daemon retries after a restart')));
    if (t.meta?.handoff?.phase) row.classList.add(`ph-${t.meta.handoff.phase}`);
    row.append(title, why, act);
    box.append(row);
  }
  for (const m of ms) {
    const row = el('div', 'bl-needs-row');
    const title = linkTo(el('a', 'bl-needs-title'), projPath(m.project)); title.append(el('span', 'num', m.key), el('span', null, m.title));
    row.append(title, el('span', 'bl-needs-why', tr('Review the showcase, then accept or reopen')), el('div', 'bl-needs-act'));
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
  if (t.priority <= 1) top.append(el('span', `bl-prio p${t.priority}`, t.priority === 0 ? tr('Urgent') : tr('High')));
  c.append(top, el('div', 'bl-card-title', t.title));
  const meta = el('div', 'bl-card-meta');
  const bs = (bl.blockers.get(t.key) || []).filter(b => !FINAL.has(bl.byKey.get(b)?.state ?? 'done'));
  if (t.state === 'todo') {
    if (bs.length) meta.append(el('span', 'wait', tr('Waits on {keys}', { keys: bs.map(b => b.startsWith(t.project + '-') ? b.slice(t.project.length + 1) : b).join(', ') })));
    else if (t.assignee === 'human') meta.append(el('span', 'bad', tr('Needs you')));
    else meta.append(el('span', 'ok', tr('Ready')));
  }
  if (t.state === 'in_progress' && t.attempts > 1) meta.append(el('span', null, tr('try {n}', { n: t.attempts })));
  if (t.state === 'failed') meta.append(el('span', 'bad', trp(t.attempts, '{n} attempt', '{n} attempts')));
  if (t.state === 'in_review') meta.append(el('span', 'wait', tr('Waiting for approval')));
  if (t.assignee === 'human' && t.state !== 'todo') meta.append(el('span', null, tr('human')));
  meta.append(...prChips(t, 2));
  if (t.sessions?.length) meta.append(sessionLink(t.sessions[0], t.sessions.length > 1 ? String(t.sessions.length) : null));
  if (meta.childNodes.length) c.append(meta);
  return c;
}

// ---- main page tabs: Overview (daemon, waiting on you, open projects) and Projects (lanes + the tickets toggle) ----
// The tab lives in ?tab=; with none in the URL, the last one picked is used, else Overview.
const TABS = [['overview', tr('Overview')], ['projects', tr('Projects')]];
function currentTab() {
  const q = new URLSearchParams(location.search).get('tab');
  if (TABS.some(([k]) => k === q)) return q;
  const saved = store.get('blTab', 'overview');
  return TABS.some(([k]) => k === saved) ? saved : 'overview';
}
function setTab(k) {
  store.set('blTab', k);
  const url = new URL(location.href);
  if (k === 'overview') url.searchParams.delete('tab'); else url.searchParams.set('tab', k);
  if (url.href !== location.href) history.pushState({}, '', url.pathname + url.search + url.hash);
  renderBacklog();
  $(`#bl-tab-${k}`)?.focus();
}
function tabBar(cur, counts) {
  const bar = el('div', 'tabs bl-tabs'); bar.setAttribute('role', 'tablist'); bar.setAttribute('aria-label', tr('Projects views'));
  for (const [k, label] of TABS) {
    const b = el('button', 'tab', label); b.type = 'button'; b.id = `bl-tab-${k}`;
    b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(k === cur)); b.tabIndex = k === cur ? 0 : -1;
    const n = counts[k];
    if (k === 'overview' && n) { const c = el('span', 'num bl-tab-count you', String(n)); c.title = tr('{n} waiting on you', { n }); b.append(c); b.title = tr('{n} waiting on you', { n }); }
    else if (k === 'projects' && n) b.append(el('span', 'num bl-tab-count', String(n)));
    b.addEventListener('click', () => { if (k !== cur) setTab(k); });
    b.addEventListener('keydown', e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault(); e.stopPropagation();
      const i = TABS.findIndex(([x]) => x === k), j = (i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
      setTab(TABS[j][0]);
    });
    bar.append(b);
  }
  return bar;
}

function renderLanes(root) {
  const d = bl.data;
  const projects = d.projects.filter(p => p.status !== 'archived');
  const all = d.tickets;
  const running = all.filter(t => t.state === 'in_progress').length;
  const you = all.filter(needsYou).length;
  const sub = [factRow('', trp(projects.length, '{n} project', '{n} projects'), tr('{n} in progress', { n: running }), you ? tr('{n} waiting on you', { n: you }) : tr('nothing waiting on you'))];
  root.append(head(tr('Projects'), sub, headRight()));
  const tab = currentTab();
  if (tab !== 'overview' && !new URLSearchParams(location.search).has('tab')) {   // a remembered tab: show it in the URL too
    const url = new URL(location.href); url.searchParams.set('tab', tab); history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  }
  root.append(tabBar(tab, { overview: you, projects: projects.length }));
  if (tab === 'overview') {
    root.append(daemonBar());
    const ny = needsYouPanel(all); if (ny) root.append(ny);
    root.append(el('h2', 'bl-h2', tr('Open projects')), openProjects(projects, all));
    return;
  }
  const ctl = controls();
  const visible = projects.map(p => p.key);
  const allCollapsed = visible.length && visible.every(k => ui.collapsed.has(k));
  const tog = el('button', 'btn bl-collapse-all', allCollapsed ? tr('Expand all') : tr('Collapse all'));
  tog.title = allCollapsed ? tr("Show every project's tickets") : tr('Show projects only');
  tog.addEventListener('click', () => { if (allCollapsed) visible.forEach(k => ui.collapsed.delete(k)); else visible.forEach(k => ui.collapsed.add(k)); saveCollapsed(); renderBacklog(); });
  ctl.insertBefore(tog, ctl.querySelector('.bl-cap'));
  root.append(ctl);
  if (finishedMode()) {   // one flat list across projects, newest finished first
    tog.remove();
    const live = new Set(projects.map(p => p.key));
    root.append(table(visibleTickets(all).filter(t => live.has(t.project) && matches(t))));
    return;
  }
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
  if (!projects.length) grid.append(el('div', 'prs-empty', tr('No projects yet. Create one with bl project add.')));
  for (const p of projects) {
    const tks = all.filter(t => t.project === p.key);
    const shown = visibleTickets(tks).filter(matches);
    if (ui.q.trim() && !shown.length) continue;
    if (tks.length && !visibleTickets(tks).length) continue;
    const lane = el('div', 'bl-lane');
    const side = el('div', 'bl-lane-side');
    const collapsed = ui.collapsed.has(p.key);
    const chev = el('button', `bl-chev${collapsed ? '' : ' open'}`);
    chev.type = 'button'; chev.title = collapsed ? tr('Show tickets') : tr('Hide tickets');
    chev.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
    chev.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); if (collapsed) ui.collapsed.delete(p.key); else ui.collapsed.add(p.key); saveCollapsed(); renderBacklog(); });
    const name = linkTo(el('a', 'bl-lane-name'), projPath(p.key));
    name.append(el('span', 'bl-lane-key num', p.key), el('span', 'bl-lane-title', p.name));
    const nameRow = el('div', 'bl-lane-namerow'); nameRow.append(chev, name);
    if (collapsed) { grid.append(compactLane(p, tks, shown, nameRow)); continue; }
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
    const you = tks.filter(needsYou).length; if (you) facts.append(el('span', 'bad', trp(you, '{n} needs you', '{n} need you')));
    side.append(facts);
    lane.append(side);
    for (const st of cols) {
      const col = el('div', `bl-col bl-col-${st}`);
      let list = shown.filter(t => t.state === st).sort((a, b) => bl.order.get(a.key) - bl.order.get(b.key));
      if (st === 'done') list = list.sort((a, b) => ((b.finished || '') > (a.finished || '') ? 1 : -1));
      const cap = st === 'done' ? 4 : 50;
      for (const t of list.slice(0, cap)) col.append(card(t));
      if (list.length > cap) col.append(linkTo(el('a', 'bl-more', tr('{n} more', { n: list.length - cap })), projPath(p.key)));
      lane.append(col);
    }
    grid.append(lane);
  }
  root.append(grid);
}

// ---- compact project rows: the collapsed lanes on Projects, and the read-only list on Overview ----
// One row per project (name, mode chip, state counts, progress) with its in-flight tickets under it.
function compactLane(p, tks, shown, nameRow) {
  const lane = el('div', 'bl-lane');
  const row = el('div', 'bl-lane-compact');
  const head = el('div', 'bl-compact-head');
  const name = nameRow.querySelector('.bl-lane-name'); if (name) name.title = `${p.key} ${p.name}`;
  head.append(nameRow);
  const b2 = el('div', 'bl-lane-badges'); b2.append(...laneBadges(p)); head.append(b2);
  const counts = el('div', 'bl-compact-counts');
  for (const st of LANE_COLS) { const n = shown.filter(t => t.state === st).length; if (n) { const x = statePill(st); x.append(el('span', 'num', String(n))); counts.append(x); } }
  const you = tks.filter(needsYou).length; if (you) counts.append(el('span', 'bl-compact-you', trp(you, '{n} needs you', '{n} need you')));
  head.append(counts, progress(tks));
  row.append(head);
  const run = shown.filter(t => t.state === 'in_progress').sort((a, b) => (a.started || '') < (b.started || '') ? -1 : 1);
  if (run.length) {
    const list = el('div', 'bl-compact-run');
    for (const t of run) list.append(flightRow(t, p));
    row.append(list);
  }
  lane.append(row);
  return lane;
}
// An in-flight ticket: key, title, the worker's model and executor, how long it has run, and its session.
function flightRow(t, p) {
  const r = linkTo(el('a', 'bl-compact-row'), ticketPath(t));
  const [ex] = executorOf(t);
  const since = t.spawn?.at || t.started;
  const model = el('span', 'bl-compact-model', t.spawn?.model || t.meta?.model || '');
  model.title = tr('Worker model');
  const exe = el('span', 'bl-compact-exec', ex); exe.title = t.claimed_by ? tr('Executor: {who}', { who: t.claimed_by }) : '';
  const ago = el('span', 'num bl-compact-since', since ? ctx.fmtRel(since) : '');
  ago.title = since ? `${tr('Started {when}', { when: ctx.fmtDateTime(since) })}${t.attempts > 1 ? ` · ${tr('attempt {n}', { n: t.attempts })}` : ''}` : '';
  const kk = el('span', 'num', t.key.slice(p.key.length + 1)); kk.title = t.key;
  r.append(stateIcon('in_progress'), kk, el('span', 'bl-compact-title', t.title), model, exe, ago);
  const ws = workerSession(t);
  if (ws) { const a = sessionLink(ws, ws.title || ws.id.slice(0, 8)); a.classList.add('bl-compact-sess'); r.append(a); }
  else r.append(el('span', 'bl-compact-sess none', tr('no session yet')));
  return r;
}
// Overview's list: open projects only, collapsed and read-only; the name goes to the project page.
function openProjects(projects, all) {
  const wrap = el('div', 'bl-lanes bl-open-projects');
  wrap.style.setProperty('--cols', '1');
  let n = 0;
  for (const p of projects) {
    const tks = all.filter(t => t.project === p.key);
    const open = tks.filter(t => !FINAL.has(t.state));
    if (tks.length && !open.length) continue;
    const name = linkTo(el('a', 'bl-lane-name'), projPath(p.key));
    name.append(el('span', 'bl-lane-key num', p.key), el('span', 'bl-lane-title', p.name));
    const nameRow = el('div', 'bl-lane-namerow'); nameRow.append(name);
    wrap.append(compactLane(p, tks, open, nameRow)); n++;
  }
  if (!n) wrap.append(el('div', 'prs-empty', tr('No open projects.')));
  return wrap;
}

// ---- project page ----
function renderProject(root, p) {
  const tks = bl.data.tickets.filter(t => t.project === p.key);
  const back = linkTo(el('a', 'bl-back'), '/projects');
  back.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>';
  back.append(tr('All projects'));
  root.append(back);
  const sub = [];
  if (p.repo) sub.push(el('span', 'num', p.repo.replace(/^\/Users\/[^/]+/, '~')));
  sub.push(el('span', null, tr('review {policy}', { policy: setting(p.key, 'review', 'ask') })), el('span', null, tr('parallel {n}', { n: setting(p.key, 'max_parallel', 3) })));
  if (p.doc_slug) {
    const base = bl.data.artiBase;
    if (base) { const a = el('a', null, tr('doc: {slug}', { slug: p.doc_slug })); a.href = `${base.replace(/\/$/, '')}/s/${encodeURIComponent(p.doc_slug)}`; a.target = '_blank'; a.rel = 'noopener'; sub.push(a); }
    else sub.push(el('span', null, tr('doc: {slug}', { slug: p.doc_slug })));
  }
  const subWrap = [factRow('', ...sub)];
  const right = headRight(runBadge(p));
  const hd = head(`${p.name}`, subWrap, right);
  const h1 = hd.querySelector('h1'); h1.textContent = '';
  h1.append(nameEditor(p), evergreenToggle(p));
  root.append(hd);
  const ctl = el('div', 'bl-proj-ctl'); ctl.append(projState(p), lifecycleButtons(p, false));
  root.append(ctl);
  const exl = execLine(p, false); if (exl) root.append(exl);
  root.append(instructionsBox(p));
  if (tks.some(t => t.state === 'in_progress')) root.append(el('h2', 'bl-h2', tr('In flight')), inFlight(tks));

  const stats = el('div', 'bl-stats');
  stats.append(progress(tks));
  for (const st of STATES) { const n = tks.filter(t => t.state === st).length; if (n) { const x = statePill(st); x.append(el('span', 'num', String(n))); stats.append(x); } }
  root.append(stats);
  if (p.usage) {
    const us = el('div', 'bl-usage-row');
    us.append(usageStat(tr('Total'), p.usage));
    if (p.sharedUsage) us.append(usageStat(tr('Orchestration and shared sessions'), p.sharedUsage));
    us.append(el('span', 'bl-usage-note', tr('Nominal list prices from transcripts; not billed on a subscription.')));
    root.append(us);
  }

  const nyp = needsYouPanel(tks); if (nyp) root.append(nyp);

  const rm = roadmap(p);
  if (rm) root.append(el('h2', 'bl-h2', tr('Roadmap')), rm);
  else if (ui.milestone) ui.milestone = null;
  // The graph collapses; the choice is remembered for every project.
  const gsec = el('details', 'bl-sec'); gsec.open = store.get('graphOpen', true);
  const gsum = el('summary'); gsum.append(el('h2', 'bl-h2', tr('Dependency graph')));
  gsec.append(gsum, graph(tks));
  gsec.addEventListener('toggle', () => store.set('graphOpen', gsec.open));
  root.append(gsec);
  const msOk = t => !ui.milestone || (ui.milestone === '-' ? !t.milestone && !t.meta?.showcase_for : t.milestone === ui.milestone);
  const th = el('h2', 'bl-h2', tr('Tickets'));
  if (ui.milestone) { const x = el('button', 'chip on', `${ui.milestone === '-' ? tr('No milestone') : ui.milestone} ×`); x.addEventListener('click', () => { ui.milestone = null; renderBacklog(); }); th.append(' ', x); }
  root.append(th, controls(), table(visibleTickets(tks).filter(t => matches(t) && msOk(t))));
}

function graph(tks, big = false) {
  const wrap = el('div', 'bl-graph' + (big ? ' big' : ''));
  const shown = tks.filter(t => t.state !== 'canceled' || ui.closed === 'all');
  if (!shown.length) { wrap.append(el('div', 'prs-empty', tr('No tickets.'))); return wrap; }
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
    n.title = `${t.key} · ${LABEL[t.state]}${isReady(t) ? ' · ' + tr('ready') : ''}\n${t.title}`;
    const top = el('div', 'bl-node-top'); top.append(stateIcon(t.state), el('span', 'num', t.project === tks[0].project ? t.key.slice(t.project.length + 1) : t.key));
    n.addEventListener('mouseenter', () => svg.querySelectorAll(`[data-from="${t.key}"], [data-to="${t.key}"]`).forEach(e => e.classList.add('hl')));
    n.addEventListener('mouseleave', () => svg.querySelectorAll('.hl').forEach(e => e.classList.remove('hl')));
    if (t.assignee === 'human') top.append(el('span', 'bl-node-tag', tr('human')));
    else if (isReady(t)) top.append(el('span', 'bl-node-tag ok', tr('ready')));
    n.append(top, el('div', 'bl-node-title', t.title));
    layer.append(n);
  }
  wrap.append(svg, layer);
  const scroller = el('div', 'bl-graph-scroll'); scroller.append(wrap);
  if (big) return scroller;
  const box = el('div', 'bl-graph-box');
  const ex = el('button', 'btn bl-graph-expand'); ex.type = 'button'; ex.title = tr('Open a larger view');
  ex.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';
  ex.append(el('span', null, tr('Expand')));
  ex.addEventListener('click', () => openGraphModal(tks));
  box.title = tr('Click anywhere to expand');
  box.addEventListener('click', e => { if (e.target.closest('.bl-node, .bl-graph-expand')) return; openGraphModal(tks); });
  box.append(ex, scroller);
  return box;
}

function openGraphModal(tks) {
  const m = el('div', 'bl-modal');
  const card = el('div', 'bl-modal-card');
  const head = el('div', 'bl-modal-head');
  head.append(el('b', null, tr('Dependency graph')), el('span', null, tr('Hover a ticket to highlight its edges; click to open it.')));
  const close = el('button', 'btn icon'); close.title = tr('Close (Esc)');
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
  ['key', tr('Key'), t => [t.project, t.id]],
  ['title', tr('Title'), t => t.title.toLowerCase()],
  ['state', tr('State'), t => STATES.indexOf(t.state)],
  ['deps', tr('Waits on'), t => (bl.blockers.get(t.key) || []).length],
  ['blocks', tr('Blocks'), t => (bl.dependents.get(t.key) || []).length],
  ['priority', tr('P'), t => t.priority],
  ['attempts', tr('Tries'), t => t.attempts],
  ['who', tr('Who'), t => t.claimed_by || t.assignee || ''],
  ['ms', tr('Milestone'), t => bl.milestones.get(t.milestone)?.seq ?? 1e9],
  ['prs', tr('PRs'), t => (t.prs || []).length],
  ['cost', tr('Cost'), t => t.usage?.cost ?? -1],
  ['updated', tr('Updated'), t => new Date(shownAt(t) || 0).getTime()],
];
const FIN_COLS = [
  ...COLS.filter(([id]) => ['key', 'title', 'state', 'who', 'ms', 'prs', 'cost'].includes(id)),
  ['finished', tr('Finished'), closedAt],
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
  bl.rowOrder = [];
  const openKey = parseBacklogPath(location.pathname)?.ticket || null;   // the route, not bl.ticketKey, which the drawer sets after the table renders
  const wrap = el('div', 'bl-table-wrap');
  const tbl = el('table', 'bl-table');
  const thead = el('thead'); const hr = el('tr');
  const has = {
    ms: tks.some(t => t.milestone) || (bl.data.milestones || []).some(m => tks[0] && m.project === tks[0].project),
    prs: tks.some(t => t.prs?.length),
    usage: tks.some(t => t.usage),
    who: tks.some(t => t.claimed_by || t.assignee),
  };
  // Finished mode: no graph columns; the last column is when the ticket finished; its own sort, newest first by default.
  const fin = finishedMode();
  if (fin) tbl.classList.add('bl-fin');
  const sort = fin ? ui.finSort : ui.sort;
  const cols = (fin ? FIN_COLS : COLS).filter(([id]) => !(id === 'ms' && !has.ms) && !(id === 'prs' && !has.prs) && !(id === 'cost' && !has.usage) && !(id === 'who' && !has.who));
  const on = id => cols.some(c => c[0] === id);
  for (const [id, label] of cols) {
    const th = el('th', `c-${id}`); const b = el('button', null, label);
    if (sort.col === id) { th.setAttribute('aria-sort', sort.dir > 0 ? 'ascending' : 'descending'); b.append(el('span', 'bl-sort', sort.dir > 0 ? '↑' : '↓')); }
    b.addEventListener('click', () => {
      const next = { col: id, dir: sort.col === id ? -sort.dir : (id === 'updated' || id === 'finished' ? -1 : 1) };
      if (fin) ui.finSort = next; else { ui.sort = next; store.set('blProjSort', ui.sort); }
      renderBacklog();
    });
    th.append(b); hr.append(th);
  }
  thead.append(hr); tbl.append(thead);
  const key = cols.find(c => c[0] === sort.col)?.[2] || cols[0][2];
  const rows = [...tks].sort((a, b) => sort.dir * cmp(key(a), key(b)) || bl.order.get(a.key) - bl.order.get(b.key));
  const tbody = el('tbody');
  const treeMode = !fin && sort.col === 'order' && sort.dir > 0;
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
    const r = el('tr', `bl-${t.state}${openKey === t.key ? ' sel' : ''}${needsYou(t) ? ' needs-you' : ''}`); r.dataset.key = t.key;
    r.addEventListener('click', e => { if (e.target.closest('a')) return; go(ticketPath(t)); });
    bl.rowOrder.push(t);
    const td = (cls, ...kids) => { const c = el('td', cls); c.append(...kids); r.append(c); return c; };
    if (on('order')) td('c-order num', String(bl.order.get(t.key) - Math.min(...tks.map(x => bl.order.get(x.key))) + 1));
    const kl = linkTo(el('a', null, fin ? t.key : t.key.slice(t.project.length + 1)), ticketPath(t)); kl.title = t.key;
    td('c-key num', kl);
    const ttl = el('div', 'bl-tt');
    // A blocked ticket has nothing to open yet: its title is plain text.
    // The title links only to a session that is the ticket's own (its worker, briefing or handoff), never an orchestrator's.
    const own = (t.sessions || []).find(s => s.own && !s.missing) || null;
    const ho = t.meta?.handoff?.session || t.meta?.brief?.session;
    const wsess = needsYou(t) && ho ? { ...(t.sessions || []).find(s => s.id === ho), id: ho } : own;
    if (wsess) {
      const a = el('a', 'bl-tt-text linked'); a.href = `/s/${wsess.id}`;
      a.title = `${tr('Open the session: {title}', { title: wsess.title || wsess.id })}${t.sessions.length > 1 ? tr(' ({n} sessions; all in the details)', { n: t.sessions.length }) : ''}`;
      a.append(t.title);
      const ic = el('span', 'bl-tt-sess'); ic.innerHTML = SESSION_ICON; a.append(ic);
      a.addEventListener('click', e => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); e.stopPropagation(); ctx.openSession(wsess.id); });
      ttl.append(a);
    } else ttl.append(el('span', 'bl-tt-text', t.title));
    if (t.labels?.length) for (const l of t.labels) ttl.append(el('span', 'bl-label', l));
    const rl = resultLine(t); if (rl) ttl.append(rl);
    if (t.usage) { const u = el('div', 'bl-tt-usage num'); u.append(factRow('', tr('{n} turns', { n: t.usage.turns }), tr('{n} tokens', { n: fmtTok(t.usage.tokens) }), fmtCost(t.usage))); u.title = usageTitle(t.usage); ttl.append(u); }
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
    td('c-state', statePill(t.state), ...(needsYou(t) ? [el('span', 'bl-needs-tag', tr('Needs you'))] : isReady(t) ? [el('span', 'bl-ready', tr('ready'))] : isBlocked(t) ? [el('span', 'bl-blocked', tr('blocked'))] : []));
    if (on('deps')) td('c-deps', ...(bl.blockers.get(t.key) || []).map(k => depChip(k, t.project)));
    if (on('blocks')) td('c-blocks', ...(bl.dependents.get(t.key) || []).map(k => depChip(k, t.project)));
    if (on('priority')) td(`c-priority num p${t.priority}`, String(t.priority));
    if (on('attempts')) td('c-attempts num', t.attempts ? `${t.attempts}${t.max_attempts ? '/' + t.max_attempts : ''}` : '');
    if (on('who')) td('c-who', el('span', 'bl-who', t.claimed_by ? executorOf(t)[0] : (t.assignee || '')));
    const ms = bl.milestones.get(t.milestone);
    if (on('ms')) { td('c-ms', ...(ms ? [el('span', `bl-ms-chip ms-${ms.status}`, ms.key.slice(t.project.length + 1))] : [])); if (ms) r.lastChild.title = ms.title; }
    if (on('prs')) td('c-prs', ...prChips(t, 3));
    if (on('cost')) td('c-cost num', fmtCost(t.usage)).title = usageTitle(t.usage);
    if (fin) { const at = t.finished || t.updated; td('c-updated c-finished', fmtAgo(at)).title = tr('Finished {when}', { when: ctx.fmtDateTime(at) }); }
    else {
      const at = shownAt(t);
      td('c-updated', fmtAgo(at)).title = at ? (ENDED.has(t.state) && t.finished ? tr('Finished {when}', { when: ctx.fmtDateTime(at) }) : t.changed ? tr('State changed {when}', { when: ctx.fmtDateTime(at) }) : tr('Updated {when}', { when: ctx.fmtDateTime(at) })) : '';
    }
    tbody.append(r);
  }
  if (!rows.length) { const r = el('tr'); const c = el('td', 'prs-empty', fin ? (ui.q.trim() ? tr('No ticket finished in the last 7 days matches that search.') : tr('Nothing finished (done, canceled or failed) in the last 7 days.')) : ui.q ? tr('No tickets match that search.') : ui.closed === 'none' ? tr('No open tickets. Switch to + 24h or All to see finished ones.') : tr('Nothing open or closed in the last 24 hours. Switch to All, or search.')); c.colSpan = cols.length; r.append(c); tbody.append(r); }
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
    box.append(el('div', 'prs-empty', tr('Loading…')));
  } else drawDrawer(box, bl.ticket);
  try {
    const r = await fetch(`/api/backlog/ticket/${encodeURIComponent(key)}`);
    if (!r.ok) throw new Error(r.status === 404 ? tr('No ticket {key}', { key }) : `HTTP ${r.status}`);
    const t = await r.json();
    if (bl.ticketKey !== key) return;
    bl.ticket = t;
    drawDrawer(box, t);
  } catch (e) { if (bl.ticketKey === key) { box.textContent = ''; box.append(closeBtn(), el('div', 'board-status', e.message)); } }
}

function closeBtn() {
  const b = el('button', 'btn icon bl-close'); b.title = tr('Close (Esc)'); b.setAttribute('aria-label', tr('Close'));
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
  const prio = PRIO[t.priority] ?? String(t.priority);
  row(tr('Priority'), `${prio} (${t.priority})`);
  if (t.state === 'todo') row(tr('Status'), isBlocked(bl.byKey.get(t.key) || t) ? tr('Blocked by open tickets') : t.assignee === 'human' ? tr('Ready, waiting on you') : tr('Ready to run'));
  row(tr('Assignee'), t.assignee === 'human' ? tr('human') : t.assignee || null);
  row(tr('Claimed by'), t.claimed_by || null);
  if (t.lease_until && t.state === 'in_progress') row(tr('Lease until'), ctx.fmtDateTime(t.lease_until));
  row(tr('Attempts'), t.attempts ? (t.max_attempts ? tr('{n} of {max}', { n: t.attempts, max: t.max_attempts }) : String(t.attempts)) : null);
  row(tr('Labels'), t.labels?.length ? t.labels.join(', ') : null);
  row(tr('Locks'), t.locks?.length ? t.locks.join(', ') : null);
  const meta = { ...t.meta }; for (const k of ['sessions', 'brief', 'handoff', 'showcase_for']) delete meta[k];
  if (meta.review) { row(tr('Review'), meta.review); delete meta.review; }
  if (meta.size) { row(tr('Size'), meta.size); delete meta.size; }
  for (const [k, v] of Object.entries(meta)) row(k, typeof v === 'string' ? v : JSON.stringify(v));
  if (t.doc_slug) {
    const base = bl.data?.artiBase;
    if (base) { const a = el('a', null, t.doc_slug); a.href = `${base.replace(/\/$/, '')}/s/${encodeURIComponent(t.doc_slug)}`; a.target = '_blank'; a.rel = 'noopener'; row(tr('Design doc'), a); }
    else row(tr('Design doc'), t.doc_slug);
  }
  const tu = bl.byKey.get(t.key)?.usage;
  if (tu) { const x = factRow('', fmtCost(tu), tr('{n} turns', { n: tu.turns }), tr('{n} tokens', { n: fmtTok(tu.tokens) })); x.title = usageTitle(tu); row(tr('Usage'), x); }
  row(tr('Created'), ctx.fmtDateTime(t.created));
  if (t.started) row(tr('Started'), ctx.fmtDateTime(t.started));
  if (t.finished) row(tr('Finished'), ctx.fmtDateTime(t.finished));
  box.append(dl);

  if (t.blockers.length || t.dependents.length) {
    const deps = el('div', 'bl-d-deps');
    if (t.blockers.length) { const r = el('div'); r.append(el('span', 'bl-d-lbl', tr('Waits on')), ...t.blockers.map(b => depChip(b.key))); deps.append(r); }
    if (t.dependents.length) { const r = el('div'); r.append(el('span', 'bl-d-lbl', tr('Blocks')), ...t.dependents.map(b => depChip(b.key))); deps.append(r); }
    box.append(deps);
  }

  if (t.prs?.length) {
    box.append(el('h4', 'bl-d-h', tr('Pull requests')));
    const list = el('div', 'bl-d-prs');
    for (const pr of t.prs) {
      const gh = ctx.getPr ? ctx.getPr(pr.url) : null;
      const a = el('a', `bl-d-pr st-${gh?.state || 'UNKNOWN'}`); a.href = pr.url; a.target = '_blank'; a.rel = 'noopener';
      a.append(el('span', 'num', `${(pr.repo || '').split('/').pop()} #${pr.number}`), el('span', 'bl-d-pr-title', gh?.title || ''), el('span', 'bl-d-pr-state', gh?.state ? PR_STATE[gh.state] || gh.state.toLowerCase() : ''));
      list.append(a);
    }
    box.append(list);
  }
  if (t.sessions.length) {
    box.append(el('h4', 'bl-d-h', tr('Sessions')));
    const list = el('div', 'bl-d-sessions');
    for (const s of t.sessions) {
      const a = el('a', 'bl-d-sess');
      a.href = `/s/${s.id}`;
      a.addEventListener('click', e => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); ctx.openSession(s.id); });
      a.innerHTML = SESSION_ICON;
      a.append(el('span', 'bl-d-sess-title', s.title || (s.missing ? tr('Transcript not found') : s.id.slice(0, 8))), factRow('bl-d-sess-meta', ROLE[s.role] || s.role, s.lastTime ? ctx.fmtRelAgo(s.lastTime) : ''));
      list.append(a);
    }
    box.append(list);
  }

  if (t.result) {
    const failed = t.result.startsWith('FAILED');
    const rb = el('section', `bl-d-result${failed ? ' failed' : ''}`);
    rb.append(el('h4', 'bl-d-h', failed ? tr('Last failure') : tr('Result')), md(t.result));
    box.append(rb);
  }
  box.append(el('h4', 'bl-d-h', tr('Spec')));
  box.append(t.body ? md(t.body) : el('p', 'bl-d-empty', tr('No body. The title is the spec.')));

  if (t.events.length) {
    box.append(el('h4', 'bl-d-h', tr('Activity')));
    const ev = el('ol', 'bl-d-events');
    for (const e of [...t.events].reverse()) {
      const li = el('li', `ev-${e.kind}`);
      const head = el('div', 'bl-ev-head');
      const when = el('span', 'num', ctx.fmtRelAgo(e.at)); when.title = ctx.fmtDateTime(e.at);
      head.append(el('b', null, EVENT[e.kind] || e.kind), el('span', null, e.actor || ''), when);
      if (e.session_id) head.append(sessionLink({ id: e.session_id, title: tr('Open the session that wrote this') }));
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
  // With a ticket open, Left / Right step through the tickets in the table's order.
  document.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.defaultPrevented) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable="true"]') || document.querySelector('.modal:not([hidden])')) return;
    const d = $('#bl-drawer'); const order = bl.rowOrder || [];
    if (!d || d.hidden || !bl.ticketKey || $('#backlog')?.hidden) return;
    const i = order.findIndex(t => t.key === bl.ticketKey);
    const next = order[i < 0 ? 0 : i + (e.key === 'ArrowRight' ? 1 : -1)];
    if (!next) return;
    e.preventDefault();
    go(ticketPath(next));
    document.querySelector(`.bl-table tr[data-key="${CSS.escape(next.key)}"]`)?.scrollIntoView({ block: 'nearest' });
  });
  document.addEventListener('click', e => {
    const d = $('#bl-drawer');
    if (!d || d.hidden || !e.isTrusted) return;
    if (e.target.closest('#bl-drawer, .bl-card, .bl-node, .bl-table tbody tr, .bl-chip, .bl-flight-row, .toast, .modal, a[href^="/projects/"]')) return;
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
  if (['failed', 'canceled', 'done'].includes(t.state)) box.append(actBtn(tr('Reopen'), 'ticket-reopen', t.key, null, { primary: t.state === 'failed', title: tr('Back to todo with attempts reset') }));
  if (t.assignee === 'human' && !FINAL.has(t.state)) box.append(actBtn(tr('Mark done'), 'ticket-resolve', t.key, null, { primary: true, title: tr('Close this human ticket as done (bl resolve)') }));
  if (t.state === 'in_review') box.append(actBtn(tr('Approve'), 'ticket-approve', t.key, null, { primary: true, title: tr('Mark done (after the PR is merged)') }));
  if (t.state === 'backlog') box.append(actBtn(tr('Move to todo'), 'ticket-move', t.key, 'todo', { primary: true }));
  if (t.state === 'todo') box.append(actBtn(tr('Move to backlog'), 'ticket-move', t.key, 'backlog'));
  if (!['done', 'canceled'].includes(t.state)) box.append(actBtn(tr('Cancel'), 'ticket-cancel', t.key, null, { confirm: true, title: tr('Cancel: dependents become unblocked') }));
  const sel = (label, action, options, cur) => {
    const wrap = el('label', 'bl-sel'); wrap.append(el('span', null, label));
    const s = el('select');
    for (const [v, txt] of options) { const o = el('option', null, txt); o.value = v; if (String(v) === String(cur)) o.selected = true; s.append(o); }
    s.addEventListener('change', () => act(action, t.key, s.value));
    wrap.append(s); return wrap;
  };
  box.append(sel(tr('Priority'), 'ticket-priority', PRIO.map((x, i) => [i, x]), t.priority));
  box.append(sel(tr('Model'), 'ticket-model', [['', tr('Default (opus)')], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']], t.meta?.model || ''));
  box.append(sel(tr('Assignee'), 'ticket-assignee', [['', tr('Agents')], ['human', tr('Human')]], t.assignee === 'human' ? 'human' : ''));
  const pms = (bl.data?.milestones || []).filter(m => m.project === t.project && m.status !== 'canceled');
  if (pms.length && !t.meta?.showcase_for) box.append(sel(tr('Milestone'), 'ticket-milestone', [['', tr('None')], ...pms.map(m => [m.key, `${m.key.slice(t.project.length + 1)} ${m.title}`])], t.milestone || ''));
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
  head.append(el('b', null, tr('Handoff')), el('span', `bl-ho-phase ph-${h.phase}`, PHASE[h.phase] || h.phase || ''));
  if (h.ready_at) { const w = el('span', 'bl-ho-when', tr('ready {ago}', { ago: ctx.fmtRelAgo(h.ready_at) })); w.title = ctx.fmtDateTime(h.ready_at); head.append(w); }
  box.append(head);
  if (!h.packet) { box.append(el('p', 'bl-d-empty', tr('The AI is compiling what was done, how to see it and what to test. You will be notified.'))); return box; }
  const pk = h.packet;
  box.append(el('p', 'bl-ho-summary', pk.summary));
  if (pk.see) {
    const see = el('div', 'bl-ho-see');
    if (pk.see.url) { const a = el('a', 'btn primary', tr('Open the preview')); a.href = pk.see.url; a.target = '_blank'; a.rel = 'noopener'; see.append(a, el('code', null, pk.see.url)); }
    if (pk.see.how) see.append(el('div', 'bl-ho-how', pk.see.how));
    box.append(see);
  }
  if (pk.links?.length) {
    const l = el('div', 'bl-ho-links');
    for (const x0 of pk.links) { const x = typeof x0 === 'string' ? { url: (x0.match(/https?:\/\/[^\s)]+/) || [])[0], label: x0 } : x0; if (!x.url) continue; const a = el('a', null, x.label || x.url); a.href = x.url; a.target = '_blank'; a.rel = 'noopener'; l.append(a); }
    box.append(l);
  }
  if (pk.body) box.append(Object.assign(md(pk.body), { className: 'md bl-ho-body' }));
  if (pk.checklist?.length) box.append(el('h4', 'bl-d-h', pk.checklist_title || tr('Checklist')), tickList(`handoff.${t.key}.check`, pk.checklist.map(x => typeof x === 'string' ? { item: x } : x), x => [el('span', 'bl-ho-step', x.item), x.detail ? el('span', 'bl-ho-detail', x.detail) : null]));
  if (pk.done?.length) {
    box.append(el('h4', 'bl-d-h', tr("What's done and new")));
    const ol = el('ol', 'bl-ho-done');
    for (const d0 of pk.done) { const d = typeof d0 === 'string' ? { title: d0 } : d0; const li = el('li'); li.append(el('b', null, d.title)); if (d.ref) li.append(' ', el('span', 'num', d.ref)); if (d.what) li.append(el('div', null, d.what)); ol.append(li); }
    box.append(ol);
  }
  if (pk.tests?.length) {
    const key = `handoff.${t.key}`;
    const ticked = store.get(key, []);
    box.append(el('h4', 'bl-d-h', tr('What to test')));
    const ul = el('ul', 'bl-ho-tests');
    pk.tests.forEach((x0, i) => {
      const x = typeof x0 === 'string' ? { step: x0 } : x0;
      const li = el('li');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = ticked.includes(i); cb.id = `ho-${t.key}-${i}`;
      cb.addEventListener('change', () => { const now = store.get(key, []).filter(v => v !== i); if (cb.checked) now.push(i); store.set(key, now); li.classList.toggle('ticked', cb.checked); });
      const lab = el('label'); lab.htmlFor = cb.id; lab.append(el('span', 'bl-ho-step', x.step));
      if (x.good) lab.append(el('span', 'bl-ho-good', tr('Good: {text}', { text: x.good })));
      if (x.bad) lab.append(el('span', 'bl-ho-bad', tr('Bad: {text}', { text: x.bad })));
      li.append(cb, lab); if (cb.checked) li.classList.add('ticked');
      ul.append(li);
    });
    box.append(ul);
  }
  if (pk.gaps?.length) {
    box.append(el('h4', 'bl-d-h', tr('Known gaps')));
    const ul = el('ul', 'bl-ho-gaps'); for (const g of pk.gaps) ul.append(el('li', null, g)); box.append(ul);
  }
  if (pk.questions?.length) {
    box.append(el('h4', 'bl-d-h', tr('Asked of you')));
    const ol = el('ol', 'bl-ho-questions'); for (const q of pk.questions) ol.append(el('li', null, q)); box.append(ol);
  }
  const asks = (pk.asks || []).map(a => typeof a === 'string' ? { q: a } : a);
  const sess = answerSession(bl.byKey.get(t.key) || t);
  if (asks.length && !(sess && t.state !== 'done')) {
    box.append(el('h4', 'bl-d-h', tr('Asked of you')));
    const ol = el('ol', 'bl-ho-questions'); for (const a of asks) ol.append(el('li', null, a.q)); box.append(ol);
  }
  if (sess && t.state !== 'done') {
    const form = el('form', 'bl-ho-reply');
    const answers = asks.map(() => ({ v: '' }));
    if (asks.length) {
      form.append(el('h4', 'bl-d-h', tr('Asked of you')));
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
          const inp = el('input', 'bl-ask-text'); inp.type = 'text'; inp.placeholder = tr('Your answer');
          inp.addEventListener('input', () => { answers[i].v = inp.value.trim(); });
          inp.addEventListener('keydown', e => e.stopPropagation());
          f.append(inp);
        }
        form.append(f);
      });
    }
    const ta = el('textarea'); ta.rows = 4; ta.placeholder = asks.length ? tr('Anything else, in your own words (optional when the choices above say it all).') : tr('Your feedback, answers or "go". It goes to the handoff session, which files fixes and closes the ticket.');
    const row = el('div', 'bl-ho-reply-row');
    const send = el('button', 'btn primary', tr('Send to the session')); send.type = 'submit';
    const term = el('button', 'btn', tr('Answer in terminal')); term.type = 'button';
    term.addEventListener('click', () => openInTerminal(sess.id));
    row.append(sessionLink(sess, sess.title || tr('Session')), term, send);
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
        ctx.toast(j.action === 'typed' ? tr('Typed into the live session') : tr('Resumed the session in your terminal with your message'));
        act('ticket-handoff', t.key, 'discussing');
      } catch (err) { ctx.toast(tr('Not sent: {error}', { error: err.message })); }
      send.disabled = false;
    });
    box.append(form);
  }
  return box;
}
