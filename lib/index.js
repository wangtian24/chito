// Session index: scans ~/.claude/projects/*/*.jsonl and extracts lightweight
// metadata per session. Results are cached by (mtime, size) in memory and on
// disk so only changed transcripts are re-parsed.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const HOME = os.homedir();
export const PROJECTS_DIR = process.env.CHITO_PROJECTS_DIR || path.join(HOME, '.claude', 'projects');
const CACHE_DIR = path.join(HOME, '.cache', 'chito');
const CACHE_FILE = path.join(CACHE_DIR, 'index-v4.json');

// Lines we never need for metadata; skipping them avoids parsing huge blobs.
const SKIP_PREFIXES = ['{"type":"api-request', '{"type":"file-history', '{"type":"atis-latch'];

let cache = new Map(); // filePath -> { mtimeMs, size, meta }
let lastScan = 0;
let sessions = [];
let byId = new Map();
let saveTimer = null;

function loadCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    cache = new Map(Object.entries(raw));
  } catch { /* first run */ }
}

function saveCacheSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(cache)));
    } catch (e) { console.error('[chito] cache save failed', e.message); }
  }, 1000);
}

export function cleanPromptText(text) {
  if (!text) return '';
  let t = String(text);
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  const cmd = t.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (cmd) {
    const args = (t.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1] || '';
    const name = cmd[1].trim();
    return (name.startsWith('/') ? name : '/' + name) + (args.trim() ? ' ' + args.trim() : '');
  }
  t = t.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '');
  return t.trim();
}

export function userText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(b => b && b.type === 'text').map(b => b.text).join('\n');
  }
  return '';
}

function isRealPrompt(d) {
  if (d.type !== 'user' || d.isMeta || d.isSidechain || d.isCompactSummary) return false;
  const c = d.message && d.message.content;
  if (Array.isArray(c) && c.length && c.every(b => b.type === 'tool_result')) return false;
  const t = cleanPromptText(userText(c));
  if (!t) return false;
  if (t.startsWith('<local-command-stdout>') || t.startsWith('<local-command-stderr>')) return false;
  if (t.startsWith('[Request interrupted') || t.startsWith('<task-notification>')) return false;
  return true;
}

export function parseMeta(filePath, stat) {
  const id = path.basename(filePath, '.jsonl');
  const projectDir = path.basename(path.dirname(filePath));
  const meta = {
    id, projectDir, file: filePath, size: stat.size,
    cwd: null, gitBranch: null, version: null, entrypoint: null,
    customTitle: null, aiTitle: null, summary: null,
    firstPrompt: null, lastPrompt: null,
    startTime: null, lastTime: null,
    userTurns: 0, assistantMsgs: 0, toolCalls: 0, compactions: 0,
    models: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    prLinks: [], tools: {}, subagents: 0,
  };
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return null; }
  const models = new Set();
  let turnTexts = []; // trailing text blocks of the latest turn = its outcome
  const seenMsg = new Set();
  const prSeen = new Set();
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    const line = text.slice(start, end);
    start = end + 1;
    if (!line || SKIP_PREFIXES.some(p => line.startsWith(p))) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const ty = d.type;
    if (ty === 'custom-title') { meta.customTitle = d.customTitle || meta.customTitle; continue; }
    if (ty === 'ai-title') { meta.aiTitle = d.aiTitle || meta.aiTitle; continue; }
    if (ty === 'summary') { meta.summary = d.summary || meta.summary; continue; }
    if (ty === 'last-prompt') { if (d.lastPrompt) meta.lastPrompt = d.lastPrompt; continue; }
    if (ty === 'pr-link') {
      if (d.prUrl && !prSeen.has(d.prUrl)) { prSeen.add(d.prUrl); meta.prLinks.push({ url: d.prUrl, number: d.prNumber, repo: d.prRepository }); }
      continue;
    }
    if (ty !== 'user' && ty !== 'assistant' && ty !== 'system') continue;
    if (d.isSidechain) continue;
    if (d.cwd && !meta.cwd) meta.cwd = d.cwd;
    if (d.gitBranch) meta.gitBranch = d.gitBranch;
    if (d.version) meta.version = d.version;
    if (d.entrypoint && !meta.entrypoint) meta.entrypoint = d.entrypoint;
    if (d.timestamp) {
      if (!meta.startTime) meta.startTime = d.timestamp;
      if (ty !== 'system') meta.lastTime = d.timestamp;
    }
    if (ty === 'system' && d.subtype === 'compact_boundary') meta.compactions++;
    if (ty === 'user' && isRealPrompt(d)) {
      meta.userTurns++;
      const t = cleanPromptText(userText(d.message.content));
      if (!meta.firstPrompt || (meta.firstPrompt.startsWith('/') && !t.startsWith('/'))) meta.firstPrompt = t.slice(0, 400);
      meta.lastPrompt = t.slice(0, 400);
      turnTexts = [];
    }
    if (ty === 'assistant' && d.message) {
      const m = d.message;
      if (m.model && m.model !== '<synthetic>') models.add(m.model);
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === 'tool_use') { meta.toolCalls++; meta.tools[b.name] = (meta.tools[b.name] || 0) + 1; turnTexts = []; }
          else if (b.type === 'text' && b.text && b.text.trim()) turnTexts.push(b.text.trim());
        }
      }
      if (m.id && !seenMsg.has(m.id)) {
        seenMsg.add(m.id);
        meta.assistantMsgs++;
        const u = m.usage;
        if (u) {
          meta.tokens.input += u.input_tokens || 0;
          meta.tokens.output += u.output_tokens || 0;
          meta.tokens.cacheRead += u.cache_read_input_tokens || 0;
          meta.tokens.cacheWrite += u.cache_creation_input_tokens || 0;
        }
      }
    }
  }
  meta.models = [...models];
  meta.lastAnswer = turnTexts.length ? turnTexts.join('\n\n').slice(0, 1200) : null;
  try { meta.subagents = fs.readdirSync(path.join(path.dirname(filePath), id, 'subagents')).filter(f => f.endsWith('.jsonl')).length; } catch { }
  const fromPrompt = meta.firstPrompt ? meta.firstPrompt.replace(/<@[A-Z0-9]+>\s*/g, '').split('\n')[0].trim().slice(0, 90) : null;
  meta.title = meta.customTitle || meta.aiTitle || meta.summary || fromPrompt || 'Untitled session';
  meta.agent = !!meta.cwd && !meta.cwd.startsWith(HOME);
  meta.project = !meta.cwd ? projectDir
    : meta.cwd === HOME ? '~'
    : meta.agent && /^\/data\/ahs\//.test(meta.cwd) ? 'ahs agent'
    : path.basename(meta.cwd);
  if (!meta.startTime) meta.startTime = new Date(stat.mtimeMs).toISOString();
  if (!meta.lastTime) meta.lastTime = meta.startTime;
  return meta;
}

function listFiles() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, d.name);
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) if (f.endsWith('.jsonl')) out.push(path.join(dir, f));
  }
  return out;
}

export function scan(force = false) {
  const now = Date.now();
  if (!force && now - lastScan < 3000 && sessions.length) return sessions;
  lastScan = now;
  if (!cache.size) loadCache();
  const files = listFiles();
  const live = new Set(files);
  let changed = false;
  for (const f of files) {
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    const c = cache.get(f);
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) continue;
    const meta = parseMeta(f, st);
    if (meta) { cache.set(f, { mtimeMs: st.mtimeMs, size: st.size, meta }); changed = true; }
  }
  for (const k of cache.keys()) if (!live.has(k)) { cache.delete(k); changed = true; }
  if (changed) saveCacheSoon();
  const list = [];
  byId = new Map();
  for (const { meta } of cache.values()) {
    if (!meta.userTurns && !meta.assistantMsgs) continue; // empty / hook-only files
    const prev = byId.get(meta.id);
    if (prev && prev.lastTime > meta.lastTime) continue;
    byId.set(meta.id, meta);
  }
  for (const m of byId.values()) list.push(m);
  list.sort((a, b) => (b.lastTime || '').localeCompare(a.lastTime || ''));
  sessions = list;
  return sessions;
}

export function getMeta(id) {
  if (!byId.has(id)) scan(true);
  return byId.get(id) || null;
}
