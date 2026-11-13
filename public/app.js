import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
import { initBacklog, renderBacklog, parseBacklogPath, startBacklogPolling, stopBacklogPolling, closeDrawer } from '/backlog.js';

marked.setOptions({ gfm: true, breaks: false });

const $ = s => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const store = {
  get(k, d) { try { const v = localStorage.getItem('chito.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('chito.' + k, JSON.stringify(v)); } catch { } },
};

const state = {
  sessions: [],
  filtered: [],
  cursor: -1,
  activeId: null,
  active: null, // { meta, items }
  showAgents: store.get('showAgents', false),
  toolMode: ['none', 'count', 'full'].includes(store.get('toolMode')) ? store.get('toolMode') : 'none',
  workMode: store.get('workMode', 'hide') === 'show' ? 'show' : 'hide',
  infoOpen: false,
  infoTab: 'general',
  renderToken: 0,
  pins: (store.get('pins', []) || []).filter(x => typeof x === 'string'),
  showOlder: false,
};
const RECENT_MS = 48 * 3600e3;
const isRecent = s => s.lastTime && Date.now() - new Date(s.lastTime).getTime() < RECENT_MS;

// ---------- formatting ----------
const pad = n => String(n).padStart(2, '0');
function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}
function fmtShort(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })}, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}
function fmtTime(iso) { return iso ? new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : ''; }
function fmtRel(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d`;
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: '2-digit' } : {}) });
}
function fmtDur(a, b) {
  const s = Math.max(0, Math.round((new Date(b) - new Date(a)) / 1000));
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) { const m = Math.floor(s / 60), r = s % 60; return r ? `${m}m ${r}s` : `${m}m`; }
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.round((s % 86400) / 3600)}h`;
}
const fmtNum = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
const fmtBytes = n => n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB';
const tildify = p => p ? p.replace(/^\/Users\/[^/]+/, '~') : '';

function md(text) {
  const div = el('div', 'md');
  div.innerHTML = DOMPurify.sanitize(marked.parse(text || ''));
  div.querySelectorAll('a[href^="http"]').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
  return div;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 1800);
}

async function copy(text, label) {
  try { await navigator.clipboard.writeText(text); toast(`Copied ${label}`); }
  catch { toast('Copy failed'); }
}

// ---------- list ----------
async function loadList() {
  try {
    const r = await fetch('/api/sessions');
    const j = await r.json();
    state.sessions = j.sessions;
    state.terminal = j.terminal;
    const listEl = $('#list');
    const top = listEl.scrollTop;
    if (state.activeId && state.active) { const cur = j.sessions.find(x => x.id === state.activeId); if (cur) markRead(cur.id, cur.lastTime); }
    applyFilter(false, false);
    listEl.scrollTop = top;
    renderLanding();
  } catch (e) { console.error(e); }
}

function parseQuery(q) {
  const terms = [];
  let proj = null;
  for (const tok of q.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    if (tok.startsWith('p:') && tok.length > 2) proj = tok.slice(2);
    else terms.push(tok);
  }
  return { terms, proj };
}

function applyFilter(resetCursor = true, follow = true) {
  const q = $('#q').value;
  const { terms, proj } = parseQuery(q);
  let list = state.sessions.filter(s => state.showAgents || !s.agent || s.id === state.activeId);
  if (proj) list = list.filter(s => (s.project || '').toLowerCase().includes(proj));
  if (terms.length) {
    const scored = [];
    for (const s of list) {
      const title = (s.title || '').toLowerCase();
      const project = (s.project || '').toLowerCase();
      const prompt = (s.firstPrompt || '').toLowerCase();
      let score = 0;
      let ok = true;
      for (const t of terms) {
        if (title.includes(t)) score += title.startsWith(t) ? 12 : 10;
        else if (project.includes(t)) score += 4;
        else if (prompt.includes(t) || s.id.startsWith(t)) score += 1;
        else { ok = false; break; }
      }
      if (ok) scored.push([score, s]);
    }
    scored.sort((a, b) => b[0] - a[0] || (b[1].lastTime || '').localeCompare(a[1].lastTime || ''));
    list = scored.map(x => x[1]);
  }
  if (!terms.length && !proj) {
    const byId = new Map(list.map(s => [s.id, s]));
    const pinned = state.pins.map(id => byId.get(id)).filter(Boolean);
    const pinSet = new Set(pinned.map(s => s.id));
    const rest = list.filter(s => !pinSet.has(s.id));
    const recent = rest.filter(s => isRecent(s) || s.id === state.activeId);
    const older = rest.filter(s => !isRecent(s) && s.id !== state.activeId);
    state.pinnedCount = pinned.length;
    state.olderCount = older.length;
    list = [...pinned, ...recent, ...(state.showOlder ? older : [])];
  } else { state.pinnedCount = 0; state.olderCount = 0; }
  state.filtered = list;
  if (resetCursor) state.cursor = list.length ? 0 : -1;
  else {
    const i = list.findIndex(s => s.id === (state.cursorId || state.activeId));
    state.cursor = i >= 0 ? i : Math.min(state.cursor, list.length - 1);
  }
  renderList(terms.length > 0, follow);
}

function groupLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return 'Previous 7 days';
  if (diff < 30) return 'Previous 30 days';
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function highlight(text, terms) {
  const frag = document.createDocumentFragment();
  if (!terms.length) { frag.append(text); return frag; }
  const lower = text.toLowerCase();
  const marks = [];
  for (const t of terms) {
    let i = lower.indexOf(t);
    while (i >= 0) { marks.push([i, i + t.length]); i = lower.indexOf(t, i + t.length); }
  }
  marks.sort((a, b) => a[0] - b[0]);
  let pos = 0;
  for (const [a, b] of marks) {
    if (a < pos) continue;
    frag.append(text.slice(pos, a));
    frag.append(el('mark', null, text.slice(a, b)));
    pos = b;
  }
  frag.append(text.slice(pos));
  return frag;
}

// ---------- pins ----------
function setPins(pins, msg) {
  state.pins = [...new Set(pins)];
  store.set('pins', state.pins);
  applyFilter(false, false);
  if (state.active) updatePinButton();
  if (msg) toast(msg);
}
function togglePin(id = state.activeId) {
  if (!id) return;
  const on = state.pins.includes(id);
  setPins(on ? state.pins.filter(x => x !== id) : [id, ...state.pins], on ? 'Unpinned' : 'Pinned to top');
}
function updatePinButton() {
  const b = $('#b-pin'); if (!b) return;
  const on = state.pins.includes(state.activeId);
  b.classList.toggle('on', on);
  b.title = on ? 'Unpin from the top of the list (f)' : 'Pin to the top of the list (f)';
  b.setAttribute('aria-pressed', String(on));
}
function pinZone() {
  const z = el('div', 'pin-zone' + (state.pinnedCount ? '' : ' empty'));
  const h = el('div', 'group pin-head');
  h.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l-1 6 3 3v2H7v-2l3-3z"/><path d="M12 15v5"/></svg>';
  h.append(el('span', null, 'Pinned'));
  z.append(h, el('div', 'pin-items'), el('div', 'pin-hint', 'Drag a session here to pin it'));
  z.addEventListener('dragover', e => { if (!e.dataTransfer.types.includes('text/x-chito-session')) return; e.preventDefault(); z.classList.add('over'); });
  z.addEventListener('dragleave', e => { if (!z.contains(e.relatedTarget)) z.classList.remove('over'); });
  z.addEventListener('drop', e => {
    e.preventDefault(); z.classList.remove('over');
    const id = e.dataTransfer.getData('text/x-chito-session');
    if (id && !state.pins.includes(id)) setPins([...state.pins, id], 'Pinned to top');
  });
  return z;
}
function olderDivider() {
  const d = el('button', 'older-divider');
  d.type = 'button';
  d.append(el('span', null, state.showOlder ? 'Older than 48 hours' : `${state.olderCount} older session${state.olderCount === 1 ? '' : 's'}`));
  if (!state.showOlder) d.append(el('span', 'older-hint', 'scroll or click to show'));
  d.addEventListener('click', () => { state.showOlder = !state.showOlder; applyFilter(false, false); });
  return d;
}
// Dropping a pinned session anywhere else in the list unpins it.
$('#list').addEventListener('dragover', e => { if (e.dataTransfer.types.includes('text/x-chito-session') && !e.target.closest('.pin-zone')) e.preventDefault(); });
$('#list').addEventListener('drop', e => {
  if (e.target.closest('.pin-zone')) return;
  const id = e.dataTransfer.getData('text/x-chito-session');
  if (id && state.pins.includes(id)) { e.preventDefault(); setPins(state.pins.filter(x => x !== id), 'Unpinned'); }
});
// Scrolling to the bottom reveals sessions older than 48 hours.
$('#list').addEventListener('scroll', () => {
  const l = $('#list');
  if (!state.showOlder && state.olderCount && l.scrollTop + l.clientHeight > l.scrollHeight - 40) { state.showOlder = true; applyFilter(false, false); }
}, { passive: true });

function renderList(searching, follow = true) {
  const list = $('#list');
  const { terms } = parseQuery($('#q').value);
  list.textContent = '';
  const shown = state.sessions.filter(s => state.showAgents || !s.agent).length;
  $('#count').textContent = searching ? `${state.filtered.length} / ${shown}` : `${shown}`;
  if (!searching) list.append(pinZone());
  if (!state.filtered.length && !state.olderCount) { list.append(el('div', 'list-empty', 'No sessions match.')); return; }
  let lastGroup = null;
  let olderShown = false;
  state.filtered.forEach((s, i) => {
    const pinned = !searching && i < state.pinnedCount;
    if (pinned) { /* rendered into the pin zone below */ }
    else if (!searching) {
      if (!olderShown && !isRecent(s) && s.id !== state.activeId) { list.append(olderDivider()); olderShown = true; lastGroup = null; }
      const g = groupLabel(s.lastTime);
      if (g !== lastGroup) { list.append(el('div', 'group', g)); lastGroup = g; }
    }
    const a = el('a', 'item' + (pinned ? ' pinned' : ''));
    a.draggable = !searching;
    a.addEventListener('dragstart', e => { e.dataTransfer.setData('text/x-chito-session', s.id); e.dataTransfer.effectAllowed = 'move'; document.body.classList.add('dragging-session'); });
    a.addEventListener('dragend', () => document.body.classList.remove('dragging-session'));
    a.href = `/s/${s.id}`;
    a.dataset.idx = i;
    if (s.id === state.activeId) a.classList.add('active');
    else if (isUnread(s)) a.classList.add('unread');
    if (i === state.cursor) a.classList.add('cursor');
    const t = el('div', 'item-title');
    if (s.live) {
      const dot = el('span', 'live-dot' + (s.live.status === 'busy' ? ' busy' : ''));
      dot.title = `Running now (${s.live.status || 'live'}, pid ${s.live.pid})`;
      t.append(dot);
    }
    t.append(highlight(s.title, terms));
    t.title = s.title;
    const m = el('div', 'item-meta');
    m.append(el('span', 'proj', s.project));
    if (s.gitBranch && !['main', 'master', 'HEAD'].includes(s.gitBranch)) m.append(el('span', 'branch', s.gitBranch));
    if (s.prCount) {
      const badge = el('button', 'badge', s.prCount > 1 ? `${s.prCount} PRs` : 'PR');
      badge.type = 'button';
      badge.title = 'Show pull requests from this session';
      badge.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        state.cursor = i;
        state.infoTab = 'artifacts';
        if (s.id === state.activeId) toggleInfo(true);
        else { state.openInfoAfterLoad = true; openSession(s.id); }
      });
      m.append(badge);
    }
    const turns = el('span', 'num turns', String(s.userTurns));
    turns.title = `${s.userTurns} prompts`;
    const when = el('span', 'num when', fmtRel(s.lastTime));
    when.title = `Last turn ${fmtDateTime(s.lastTime)}`;
    m.append(turns, when);
    a.append(t, m);
    a.addEventListener('click', e => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      state.cursor = i;
      openSession(s.id);
    });
    if (pinned) {
      a.addEventListener('dragover', e => { if (!e.dataTransfer.types.includes('text/x-chito-session')) return; e.preventDefault(); const r = a.getBoundingClientRect(); a.classList.toggle('drop-before', e.clientY < r.top + r.height / 2); a.classList.toggle('drop-after', e.clientY >= r.top + r.height / 2); });
      a.addEventListener('dragleave', () => a.classList.remove('drop-before', 'drop-after'));
      a.addEventListener('drop', e => {
        e.preventDefault(); e.stopPropagation();
        const before = a.classList.contains('drop-before'); a.classList.remove('drop-before', 'drop-after');
        const id = e.dataTransfer.getData('text/x-chito-session'); if (!id || id === s.id) return;
        const pins = state.pins.filter(x => x !== id);
        const at = pins.indexOf(s.id); pins.splice(before ? at : at + 1, 0, id);
        setPins(pins);
      });
      list.querySelector('.pin-zone .pin-items').append(a);
    } else list.append(a);
  });
  if (!searching && state.olderCount && !olderShown) list.append(olderDivider());
  if (follow) scrollCursorIntoView();
}


// Scroll only the given container (native scrollIntoView also scrolls ancestors).
function scrollWithin(container, node, mode = 'start') {
  const c = container.getBoundingClientRect();
  const r = node.getBoundingClientRect();
  if (mode === 'start') container.scrollTop += r.top - c.top - 16;
  else if (r.top < c.top) container.scrollTop += r.top - c.top - 8;
  else if (r.bottom > c.bottom) container.scrollTop += r.bottom - c.bottom + 8;
}

function scrollCursorIntoView() {
  const c = $('#list .item.cursor');
  if (c) scrollWithin($('#list'), c, 'nearest');
}

function moveCursor(delta) {
  if (delta > 0 && !state.showOlder && state.olderCount && state.cursor >= state.filtered.length - 1 && !parseQuery($('#q').value).terms.length) { state.showOlder = true; applyFilter(false, false); }
  if (!state.filtered.length) return;
  state.cursor = Math.max(0, Math.min(state.filtered.length - 1, state.cursor + delta));
  state.cursorId = state.filtered[state.cursor].id;
  document.querySelectorAll('#list .item').forEach(n => n.classList.toggle('cursor', Number(n.dataset.idx) === state.cursor));
  scrollCursorIntoView();
}

// ---------- session ----------
async function openSession(id, { push = true, hash = '' } = {}) {
  if (push) history.pushState({}, '', `/s/${id}${hash}`);
  if (state.view !== 'sessions') setView('sessions');
  state.activeId = id;
  state.cursorId = id;
  document.querySelectorAll('#list .item').forEach(n => n.classList.toggle('active', state.filtered[n.dataset.idx]?.id === id));
  const thread = $('#thread');
  document.body.classList.add('has-session');
  const token = ++state.renderToken;
  const listMeta = state.sessions.find(s => s.id === id);
  setHeader(listMeta);
  thread.textContent = '';
  thread.append(el('div', 'loading', 'Loading…'));
  let data;
  try {
    const r = await fetch(`/api/sessions/${id}`);
    if (!r.ok) throw new Error((await r.json()).error || r.statusText);
    data = await r.json();
  } catch (e) {
    if (token !== state.renderToken) return;
    thread.textContent = '';
    thread.append(el('div', 'loading', `Could not load session: ${e.message}`));
    return;
  }
  if (token !== state.renderToken) return;
  state.active = data;
  markRead(id, data.meta.lastTime);
  document.title = `${data.meta.title} · chito`;
  if (document.activeElement?.closest?.('#list') || document.activeElement === document.body) $('#convo').focus({ preventScroll: true });
  setHeader(data.meta);
  if (state.openInfoAfterLoad) { state.openInfoAfterLoad = false; toggleInfo(true); }
  else if (state.infoOpen) renderInfo();
  renderThread(data.items, token, (location.hash || '').slice(1), { land: landingTarget(data.items) });
}

function setHeader(meta) {
  $('#actions').hidden = !meta;
  $('#composer').hidden = !meta;
  if (meta) updateComposerHint();
  if (!meta) { $('#title').textContent = 'Select a session'; $('#subtitle').textContent = ''; return; }
  $('#title').textContent = meta.title;
  $('#title').title = meta.title;
  const sub = $('#subtitle');
  sub.textContent = '';
  sub.append(el('span', 'path', tildify(meta.cwd) || meta.project));
  if (meta.gitBranch && meta.gitBranch !== 'HEAD') sub.append(el('span', 'branch', meta.gitBranch));
  const span = el('span', 'span');
  span.append(el('span', 'num', fmtShort(meta.startTime)), ' to ', el('span', 'num', fmtRel(meta.lastTime) === 'now' ? 'now' : fmtShort(meta.lastTime)));
  span.title = `${fmtDateTime(meta.startTime)} to ${fmtDateTime(meta.lastTime)}`;
  sub.append(span);
  const n = el('span', 'count');
  n.append(el('span', 'num', String(meta.userTurns)), ' prompts');
  sub.append(n);
  updateToolsButton();
  updatePinButton();
  const live = meta.live ?? state.sessions.find(s => s.id === meta.id)?.live;
  $('#b-open span').textContent = live ? 'Focus terminal' : 'Open in terminal';
  $('#b-open').title = live ? `Running now (pid ${live.pid}): focus its terminal (o)` : 'Reopen in terminal (o)';
}

function toolArg(name, input) {
  if (!input || typeof input !== 'object') return '';
  if (input._truncated) return '(large input)';
  const pick = input.command ?? input.file_path ?? input.notebook_path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt ?? input.skill ?? input.path;
  if (typeof pick === 'string') return tildify(pick).replace(/\s+/g, ' ').slice(0, 200);
  const first = Object.values(input).find(v => typeof v === 'string');
  return first ? first.replace(/\s+/g, ' ').slice(0, 200) : '';
}

function toolInputText(input) {
  if (input && input._truncated) return input._truncated;
  if (input && typeof input.command === 'string' && Object.keys(input).every(k => ['command', 'description', 'timeout', 'run_in_background'].includes(k))) {
    return input.command + (input.description ? `\n\n# ${input.description}` : '');
  }
  return JSON.stringify(input, null, 2);
}

function renderTool(b) {
  const d = el('details', 'tool');
  const s = el('summary');
  s.append(el('span', 'tname', b.name), el('span', 'targ', toolArg(b.name, b.input)));
  if (b.isError) { s.append(el('span', 'terr', 'failed')); d.classList.add('is-err'); }
  d.append(s);
  d.addEventListener('toggle', () => {
    if (!d.open || d.dataset.filled) return;
    d.dataset.filled = '1';
    const body = el('div', 'tool-body');
    body.append(el('div', 'lbl', 'Input'), el('pre', null, toolInputText(b.input)));
    if (b.result != null) {
      body.append(el('div', 'lbl', b.isError ? 'Error' : 'Result'), el('pre', b.isError ? 'err' : null, b.result || '(empty)'));
    }
    if (b.images?.length) body.append(images(b.images));
    d.append(body);
  });
  return d;
}

function images(srcs) {
  const box = el('div', 'imgs');
  for (const src of srcs) {
    const img = el('img');
    img.src = src;
    img.loading = 'lazy';
    img.addEventListener('click', () => {
      const lb = el('div', 'lightbox');
      const big = el('img');
      big.src = src;
      lb.append(big);
      lb.addEventListener('click', () => lb.remove());
      document.body.append(lb);
    });
    box.append(img);
  }
  return box;
}

function anchor(uuid) {
  const a = el('a', 'anchor', '#');
  a.href = `#${uuid}`;
  a.title = 'Copy link to this message';
  a.addEventListener('click', e => {
    e.preventDefault();
    history.replaceState({}, '', `/s/${state.activeId}#${uuid}`);
    copy(location.href, 'message link');
  });
  return a;
}

function renderBlocks(blocks, body) {
  let group = null;
  let count = 0;
  const flushCollapsed = () => {
    if (!group) return;
    if (count) body.insertBefore(el('div', 'tools-collapsed', `${count} tool call${count > 1 ? 's' : ''}`), group);
    group = null; count = 0;
  };
  for (const b of blocks) {
    if (b.type === 'tool') {
      if (!group) { group = el('div', 'tools-group'); body.append(group); }
      group.append(renderTool(b));
      count++;
      continue;
    }
    if (b.type === 'thinking') {
      const d = el('details', 'thinking');
      d.append(el('summary', null, 'Thinking'));
      d.addEventListener('toggle', () => { if (d.open && !d.dataset.filled) { d.dataset.filled = '1'; d.append(md(b.text)); } });
      // Thinking lives inside the tool group so hiding tools yields one collapsed label.
      if (group) group.append(d); else body.append(d);
      continue;
    }
    flushCollapsed();
    if (b.type === 'text') body.append(md(b.text));
  }
  flushCollapsed();
}

function renderItem(it, idx = -1, total = 0) {
  if (it.kind === 'user') {
    const m = el('div', 'msg user');
    m.id = it.uuid;
    m.dataset.prompt = '1';
    const head = el('div', 'msg-head');
    head.append(el('span', 'num', fmtTime(it.ts)), anchor(it.uuid));
    m.append(head);
    if (it.images?.length) m.append(images(it.images));
    if (it.text) {
      const b = el('div', 'bubble', it.text);
      m.append(b);
      if (it.text.length > 500 || it.text.split('\n').length > 9) {
        // Long prompts scroll inside a capped bubble; the hint stays until the end is reached.
        const hint = el('div', 'bubble-hint', 'Long message. Scroll inside it to read the rest.');
        m.append(hint);
        requestAnimationFrame(() => { if (b.scrollHeight <= b.clientHeight + 2) hint.remove(); });
        b.addEventListener('scroll', () => hint.classList.toggle('done', b.scrollTop + b.clientHeight >= b.scrollHeight - 4), { passive: true });
      }
    }
    return m;
  }
  if (it.kind === 'assistant') {
    const m = el('div', 'msg ai');
    m.id = it.uuid;
    const head = el('div', 'msg-head');
    head.append(el('span', 'who', 'Claude'));
    if (it.model) head.append(el('span', 'model', it.model.replace(/^claude-/, '')));
    head.append(el('span', 'num', fmtTime(it.ts)));
    if (it.endTs && it.endTs !== it.ts) { const d = el('span', 'num dur', fmtDur(it.ts, it.endTs)); d.title = 'Time spent on this reply'; head.append(d); }
    head.append(anchor(it.uuid));
    // The answer is the trailing run of text blocks; everything before it is work.
    let finalStart = it.blocks.length;
    while (finalStart > 0 && it.blocks[finalStart - 1].type === 'text') finalStart--;
    const workBlocks = it.blocks.slice(0, finalStart);
    const finalBlocks = it.blocks.slice(finalStart);
    const live = state.active?.meta?.live;
    if (idx === total - 1 && live?.status === 'busy') m.classList.add('in-flight');
    const body = el('div', 'body');
    if (workBlocks.length) {
      const notes = workBlocks.filter(b => b.type === 'text').length;
      const tools = workBlocks.filter(b => b.type === 'tool').length;
      const parts = [];
      if (notes) parts.push(`${notes} note${notes > 1 ? 's' : ''}`);
      if (tools) parts.push(`${tools} tool call${tools > 1 ? 's' : ''}`);
      if (!parts.length) parts.push('thinking');
      const dur = it.endTs && it.endTs !== it.ts ? `Worked ${fmtDur(it.ts, it.endTs)}` : 'Worked';
      const btn = el('button', 'work-summary');
      btn.type = 'button';
      btn.append(el('span', 'ws-label', `${dur}: ${parts.join(', ')}`), el('span', 'ws-act'));
      btn.addEventListener('click', () => m.classList.toggle('show-work'));
      const work = el('div', 'work blocks');
      renderBlocks(workBlocks, work);
      body.append(btn, work);
    }
    if (finalBlocks.length) {
      const fin = el('div', 'final blocks');
      renderBlocks(finalBlocks, fin);
      body.append(fin);
    } else {
      m.classList.add('no-final');
    }
    if (!it.blocks.some(b => b.type === 'text')) m.classList.add('tool-only');
    m.append(head, body);
    return m;
  }
  if (it.kind === 'divider') return el('div', 'divider', it.label);
  if (it.kind === 'note') return el('div', 'note', it.text);
  if (it.kind === 'summary') {
    const d = el('details', 'summary-card');
    d.append(el('summary', null, 'Summary of earlier conversation'));
    d.addEventListener('toggle', () => { if (d.open && !d.dataset.filled) { d.dataset.filled = '1'; d.append(md(it.text)); } });
    return d;
  }
  if (it.kind === 'pr') {
    const a = el('a', 'pr-card', `Opened PR #${it.number} in ${it.repo || 'GitHub'}`);
    a.id = prAnchor(it);
    a.href = it.url; a.target = '_blank'; a.rel = 'noopener';
    return a;
  }
  return document.createComment(it.kind);
}

// Opening a session lands on the last user message, a third of the way down the view.
function landingTarget(items) {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'user') return { mode: 'item', idx: i };
  return { mode: 'end' };
}

function scrollToThird(convo, node) {
  // Skip items hidden by the current work/tool mode.
  while (node && !node.offsetParent) node = node.nextElementSibling;
  if (!node) { convo.scrollTop = convo.scrollHeight; return; }
  const c = convo.getBoundingClientRect();
  convo.scrollTop += node.getBoundingClientRect().top - c.top - convo.clientHeight / 3;
}

function renderThread(items, token, targetId, { stickBottom = false, keepScroll = false, land = null } = {}) {
  const thread = $('#thread');
  const convo = $('#convo');
  const prevTop = convo.scrollTop;
  thread.textContent = '';
  thread.dataset.tools = state.toolMode;
  thread.dataset.work = state.workMode;
  if (!keepScroll && !stickBottom) convo.scrollTop = 0;
  if (!items.length) { thread.append(el('div', 'loading', 'No messages in this session.')); return; }
  // Render in chunks so huge sessions stay responsive; jump to target once rendered.
  let i = 0;
  const targetIdx = targetId ? items.findIndex(x => x.uuid === targetId) : -1;
  const step = () => {
    if (token !== state.renderToken) return;
    const frag = document.createDocumentFragment();
    const until = Math.max(i + 120, targetIdx + 1);
    for (; i < items.length && i < until; i++) frag.append(renderItem(items[i], i, items.length));
    thread.append(frag);
    if (targetIdx >= 0 && i > targetIdx && !step.jumped) {
      step.jumped = true;
      const t = document.getElementById(targetId);
      if (t) { scrollWithin(convo, t); t.classList.add('flash'); }
    }
    if (land && !targetId && !step.landed && (land.mode === 'item' ? i > land.idx : i >= items.length)) {
      step.landed = true;
      if (land.mode === 'item') scrollToThird(convo, thread.children[land.idx]);
      else convo.scrollTop = convo.scrollHeight;
    }
    if (i < items.length) requestAnimationFrame(step);
    else if (land?.mode === 'end' && !targetId) convo.scrollTop = convo.scrollHeight;
    else if (stickBottom) convo.scrollTop = convo.scrollHeight;
    else if (keepScroll) convo.scrollTop = prevTop;
  };
  step();
}

// ---------- live refresh ----------
// Poll the open session while it is running (or shortly after we sent a message).
async function refreshActive() {
  const id = state.activeId;
  if (!id || !state.active || document.hidden) return;
  const live = state.sessions.find(s => s.id === id)?.live;
  if (!live && Date.now() > (state.watchUntil || 0)) return;
  let data;
  try { const r = await fetch(`/api/sessions/${id}`); if (!r.ok) return; data = await r.json(); } catch { return; }
  if (id !== state.activeId) return;
  const old = state.active.items;
  const last = x => x.length ? JSON.stringify(x[x.length - 1]).length + ':' + x.length : '0';
  const busy = x => x?.meta?.live?.status === 'busy';
  if (last(old) === last(data.items) && busy(state.active) === busy(data)) { state.active.meta = data.meta; return; }
  const convo = $('#convo');
  const thread = $('#thread');
  const atBottom = convo.scrollHeight - convo.scrollTop - convo.clientHeight < 120;
  state.active = data;
  markRead(id, data.meta.lastTime);
  setHeader(data.meta);
  // Items are append-only except the last one, which grows while Claude works.
  // Replace only the tail so the user's scroll position is never disturbed.
  const from = Math.max(0, old.length - 1);
  if (thread.children.length !== old.length) {
    renderThread(data.items, ++state.renderToken, null, { keepScroll: true });
  } else {
    while (thread.children.length > from) thread.lastChild.remove();
    const frag = document.createDocumentFragment();
    for (let i = from; i < data.items.length; i++) frag.append(renderItem(data.items[i], i, data.items.length));
    thread.append(frag);
  }
  if (atBottom) convo.scrollTop = convo.scrollHeight;
}
setInterval(refreshActive, 3000);

// ---------- composer ----------
function autosize() {
  const t = $('#compose');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 240) + 'px';
  $('#send').disabled = !t.value.trim();
}

function updateComposerHint() {
  const meta = state.active?.meta;
  const live = meta && (state.sessions.find(s => s.id === meta.id)?.live ?? meta.live);
  const app = state.terminal === 'terminal' ? 'Terminal' : 'iTerm';
  $('#compose-hint').textContent = !meta ? '' : live
    ? `Typed into the running session in ${app}. Enter sends, Shift+Enter adds a line (sent as spaces).`
    : `Resumes this session in a new ${app} window with your message. Enter sends, Shift+Enter adds a line.`;
}

async function sendMessage() {
  const t = $('#compose');
  const text = t.value.trim();
  if (!text || !state.activeId) return;
  $('#send').disabled = true;
  try {
    const r = await fetch(`/api/sessions/${state.activeId}/send`, {
      method: 'POST', headers: { 'x-chito': '1', 'content-type': 'application/json' }, body: JSON.stringify({ text }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    t.value = '';
    autosize();
    state.watchUntil = Date.now() + 10 * 60 * 1000;
    toast(j.action === 'typed' ? `Sent to running session (${j.tty})` : 'Resumed in a new terminal window');
    setTimeout(() => loadList(), 2500);
  } catch (e) {
    toast(`Send failed: ${e.message}`);
    $('#send').disabled = false;
  }
}

$('#compose').addEventListener('input', autosize);
$('#compose').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
  else if (e.key === 'Escape') { e.preventDefault(); $('#compose').blur(); }
});
$('#composer').addEventListener('submit', e => { e.preventDefault(); sendMessage(); });
autosize();

function renderInfo() {
  const box = $('#info');
  const data = state.active;
  if (!data) return;
  const m = data.meta;
  box.textContent = '';
  box.append(el('h3', null, m.title));
  const prs = m.prLinks || [];
  const tabs = el('div', 'info-tabs');
  tabs.setAttribute('role', 'tablist');
  for (const [key, label] of [['general', 'General'], ['artifacts', prs.length ? `Artifacts ${prs.length}` : 'Artifacts']]) {
    const t = el('button', 'tab', label);
    t.type = 'button';
    t.setAttribute('role', 'tab');
    t.setAttribute('aria-selected', String(state.infoTab === key));
    t.addEventListener('click', () => { state.infoTab = key; renderInfo(); });
    tabs.append(t);
  }
  box.append(tabs);
  if (state.infoTab === 'artifacts') { box.append(renderArtifacts(prs)); return; }
  const dl = el('dl');
  const row = (k, v) => { dl.append(el('dt', null, k)); const dd = el('dd'); if (v instanceof Node) dd.append(v); else dd.textContent = v ?? '—'; dl.append(dd); };
  const code = t => el('code', null, t);
  row('Started', fmtDateTime(m.startTime));
  row('Last turn', `${fmtDateTime(m.lastTime)} (${fmtRel(m.lastTime)} ago)`.replace('(now ago)', '(just now)'));
  row('Duration', fmtDur(m.startTime, m.lastTime));
  if (m.customTitle) row('Name', m.customTitle);
  if (m.aiTitle && m.aiTitle !== m.customTitle) row('AI title', m.aiTitle);
  row('Session ID', code(m.id));
  row('Directory', code(tildify(m.cwd) || '—'));
  if (m.gitBranch) row('Branch', code(m.gitBranch));
  row('Prompts', `${m.userTurns} prompts, ${m.assistantMsgs} replies, ${m.toolCalls} tool calls`);
  if (m.compactions) row('Compactions', String(m.compactions));
  if (m.subagents) row('Subagents', String(m.subagents));
  row('Models', m.models.join(', ') || '—');
  const t = m.tokens;
  row('Tokens', `${fmtNum(t.input + t.cacheRead + t.cacheWrite)} in, ${fmtNum(t.cacheRead)} of it cached; ${fmtNum(t.output)} out`);
  const tools = Object.entries(m.tools || {}).sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (tools.length) {
    const bar = el('div', 'tools-bar');
    for (const [n, c] of tools) { const t = el('span'); t.append(n + ' ', el('b', 'num', String(c))); bar.append(t); }
    row('Top tools', bar);
  }
  row('CLI version', m.version);
  row('Entrypoint', m.entrypoint);
  row('Transcript', code(`${tildify(m.file)} (${fmtBytes(m.size)})`));
  box.append(dl);
  box.append(el('div', 'cmd', m.resumeCommand));
  if (!m.cwdExists) box.append(el('div', 'warn', 'Original directory no longer exists here; it will open in your home directory.'));
}

const prAnchor = p => `pr-${String(p.repo || '').replace(/[^a-z0-9]+/gi, '-')}-${p.number}`;

function renderArtifacts(prs) {
  const wrap = el('div', 'artifacts');
  if (!prs.length) { wrap.append(el('p', 'artifacts-empty', 'No pull requests were opened in this session.')); return wrap; }
  wrap.append(el('div', 'artifacts-label', prs.length === 1 ? '1 pull request' : `${prs.length} pull requests`));
  for (const p of prs) {
    const row = el('div', 'artifact');
    const a = el('a', 'artifact-main');
    a.href = p.url; a.target = '_blank'; a.rel = 'noopener';
    const live = state.prMap.get(p.url);
    a.append(el('span', 'num artifact-num', `#${p.number}`), el('span', 'artifact-repo', live?.gh?.title || p.repo || 'GitHub'));
    if (live) { a.classList.add(`st-${prState(live)}`); a.append(prPill(prState(live))); a.title = p.repo; }
    row.append(a);
    const sub = el('div', 'artifact-sub');
    if (p.at) sub.append(el('span', null, `Opened ${fmtDateTime(p.at)}`));
    const jump = el('button', 'artifact-jump', 'Show in chat');
    jump.type = 'button';
    jump.addEventListener('click', () => {
      const t = document.getElementById(prAnchor(p));
      if (!t) return;
      toggleInfo(false);
      scrollToThird($('#convo'), t);
      t.classList.add('flash');
      setTimeout(() => t.classList.remove('flash'), 1600);
    });
    sub.append(jump);
    row.append(sub);
    wrap.append(row);
  }
  return wrap;
}

function toggleInfo(force) {
  state.infoOpen = force ?? !state.infoOpen;
  $('#info').hidden = !state.infoOpen;
  $('#b-info').classList.toggle('on', state.infoOpen);
  if (state.infoOpen) renderInfo();
}

const TOOL_MODES = { none: 'Tools off', count: 'Tool counts', full: 'Tool details' };
function updateToolsButton() {
  $('#b-tools span').textContent = TOOL_MODES[state.toolMode];
  $('#b-tools').classList.toggle('on', state.toolMode !== 'none');
}

function updateWorkButton() {
  $('#b-work span').textContent = state.workMode === 'hide' ? 'Work hidden' : 'Work shown';
  $('#b-work').classList.toggle('on', state.workMode === 'show');
}

function toggleWork() {
  state.workMode = state.workMode === 'hide' ? 'show' : 'hide';
  store.set('workMode', state.workMode);
  $('#thread').dataset.work = state.workMode;
  document.querySelectorAll('#thread .msg.show-work').forEach(m => m.classList.remove('show-work'));
  updateWorkButton();
  toast(state.workMode === 'hide' ? 'Showing answers only' : 'Showing all work');
}

// Cycles none -> count -> full.
function toggleTools() {
  const order = ['none', 'count', 'full'];
  state.toolMode = order[(order.indexOf(state.toolMode) + 1) % order.length];
  store.set('toolMode', state.toolMode);
  $('#thread').dataset.tools = state.toolMode;
  updateToolsButton();
  toast(TOOL_MODES[state.toolMode]);
}

function toggleAgents() {
  state.showAgents = !state.showAgents;
  store.set('showAgents', state.showAgents);
  $('#f-agents').classList.toggle('on', state.showAgents);
  applyFilter(false);
}

async function reopen() {
  if (!state.activeId) return;
  toast('Finding terminal…');
  try {
    const r = await fetch(`/api/sessions/${state.activeId}/open`, { method: 'POST', headers: { 'x-chito': '1' } });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    const app = j.terminal === 'iterm' ? 'iTerm' : 'Terminal';
    toast(j.action === 'focused' ? `Focused running session in ${app} (${j.tty})` : j.action === 'forked' ? `Running in the background (pid ${j.pid}), so this opened a forked copy in ${app}; the running session will not see what you type there` : `Opened in ${app}`);
  } catch (e) { toast(`Failed: ${e.message}`); }
}

function jumpPrompt(dir) {
  const convo = $('#convo');
  const prompts = [...document.querySelectorAll('#thread [data-prompt]')];
  if (!prompts.length) return;
  const top = convo.getBoundingClientRect().top;
  const y = p => p.getBoundingClientRect().top - top;
  let target;
  if (dir > 0) target = prompts.find(p => y(p) > 24);
  else target = [...prompts].reverse().find(p => y(p) < -4);
  if (target) scrollWithin(convo, target);
}

// ---------- read state & landing ----------
// seen[id] = lastTime of the session when it was last opened here; newer activity makes it unread.
const seen = store.get('seen', {});
const isUnread = s => !seen[s.id] || (s.lastTime || '') > seen[s.id];
function markRead(id, lastTime) {
  if (!id || !lastTime || seen[id] === lastTime) return;
  seen[id] = lastTime;
  store.set('seen', seen);
}
const outcomeCache = new Map(); // id -> { lastTime, data }

async function renderLanding() {
  if (state.activeId) return;
  const pool = state.sessions.filter(s => (state.showAgents || !s.agent) && isUnread(s)).slice(0, 10);
  const sub = $('#landing-sub');
  const box = $('#recent');
  $('#mark-all').hidden = !pool.length;
  $('#landing-title').textContent = pool.length ? 'Catch up' : "You're caught up";
  sub.textContent = pool.length ? `The latest outcome from ${pool.length === 10 ? '10 recent sessions' : pool.length === 1 ? '1 session' : pool.length + ' sessions'} you haven't opened since it changed.` : 'Nothing new since you last looked. Pick a session on the left or search with /.';
  const need = pool.filter(s => outcomeCache.get(s.id)?.lastTime !== s.lastTime).map(s => s.id);
  if (need.length) {
    try {
      const r = await fetch(`/api/outcomes?ids=${need.join(',')}`);
      const j = await r.json();
      for (const s of pool) if (j[s.id]) outcomeCache.set(s.id, { lastTime: s.lastTime, data: j[s.id] });
    } catch { }
  }
  if (state.activeId) return;
  box.textContent = '';
  for (const s of pool) {
    const o = outcomeCache.get(s.id)?.data || {};
    const a = el('a', 'rcard');
    a.href = `/s/${s.id}`;
    const top = el('div', 'rcard-top');
    top.append(el('span', 'rcard-title', s.title));
    const when = el('span', 'rcard-when', fmtRel(s.lastTime));
    when.title = fmtDateTime(s.lastTime);
    top.append(when);
    const meta = el('div', 'rcard-meta');
    meta.append(el('span', null, s.project));
    if (s.gitBranch && !['main', 'master', 'HEAD'].includes(s.gitBranch)) meta.append(el('span', null, s.gitBranch));
    if (s.live) meta.append(el('span', 'rcard-status', s.live.status === 'busy' ? 'Working now' : 'Open in a terminal'));
    a.append(top, meta);
    if (o.lastPrompt) {
      const pr = el('div', 'rcard-prompt');
      pr.append(el('b', null, 'You: '), o.lastPrompt.replace(/\s+/g, ' '));
      a.append(pr);
    }
    if (o.lastAnswer) {
      const ans = md(o.lastAnswer);
      ans.classList.add('rcard-answer');
      ans.querySelectorAll('a').forEach(x => x.replaceWith(...x.childNodes));
      a.append(ans);
    } else if (s.live?.status === 'busy') {
      a.append(el('div', 'rcard-prompt', 'Claude is still working on this turn.'));
    }
    a.addEventListener('click', e => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      openSession(s.id);
    });
    box.append(a);
  }
  if (!pool.length) box.append(el('div', 'recent-empty'));
}

$('#mark-all').addEventListener('click', () => {
  for (const s of state.sessions) seen[s.id] = s.lastTime;
  store.set('seen', seen);
  renderList(!!$('#q').value.trim(), false);
  renderLanding();
});

// ---------- artifacts: pull requests across sessions ----------
const DAY = 24 * 3600e3;
const PAGE = 15;
const dismissedPrs = store.get('dismissedPrs', {});
state.prs = [];
state.prMap = new Map();
state.github = { ok: true };
state.board = { tab: 'active', page: 0 };

const PR_LABEL = { OPEN: 'Open', DRAFT: 'Draft', MERGED: 'Merged', CLOSED: 'Closed', UNKNOWN: 'Unknown' };
const PR_ICON = {
  OPEN: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7M18 15.5V9a3 3 0 0 0-3-3h-3"/>',
  DRAFT: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7M18 9v.01M18 12.5v.01"/>',
  MERGED: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/><path d="M6 8.5v7M8 7.5c2 3 5 4.5 7.5 4.5"/>',
  CLOSED: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M6 8.5v7M15 6l6 6M21 6l-6 6"/>',
  UNKNOWN: '<circle cx="12" cy="12" r="8"/><path d="M12 8v5M12 16v.01"/>',
};
const prState = pr => pr.gh?.state || 'UNKNOWN';
function prPill(st) {
  const span = el('span', `pr-pill st-${st}`);
  span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${PR_ICON[st]}</svg>`;
  span.append(PR_LABEL[st]);
  return span;
}

async function loadPrs(force = false) {
  try {
    const r = await fetch(`/api/prs${force ? '?refresh=1' : ''}`);
    const j = await r.json();
    state.prs = j.prs;
    state.github = j.github;
    state.prMap = new Map(j.prs.map(p => [p.url, p]));
  } catch (e) { state.github = { ok: false, error: e.message }; }
  updateArtCount();
  if (state.view === 'artifacts') renderBoard();
  if (state.infoOpen && state.infoTab === 'artifacts') renderInfo();
}

// Merged PRs stay on the board for a day; anything not merged stays until dismissed.
function isActivePr(pr) {
  if (dismissedPrs[pr.url]) return false;
  if (prState(pr) !== 'MERGED') return true;
  return Date.now() - new Date(pr.gh.mergedAt).getTime() < DAY;
}

function updateArtCount() {
  const n = state.prs.filter(isActivePr).length;
  $('#art-count').textContent = n ? String(n) : '';
}

function matchesPr(pr, q) {
  if (!q) return true;
  const hay = `${pr.repo} #${pr.number} ${pr.number} ${pr.gh?.title || ''} ${pr.gh?.head || ''}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(t => hay.includes(t.replace(/^#/, '#')) || hay.includes(t.replace(/^#/, '')));
}

function prTimeline(pr) {
  const g = pr.gh;
  if (!g) return pr.firstAt ? `Seen ${fmtRel(pr.firstAt)} ago` : '';
  if (g.state === 'MERGED') return `Merged ${fmtRel(g.mergedAt)} ago`;
  if (g.state === 'CLOSED') return `Closed ${fmtRel(g.closedAt)} ago`;
  return `Updated ${fmtRel(g.updatedAt)} ago`;
}

function renderPrRow(pr, tab) {
  const st = prState(pr);
  const g = pr.gh;
  const row = el('div', `pr st-${st}`);
  const top = el('div', 'pr-top');
  top.append(prPill(st));
  const link = el('a', 'pr-link');
  link.href = pr.url; link.target = '_blank'; link.rel = 'noopener';
  link.title = pr.repo;
  link.append(el('span', 'pr-repo', (pr.repo || '').split('/').pop()), el('span', 'pr-num', `#${pr.number}`), el('span', 'pr-title', g?.title || pr.ghError || 'Title unavailable'));
  top.append(link);
  row.append(top);

  const meta = el('div', 'pr-meta');
  const add = (text, cls, title) => { const x = el('span', cls || null, text); if (title) x.title = title; meta.append(x); };
  const when = prTimeline(pr);
  if (when) add(when, null, g ? `Opened ${fmtDateTime(g.createdAt)}` : null);
  if (g) {
    if (g.author) add(g.author);
    if (g.head) add(`${g.head} into ${g.base}`, 'num');
    const diff = el('span');
    diff.append(el('span', 'num add', `+${g.additions}`), ' ', el('span', 'num del', `−${g.deletions}`), ` in ${g.changedFiles} file${g.changedFiles === 1 ? '' : 's'}`);
    meta.append(diff);
    const checks = { SUCCESS: ['Checks passing', 'ok'], FAILURE: ['Checks failing', 'bad'], ERROR: ['Checks errored', 'bad'], PENDING: ['Checks running', 'wait'], EXPECTED: ['Checks expected', 'wait'] }[g.checks];
    if (checks && st !== 'MERGED') add(checks[0], checks[1]);
    const review = { APPROVED: ['Approved', 'ok'], CHANGES_REQUESTED: ['Changes requested', 'bad'], REVIEW_REQUIRED: ['Review required', 'wait'] }[g.review];
    if (review && (st === 'OPEN' || st === 'DRAFT')) add(review[0], review[1]);
    if (g.comments) add(`${g.comments} comment${g.comments === 1 ? '' : 's'}`);
  }
  row.append(meta);

  const from = el('div', 'pr-from');
  from.append(el('span', null, pr.sessions.length > 1 ? 'From sessions' : 'From session'));
  for (const sess of pr.sessions.slice(0, 3)) {
    const a = el('a', null, sess.title);
    a.href = `/s/${sess.id}`;
    a.addEventListener('click', e => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      openSession(sess.id);
    });
    from.append(a);
  }
  if (pr.sessions.length > 3) from.append(el('span', null, `and ${pr.sessions.length - 3} more`));
  row.append(from);

  const actions = el('div', 'pr-actions');
  const btn = el('button', 'btn icon');
  btn.type = 'button';
  const dismissing = tab === 'active';
  btn.title = dismissing ? 'Dismiss' : 'Restore to Active';
  btn.setAttribute('aria-label', btn.title);
  btn.innerHTML = dismissing
    ? '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'
    : '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>';
  btn.addEventListener('click', () => {
    if (dismissing) dismissedPrs[pr.url] = new Date().toISOString(); else delete dismissedPrs[pr.url];
    store.set('dismissedPrs', dismissedPrs);
    updateArtCount();
    renderBoard();
    toast(dismissing ? `Dismissed #${pr.number}` : `Restored #${pr.number}`);
  });
  actions.append(btn);
  row.append(actions);
  return row;
}

function renderBoard() {
  const q = $('#bq').value.trim();
  const active = state.prs.filter(isActivePr);
  const dismissed = state.prs.filter(p => dismissedPrs[p.url]);
  $('#n-active').textContent = active.length;
  $('#n-dismissed').textContent = dismissed.length;
  document.querySelectorAll('#board-tabs button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.tab === state.board.tab)));
  const status = $('#board-status');
  if (state.github && !state.github.ok) {
    status.hidden = false;
    status.innerHTML = '';
    status.append('GitHub state is unavailable, so PRs show without titles or status. Run ', el('code', null, 'gh auth login'), ' in a terminal, then refresh.');
  } else status.hidden = true;

  // Open and draft first (they need you), then everything else; newest activity first within each.
  const rank = { OPEN: 0, DRAFT: 1, UNKNOWN: 2, CLOSED: 3, MERGED: 3 };
  const recency = p => p.gh?.mergedAt || p.gh?.closedAt || p.gh?.updatedAt || p.firstAt || '';
  const pool = (state.board.tab === 'active' ? active : dismissed).filter(p => matchesPr(p, q))
    .sort((x, y) => rank[prState(x)] - rank[prState(y)] || (recency(y) > recency(x) ? 1 : -1));
  const pages = Math.max(1, Math.ceil(pool.length / PAGE));
  state.board.page = Math.min(state.board.page, pages - 1);
  const slice = pool.slice(state.board.page * PAGE, (state.board.page + 1) * PAGE);
  const box = $('#prs');
  box.textContent = '';
  for (const pr of slice) box.append(renderPrRow(pr, state.board.tab));
  if (!slice.length) {
    box.append(el('div', 'prs-empty', q ? 'No pull requests match that search.'
      : state.board.tab === 'active' ? 'Nothing active. Open PRs appear here, and merged ones stay for 24 hours.'
      : 'Nothing dismissed.'));
  }
  const pager = $('#pager');
  pager.textContent = '';
  if (pages > 1) {
    const prev = el('button', 'btn', 'Previous'); prev.disabled = state.board.page === 0;
    const next = el('button', 'btn', 'Next'); next.disabled = state.board.page >= pages - 1;
    prev.addEventListener('click', () => { state.board.page--; renderBoard(); $('#board').scrollTop = 0; });
    next.addEventListener('click', () => { state.board.page++; renderBoard(); $('#board').scrollTop = 0; });
    pager.append(prev, el('span', 'num', `Page ${state.board.page + 1} of ${pages}`), next);
  }
}

function setView(view) {
  state.view = view;
  document.body.classList.toggle('view-artifacts', view === 'artifacts');
  document.body.classList.toggle('view-backlog', view === 'backlog');
  $('#board').hidden = view !== 'artifacts';
  $('#backlog').hidden = view !== 'backlog';
  if (view === 'backlog') { renderBacklog(); startBacklogPolling(); } else stopBacklogPolling();
  document.querySelectorAll('.views .view-tab').forEach(t => {
    if (t.dataset.view === view) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });
  if (view === 'artifacts') { document.title = 'Artifacts · chito'; renderBoard(); }
}

$('#bq').addEventListener('input', () => { state.board.page = 0; renderBoard(); });
$('#bq').addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); if ($('#bq').value) { $('#bq').value = ''; renderBoard(); } else $('#bq').blur(); } });
document.querySelectorAll('#board-tabs button').forEach(b => b.addEventListener('click', () => { state.board.tab = b.dataset.tab; state.board.page = 0; renderBoard(); }));
$('#board-refresh').addEventListener('click', async () => { toast('Refreshing from GitHub…'); await loadPrs(true); toast('Up to date'); });
document.querySelectorAll('.views .view-tab').forEach(t => t.addEventListener('click', e => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  const path = { artifacts: '/artifacts', backlog: '/backlog' }[t.dataset.view] || '/';
  if (location.pathname !== path) history.pushState({}, '', path);
  route();
}));

// ---------- settings ----------
const PRESETS = [
  { id: 'slate', name: 'Slate', note: 'Light, magenta, Hanken Grotesk' },
  { id: 'ink', name: 'Ink', note: 'Light, teal, Epilogue' },
  { id: 'sage', name: 'Sage', note: 'Light, green, Schibsted Grotesk' },
  { id: 'console', name: 'Console', note: 'Dark, amber, Host Grotesk' },
  { id: 'midnight', name: 'Midnight', note: 'Dark, ice blue, Mona Sans' },
  { id: 'plum', name: 'Plum', note: 'Dark, coral, Geist' },
];

function renderPresets() {
  const box = $('#presets');
  box.textContent = '';
  for (const p of PRESETS) {
    // Each card carries its own data-theme, so the preview renders in that preset's tokens and fonts.
    const b = el('button', 'preset');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.theme = p.id;
    b.dataset.preset = p.id;
    const pv = el('div', 'pv');
    const side = el('div', 'pv-side');
    for (let i = 0; i < 4; i++) side.append(el('i'));
    const main = el('div', 'pv-main');
    const foot = el('div', 'pv-foot');
    foot.append(el('div', 'pv-chip'), el('div', 'pv-dot'));
    main.append(el('div', 'pv-bubble'), el('div', 'pv-aa', 'Aa'), el('div', 'pv-line'), el('div', 'pv-line short'), foot);
    pv.append(side, main);
    const meta = el('div', 'meta');
    meta.append(el('b', null, p.name), el('span', null, p.note));
    b.append(pv, meta);
    b.addEventListener('click', () => setPreset(p.id));
    box.append(b);
  }
}

function setPreset(id) {
  document.documentElement.dataset.theme = id;
  store.set('theme', id);
  syncSettings();
}

function setToolMode(m) {
  state.toolMode = m;
  store.set('toolMode', m);
  $('#thread').dataset.tools = m;
  updateToolsButton();
}

function syncSettings() {
  const cur = document.documentElement.dataset.theme;
  document.querySelectorAll('#presets .preset').forEach(b => b.setAttribute('aria-checked', String(b.dataset.preset === cur)));
  const val = { work: state.workMode, tools: state.toolMode, agents: state.showAgents ? 'show' : 'hide' };
  document.querySelectorAll('#settings .seg').forEach(seg => seg.querySelectorAll('button').forEach(b => {
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(b.dataset.v === val[seg.dataset.opt]));
  }));
}

function showTab(name) {
  document.querySelectorAll('#settings .tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  document.querySelectorAll('#settings .tabpanel').forEach(p => { p.hidden = p.dataset.panel !== name; });
  store.set('settingsTab', name);
}

function openSettings(tab) {
  $('#settings').hidden = false;
  syncSettings();
  showTab(tab || store.get('settingsTab', 'appearance'));
  $('#settings .tab[aria-selected="true"]')?.focus();
}

function closeSettings() { $('#settings').hidden = true; }

// ---------- keyboard ----------
document.addEventListener('keydown', e => {
  const inSearch = document.activeElement === $('#q');
  const settingsOpen = !$('#settings').hidden;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#q').focus(); $('#q').select(); return; }
  if (e.key === 'Escape') {
    if (state.view === 'backlog' && !settingsOpen && closeDrawer()) return;
    if (document.querySelector('.lightbox')) { document.querySelector('.lightbox').remove(); return; }
    if (settingsOpen) { closeSettings(); return; }
    if (state.infoOpen) { toggleInfo(false); return; }
    if (inSearch) { if ($('#q').value) { $('#q').value = ''; applyFilter(); } else $('#q').blur(); return; }
    return;
  }
  if (settingsOpen) {
    const tabs = ['appearance', 'conversation', 'keyboard', 'about'];
    if (['1', '2', '3', '4'].includes(e.key)) { e.preventDefault(); showTab(tabs[Number(e.key) - 1]); }
    return;
  }
  if (inSearch) {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); moveCursor(1); }
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); moveCursor(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); const s = state.filtered[state.cursor]; if (s) { openSession(s.id); $('#q').blur(); } }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input, textarea')) return;
  // A focused control keeps Enter / Space for its own activation. Session list rows are links
  // too, but there Enter still opens the cursor row and Space still scrolls the conversation.
  if (e.key === 'Enter' || e.key === ' ') {
    const ctl = e.target.closest('button, a, summary, [role=button]');
    if (ctl && !ctl.matches('#list a.item')) return;
  }
  const convo = $('#convo');
  const keys = {
    '/': () => { const box = state.view === 'artifacts' ? $('#bq') : state.view === 'backlog' ? ($('#blq') || $('#q')) : $('#q'); box.focus(); box.select(); },
    '?': () => openSettings('keyboard'),
    ',': () => openSettings(),
    P: () => { const path = state.view === 'artifacts' ? '/' : '/artifacts'; history.pushState({}, '', path); route(); },
    B: () => { const path = state.view === 'backlog' ? '/' : '/backlog'; history.pushState({}, '', path); route(); },
    f: () => togglePin(),
    j: () => moveCursor(1),
    k: () => moveCursor(-1),
    ArrowDown: () => convo.scrollBy({ top: 80 }),
    ArrowUp: () => convo.scrollBy({ top: -80 }),
    PageDown: () => convo.scrollBy({ top: convo.clientHeight * 0.85 }),
    PageUp: () => convo.scrollBy({ top: -convo.clientHeight * 0.85 }),
    Home: () => convo.scrollTo({ top: 0 }),
    End: () => convo.scrollTo({ top: convo.scrollHeight }),
    Enter: () => { const s = state.filtered[state.cursor]; if (s) openSession(s.id); },
    o: reopen,
    r: () => { if (state.activeId) $('#compose').focus(); },
    c: () => state.active && copy(state.active.meta.resumeCommand, 'resume command'),
    y: () => state.activeId && copy(`${location.origin}/s/${state.activeId}`, 'permalink'),
    i: () => { if (!state.active) return; if (!state.infoOpen) state.infoTab = 'general'; toggleInfo(); },
    t: toggleTools,
    w: toggleWork,
    a: toggleAgents,
    n: () => jumpPrompt(1),
    p: () => jumpPrompt(-1),
    g: () => convo.scrollTo({ top: 0 }),
    G: () => convo.scrollTo({ top: convo.scrollHeight }),
    ' ': () => convo.scrollBy({ top: (e.shiftKey ? -1 : 1) * convo.clientHeight * 0.85 }),
    '[': () => document.querySelector('.app').classList.toggle('collapsed'),
  };
  const fn = keys[e.key];
  if (fn) { e.preventDefault(); fn(); }
});

// ---------- wiring ----------
$('#q').addEventListener('input', () => {
  applyFilter();
  const q = $('#q').value.trim();
  const url = new URL(location.href);
  if (q) url.searchParams.set('q', q); else url.searchParams.delete('q');
  history.replaceState({}, '', url);
});
$('#f-agents').classList.toggle('on', state.showAgents);
$('#f-agents').addEventListener('click', toggleAgents);
$('#help-btn').addEventListener('click', () => openSettings('keyboard'));
$('#b-settings').addEventListener('click', () => openSettings());
$('#home').addEventListener('click', e => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  if (location.pathname !== '/') history.pushState({}, '', '/' + location.search);
  route();
});
$('#settings-close').addEventListener('click', closeSettings);
$('#settings').addEventListener('click', e => { if (e.target.id === 'settings') closeSettings(); });
document.querySelectorAll('#settings .tab').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));
renderPresets();
document.querySelectorAll('#settings .seg').forEach(seg => seg.addEventListener('click', e => {
  const v = e.target.closest('button')?.dataset.v;
  if (!v) return;
  const opt = seg.dataset.opt;
  if (opt === 'work' && state.workMode !== v) toggleWork();
  if (opt === 'tools') setToolMode(v);
  if (opt === 'agents' && state.showAgents !== (v === 'show')) toggleAgents();
  syncSettings();
}));
$('#b-info').addEventListener('click', () => { if (!state.infoOpen) state.infoTab = 'general'; toggleInfo(); });
$('#b-tools').addEventListener('click', toggleTools);
updateToolsButton();
$('#b-work').addEventListener('click', toggleWork);
const qTheme = new URL(location.href).searchParams.get('theme');
if (qTheme && PRESETS.some(p => p.id === qTheme)) document.documentElement.dataset.theme = qTheme;
updateWorkButton();
$('#b-open').addEventListener('click', reopen);
$('#b-pin').addEventListener('click', () => togglePin());
initBacklog({ openSession: id => openSession(id), toast, fmtRel, fmtDateTime, getPr: url => state.prMap.get(url)?.gh || null });
$('#b-copy').addEventListener('click', () => state.active && copy(state.active.meta.resumeCommand, 'resume command'));
$('#b-link').addEventListener('click', () => copy(`${location.origin}/s/${state.activeId}`, 'permalink'));
document.addEventListener('click', e => {
  if (state.infoOpen && !e.target.closest('#info') && !e.target.closest('#b-info')) toggleInfo(false);
});

function route() {
  const m = location.pathname.match(/^\/s\/([0-9a-f-]{36})/i);
  const artifacts = location.pathname === '/artifacts';
  const backlog = !!parseBacklogPath(location.pathname);
  setView(artifacts ? 'artifacts' : backlog ? 'backlog' : 'sessions');
  if (m) {
    if (m[1] !== state.activeId) openSession(m[1], { push: false });
    else if (location.hash) { const t = document.getElementById(location.hash.slice(1)); if (t) scrollWithin($('#convo'), t); }
  } else {
    state.activeId = null; state.active = null;
    document.querySelectorAll('#list .item.active').forEach(n => n.classList.remove('active'));
    document.body.classList.remove('has-session');
    $('#thread').textContent = '';
    setHeader(null);
    if (!artifacts && !backlog) { document.title = 'chito'; renderLanding(); }
  }
}
window.addEventListener('popstate', route);

const initialQ = new URL(location.href).searchParams.get('q');
if (initialQ) $('#q').value = initialQ;
await loadList();
route();
if (state.activeId) {
  const i = state.filtered.findIndex(s => s.id === state.activeId);
  if (i >= 0) { state.cursor = i; renderList(!!$('#q').value.trim()); }
}
setInterval(() => { if (!document.hidden) loadList(); }, 15000);
loadPrs();
setInterval(() => { if (!document.hidden) loadPrs(); }, 60000);
