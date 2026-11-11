import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';

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
  renderToken: 0,
};

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

function renderList(searching, follow = true) {
  const list = $('#list');
  const { terms } = parseQuery($('#q').value);
  list.textContent = '';
  const shown = state.sessions.filter(s => state.showAgents || !s.agent).length;
  $('#count').textContent = searching ? `${state.filtered.length} / ${shown}` : `${shown}`;
  if (!state.filtered.length) { list.append(el('div', 'list-empty', 'No sessions match.')); return; }
  let lastGroup = null;
  state.filtered.forEach((s, i) => {
    if (!searching) {
      const g = groupLabel(s.lastTime);
      if (g !== lastGroup) { list.append(el('div', 'group', g)); lastGroup = g; }
    }
    const a = el('a', 'item');
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
    if (s.prCount) m.append(el('span', 'badge', s.prCount > 1 ? `${s.prCount} PRs` : 'PR'));
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
    list.append(a);
  });
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
  if (!state.filtered.length) return;
  state.cursor = Math.max(0, Math.min(state.filtered.length - 1, state.cursor + delta));
  state.cursorId = state.filtered[state.cursor].id;
  document.querySelectorAll('#list .item').forEach(n => n.classList.toggle('cursor', Number(n.dataset.idx) === state.cursor));
  scrollCursorIntoView();
}

// ---------- session ----------
async function openSession(id, { push = true, hash = '' } = {}) {
  if (push) history.pushState({}, '', `/s/${id}${hash}`);
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
  if (state.infoOpen) renderInfo();
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
  if (m.prLinks?.length) {
    const wrap = el('div');
    for (const p of m.prLinks) { const a = el('a', null, `#${p.number} ${p.repo || ''}`); a.href = p.url; a.target = '_blank'; wrap.append(a, el('br')); }
    row('Pull requests', wrap);
  }
  row('CLI version', m.version);
  row('Entrypoint', m.entrypoint);
  row('Transcript', code(`${tildify(m.file)} (${fmtBytes(m.size)})`));
  box.append(dl);
  box.append(el('div', 'cmd', m.resumeCommand));
  if (!m.cwdExists) box.append(el('div', 'warn', 'Original directory no longer exists here; it will open in your home directory.'));
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
    toast(j.action === 'focused' ? `Focused running session in ${app} (${j.tty})` : `Opened in ${app}`);
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
  const convo = $('#convo');
  const keys = {
    '/': () => { $('#q').focus(); $('#q').select(); },
    '?': () => openSettings('keyboard'),
    ',': () => openSettings(),
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
    i: () => state.active && toggleInfo(),
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
$('#b-info').addEventListener('click', () => toggleInfo());
$('#b-tools').addEventListener('click', toggleTools);
updateToolsButton();
$('#b-work').addEventListener('click', toggleWork);
const qTheme = new URL(location.href).searchParams.get('theme');
if (qTheme && PRESETS.some(p => p.id === qTheme)) document.documentElement.dataset.theme = qTheme;
updateWorkButton();
$('#b-open').addEventListener('click', reopen);
$('#b-copy').addEventListener('click', () => state.active && copy(state.active.meta.resumeCommand, 'resume command'));
$('#b-link').addEventListener('click', () => copy(`${location.origin}/s/${state.activeId}`, 'permalink'));
document.addEventListener('click', e => {
  if (state.infoOpen && !e.target.closest('#info') && !e.target.closest('#b-info')) toggleInfo(false);
});

function route() {
  const m = location.pathname.match(/^\/s\/([0-9a-f-]{36})/i);
  if (m) {
    if (m[1] !== state.activeId) openSession(m[1], { push: false });
    else if (location.hash) { const t = document.getElementById(location.hash.slice(1)); if (t) scrollWithin($('#convo'), t); }
  } else {
    state.activeId = null; state.active = null;
    document.querySelectorAll('#list .item.active').forEach(n => n.classList.remove('active'));
    document.body.classList.remove('has-session');
    $('#thread').textContent = '';
    setHeader(null);
    document.title = 'chito';
    renderLanding();
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
