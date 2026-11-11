// cito — local web UI for Claude Code sessions.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scan, getMeta, HOME, PROJECTS_DIR } from './lib/index.js';
import { loadTranscript } from './lib/transcript.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CITO_PORT || 8791);
const HOST = process.env.CITO_HOST || '127.0.0.1';
const TERMINAL = process.env.CITO_TERMINAL || (fs.existsSync('/Applications/iTerm.app') ? 'iterm' : 'terminal');
const CLAUDE_FLAGS = process.env.CITO_CLAUDE_FLAGS ?? '--allow-dangerously-skip-permissions';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATIC = {
  '/app.js': ['public/app.js', 'text/javascript'],
  '/style.css': ['public/style.css', 'text/css'],
  '/favicon.svg': ['public/favicon.svg', 'image/svg+xml'],
  '/vendor/marked.js': ['node_modules/marked/lib/marked.esm.js', 'text/javascript'],
  '/vendor/purify.js': ['node_modules/dompurify/dist/purify.es.mjs', 'text/javascript'],
};

const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

function resumeCommand(meta, prompt) {
  const dir = meta.cwd && fs.existsSync(meta.cwd) ? meta.cwd : HOME;
  return `cd ${shq(dir)} && claude --resume ${meta.id}${CLAUDE_FLAGS ? ' ' + CLAUDE_FLAGS : ''}${prompt ? ' ' + shq(prompt) : ''}`;
}

function readBody(req, limit = 200_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > limit) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Live sessions: Claude Code writes ~/.claude/sessions/<pid>.json for each running CLI.
const LIVE_DIR = path.join(HOME, '.claude', 'sessions');
function liveSessions() {
  const out = new Map();
  let files = [];
  try { files = fs.readdirSync(LIVE_DIR).filter(f => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(LIVE_DIR, f), 'utf8'));
      if (!d.sessionId || !d.pid) continue;
      try { process.kill(d.pid, 0); } catch (e) { if (e.code === 'ESRCH') continue; }
      const prev = out.get(d.sessionId);
      if (!prev || (d.updatedAt || 0) > (prev.updatedAt || 0)) out.set(d.sessionId, { pid: d.pid, status: d.status || null, updatedAt: d.updatedAt || 0 });
    } catch { }
  }
  return out;
}

const run = (cmd, args) => new Promise((resolve, reject) =>
  execFile(cmd, args, (err, stdout, stderr) => err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout.trim())));

const FOCUS_ITERM = [
  'on run argv',
  'set target to item 1 of argv',
  'tell application "iTerm"',
  'repeat with w in windows',
  'repeat with t in tabs of w',
  'repeat with s in sessions of t',
  'if tty of s is target then',
  'select w',
  'tell t to select',
  'tell s to select',
  'if (count of argv) > 1 then tell s to write text (item 2 of argv)',
  'activate',
  'return "found"',
  'end if',
  'end repeat',
  'end repeat',
  'end repeat',
  'end tell',
  'return "missing"',
  'end run',
];

// If the session is already running, focus its iTerm window/tab/pane (and optionally type a message).
async function focusExisting(id, text) {
  const live = liveSessions().get(id);
  if (!live) return null;
  const tty = await run('ps', ['-o', 'tty=', '-p', String(live.pid)]).catch(() => '');
  if (!tty || tty === '??') return { state: 'running-elsewhere', pid: live.pid };
  if (TERMINAL === 'iterm') {
    const argv = ['--', `/dev/${tty}`].concat(text != null ? [text] : []);
    const r = await run('osascript', FOCUS_ITERM.flatMap(l => ['-e', l]).concat(argv)).catch(() => 'missing');
    if (r === 'found') return { state: 'focused', pid: live.pid, tty };
  }
  return { state: 'running-elsewhere', pid: live.pid, tty };
}

function openInTerminal(cmd) {
  const scripts = {
    iterm: [
      'on run argv',
      'tell application "iTerm"',
      'activate',
      'set w to (create window with default profile)',
      'tell current session of w to write text (item 1 of argv)',
      'end tell',
      'end run',
    ],
    terminal: [
      'on run argv',
      'tell application "Terminal"',
      'activate',
      'do script (item 1 of argv)',
      'end tell',
      'end run',
    ],
  };
  const lines = scripts[TERMINAL] || scripts.terminal;
  const args = lines.flatMap(l => ['-e', l]).concat(['--', cmd]);
  return new Promise((resolve, reject) => execFile('osascript', args, (err, _o, stderr) => err ? reject(new Error(stderr || err.message)) : resolve()));
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const buf = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(buf);
}

function listItem(m) {
  return {
    id: m.id, title: m.title, customTitle: m.customTitle, aiTitle: m.aiTitle, project: m.project, cwd: m.cwd,
    gitBranch: m.gitBranch, startTime: m.startTime, lastTime: m.lastTime, userTurns: m.userTurns,
    firstPrompt: m.firstPrompt ? m.firstPrompt.slice(0, 200) : null, agent: m.agent, prCount: m.prLinks.length,
    subagents: m.subagents, size: m.size,
  };
}

const server = http.createServer(async (req, res) => {
  // Guard against DNS rebinding: only answer requests addressed to localhost.
  const host = (req.headers.host || '').split(':')[0];
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return send(res, 403, { error: 'forbidden host' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (p === '/' || p.startsWith('/s/')) {
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'public/index.html')), 'text/html; charset=utf-8');
    }
    if (STATIC[p]) {
      const [file, type] = STATIC[p];
      return send(res, 200, fs.readFileSync(path.join(ROOT, file)), type);
    }
    if (p === '/api/sessions' && req.method === 'GET') {
      const list = scan();
      const live = liveSessions();
      return send(res, 200, {
        sessions: list.map(m => ({ ...listItem(m), live: live.get(m.id) || null })),
        projectsDir: PROJECTS_DIR, terminal: TERMINAL,
      });
    }
    if (p === '/api/outcomes' && req.method === 'GET') {
      const ids = (url.searchParams.get('ids') || '').split(',').filter(x => UUID_RE.test(x)).slice(0, 50);
      const out = {};
      for (const id of ids) {
        const meta = getMeta(id);
        if (meta) out[id] = { lastPrompt: meta.lastPrompt, lastAnswer: meta.lastAnswer };
      }
      return send(res, 200, out);
    }
    let m = p.match(/^\/api\/sessions\/([^/]+)(\/open|\/send)?$/);
    if (m) {
      const id = m[1];
      if (!UUID_RE.test(id)) return send(res, 400, { error: 'bad id' });
      const meta = getMeta(id);
      if (!meta) return send(res, 404, { error: 'not found' });
      if (m[2] === '/send') {
        if (req.method !== 'POST' || req.headers['x-cito'] !== '1') return send(res, 405, { error: 'POST with x-cito header required' });
        let text = '';
        try { text = String(JSON.parse(await readBody(req)).text || '').trim(); } catch { return send(res, 400, { error: 'bad body' }); }
        if (!text) return send(res, 400, { error: 'empty message' });
        // A typed newline would submit early in the live TUI, so flatten for that path.
        const existing = await focusExisting(id, text.replace(/\s*\n\s*/g, ' '));
        if (existing?.state === 'focused') return send(res, 200, { ok: true, action: 'typed', terminal: TERMINAL, ...existing });
        if (existing?.state === 'running-elsewhere') return send(res, 409, { error: `already running (pid ${existing.pid}${existing.tty ? ', ' + existing.tty : ''}) outside ${TERMINAL}` });
        await openInTerminal(resumeCommand(meta, text));
        return send(res, 200, { ok: true, action: 'resumed', terminal: TERMINAL });
      }
      if (m[2]) {
        // Custom header forces a CORS preflight, so other sites can't trigger this.
        if (req.method !== 'POST' || req.headers['x-cito'] !== '1') return send(res, 405, { error: 'POST with x-cito header required' });
        const cmd = resumeCommand(meta);
        const existing = await focusExisting(id);
        if (existing?.state === 'focused') return send(res, 200, { ok: true, action: 'focused', terminal: TERMINAL, ...existing });
        // Resuming a session that is live in another process would fork it; refuse instead.
        if (existing?.state === 'running-elsewhere') return send(res, 409, { error: `already running (pid ${existing.pid}${existing.tty ? ', ' + existing.tty : ''}) outside ${TERMINAL}` });
        await openInTerminal(cmd);
        return send(res, 200, { ok: true, action: 'opened', command: cmd, terminal: TERMINAL });
      }
      const items = loadTranscript(meta.file);
      const live = liveSessions().get(id) || null;
      return send(res, 200, { meta: { ...meta, live, resumeCommand: resumeCommand(meta), cwdExists: !!meta.cwd && fs.existsSync(meta.cwd) }, items });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[cito]', e);
    send(res, 500, { error: e.message });
  }
});

const t0 = Date.now();
const n = scan(true).length;
console.log(`[cito] indexed ${n} sessions in ${Date.now() - t0}ms from ${PROJECTS_DIR}`);
server.listen(PORT, HOST, () => console.log(`[cito] http://localhost:${PORT}`));
