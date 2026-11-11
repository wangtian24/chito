import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';

marked.setOptions({ gfm: true, breaks: false });

const $ = s => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const store = {
  get(k, d) { try { const v = localStorage.getItem('cito.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cito.' + k, JSON.stringify(v)); } catch { } },
};

const state = {
  sessions: [],
  filtered: [],
  cursor: -1,
  activeId: null,
  active: null, // { meta, items }
  showAgents: store.get('showAgents', false),
  showTools: store.get('showTools', true),
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
  const s = Math.max(0, (new Date(b) - new Date(a)) / 1000);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
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
    applyFilter(false);
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

function applyFilter(resetCursor = true) {
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
  renderList(terms.length > 0);
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

function renderList(searching) {
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
    if (i === state.cursor) a.classList.add('cursor');
    const t = el('div', 'item-title');
    t.append(highlight(s.title, terms));
    t.title = s.title;
    const m = el('div', 'item-meta');
    m.append(el('span', 'proj', s.project + (s.gitBranch && !['main', 'master', 'HEAD'].includes(s.gitBranch) ? ` · ${s.gitBranch}` : '')));
    if (s.prCount) m.append(el('span', 'badge', `PR${s.prCount > 1 ? '×' + s.prCount : ''}`));
    const right = el('span', 'right', `${s.userTurns}↵ · ${fmtRel(s.lastTime)}`);
    right.title = `${s.userTurns} prompts · last turn ${fmtDateTime(s.lastTime)}`;
    m.append(right);
    a.append(t, m);
    a.addEventListener('click', e => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      state.cursor = i;
      openSession(s.id);
    });
    list.append(a);
  });
  scrollCursorIntoView();
}

function scrollCursorIntoView() {
  const c = $('#list .item.cursor');
  if (c) c.scrollIntoView({ block: 'nearest' });
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
  document.title = `${data.meta.title} · cito`;
  setHeader(data.meta);
  if (state.infoOpen) renderInfo();
  renderThread(data.items, token, (location.hash || '').slice(1));
}

function setHeader(meta) {
  $('#actions').hidden = !meta;
  if (!meta) { $('#title').textContent = 'Select a session'; $('#subtitle').textContent = ''; return; }
  $('#title').textContent = meta.title;
  $('#title').title = meta.title;
  const sub = $('#subtitle');
  sub.textContent = '';
  const parts = [tildify(meta.cwd) || meta.project];
  if (meta.gitBranch) parts.push(meta.gitBranch);
  parts.push(`${fmtDateTime(meta.startTime)} → ${fmtRel(meta.lastTime) === 'now' ? 'now' : fmtDateTime(meta.lastTime)}`);
  parts.push(`${meta.userTurns} prompts`);
  parts.forEach((p, i) => { if (i) sub.append(el('span', 'sep', '·')); sub.append(p); });
  $('#b-tools').classList.toggle('on', !state.showTools);
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
  const stat = el('span', 'tstat' + (b.isError ? ' err' : b.result == null ? ' none' : ''));
  s.append(stat, el('span', 'tname', b.name), el('span', 'targ', toolArg(b.name, b.input)));
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

function renderItem(it) {
  if (it.kind === 'user') {
    const m = el('div', 'msg user');
    m.id = it.uuid;
    m.dataset.prompt = '1';
    const head = el('div', 'msg-head');
    head.append(el('span', null, fmtTime(it.ts)), anchor(it.uuid));
    m.append(head);
    if (it.images?.length) m.append(images(it.images));
    if (it.text) {
      const b = el('div', 'bubble', it.text);
      if (it.text.length > 1400 || it.text.split('\n').length > 18) {
        b.classList.add('long');
        b.addEventListener('click', () => b.classList.remove('long'), { once: true });
      }
      m.append(b);
    }
    return m;
  }
  if (it.kind === 'assistant') {
    const m = el('div', 'msg ai');
    m.id = it.uuid;
    const head = el('div', 'msg-head');
    const av = el('div', 'avatar ai', '✳');
    head.append(av, el('span', 'who', 'Claude'));
    if (it.model) head.append(el('span', null, it.model.replace(/^claude-/, '')));
    head.append(el('span', null, fmtTime(it.ts)));
    if (it.endTs && it.endTs !== it.ts) head.append(el('span', null, `· ${fmtDur(it.ts, it.endTs)}`));
    head.append(anchor(it.uuid));
    const body = el('div', 'body blocks');
    let group = null;
    let hiddenCount = 0;
    const flushCollapsed = () => {
      if (!group) return;
      if (!hiddenCount) { group = null; return; }
      const c = el('div', 'tools-collapsed', `⚙ ${hiddenCount} tool call${hiddenCount > 1 ? 's' : ''}`);
      body.insertBefore(c, group);
      group = null; hiddenCount = 0;
    };
    for (const b of it.blocks) {
      if (b.type === 'tool') {
        if (!group) { group = el('div', 'tools-group'); body.append(group); }
        group.append(renderTool(b));
        hiddenCount++;
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
    const a = el('a', 'pr-card', `↗ PR #${it.number} · ${it.repo || ''}`);
    a.href = it.url; a.target = '_blank'; a.rel = 'noopener';
    return a;
  }
  return document.createComment(it.kind);
}

function renderThread(items, token, targetId) {
  const thread = $('#thread');
  thread.textContent = '';
  thread.classList.toggle('hide-tools', !state.showTools);
  const convo = $('#convo');
  convo.scrollTop = 0;
  if (!items.length) { thread.append(el('div', 'loading', 'No messages in this session.')); return; }
  // Render in chunks so huge sessions stay responsive; jump to target once rendered.
  let i = 0;
  const targetIdx = targetId ? items.findIndex(x => x.uuid === targetId) : -1;
  const step = () => {
    if (token !== state.renderToken) return;
    const frag = document.createDocumentFragment();
    const until = Math.max(i + 120, targetIdx + 1);
    for (; i < items.length && i < until; i++) frag.append(renderItem(items[i]));
    thread.append(frag);
    if (targetIdx >= 0 && i > targetIdx && !step.jumped) {
      step.jumped = true;
      const t = document.getElementById(targetId);
      if (t) { t.scrollIntoView({ block: 'start' }); t.classList.add('flash'); }
    }
    if (i < items.length) requestAnimationFrame(step);
  };
  step();
}

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
  row('Prompts', `${m.userTurns} prompts · ${m.assistantMsgs} replies · ${m.toolCalls} tool calls`);
  if (m.compactions) row('Compactions', String(m.compactions));
  if (m.subagents) row('Subagents', String(m.subagents));
  row('Models', m.models.join(', ') || '—');
  const t = m.tokens;
  row('Tokens', `${fmtNum(t.input + t.cacheRead + t.cacheWrite)} in (${fmtNum(t.cacheRead)} cached) · ${fmtNum(t.output)} out`);
  const tools = Object.entries(m.tools || {}).sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (tools.length) {
    const bar = el('div', 'tools-bar');
    for (const [n, c] of tools) bar.append(el('span', null, `${n} ${c}`));
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

function toggleTools() {
  state.showTools = !state.showTools;
  store.set('showTools', state.showTools);
  $('#thread').classList.toggle('hide-tools', !state.showTools);
  $('#b-tools').classList.toggle('on', !state.showTools);
  toast(state.showTools ? 'Showing tool calls' : 'Hiding tool calls');
}

function toggleAgents() {
  state.showAgents = !state.showAgents;
  store.set('showAgents', state.showAgents);
  $('#f-agents').classList.toggle('on', state.showAgents);
  applyFilter(false);
}

async function reopen() {
  if (!state.activeId) return;
  toast('Opening terminal…');
  try {
    const r = await fetch(`/api/sessions/${state.activeId}/open`, { method: 'POST', headers: { 'x-cito': '1' } });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    toast(`Opened in ${j.terminal === 'iterm' ? 'iTerm' : 'Terminal'}`);
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
  if (target) target.scrollIntoView({ block: 'start' });
}

// ---------- keyboard ----------
document.addEventListener('keydown', e => {
  const inSearch = document.activeElement === $('#q');
  const helpOpen = !$('#help').hidden;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#q').focus(); $('#q').select(); return; }
  if (e.key === 'Escape') {
    if (document.querySelector('.lightbox')) { document.querySelector('.lightbox').remove(); return; }
    if (helpOpen) { $('#help').hidden = true; return; }
    if (state.infoOpen) { toggleInfo(false); return; }
    if (inSearch) { if ($('#q').value) { $('#q').value = ''; applyFilter(); } else $('#q').blur(); return; }
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
    '?': () => { $('#help').hidden = !$('#help').hidden; },
    j: () => moveCursor(1), ArrowDown: () => moveCursor(1),
    k: () => moveCursor(-1), ArrowUp: () => moveCursor(-1),
    Enter: () => { const s = state.filtered[state.cursor]; if (s) openSession(s.id); },
    o: reopen,
    c: () => state.active && copy(state.active.meta.resumeCommand, 'resume command'),
    y: () => state.activeId && copy(`${location.origin}/s/${state.activeId}`, 'permalink'),
    i: () => state.active && toggleInfo(),
    t: toggleTools,
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
$('#help-btn').addEventListener('click', () => { $('#help').hidden = false; });
$('#help').addEventListener('click', e => { if (e.target.id === 'help') $('#help').hidden = true; });
$('#b-info').addEventListener('click', () => toggleInfo());
$('#b-tools').addEventListener('click', toggleTools);
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
    else if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'start' });
  } else {
    state.activeId = null; state.active = null;
    document.body.classList.remove('has-session');
    $('#thread').textContent = '';
    setHeader(null);
    document.title = 'cito';
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
