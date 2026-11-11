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

function resumeCommand(meta) {
  const dir = meta.cwd && fs.existsSync(meta.cwd) ? meta.cwd : HOME;
  return `cd ${shq(dir)} && claude --resume ${meta.id}${CLAUDE_FLAGS ? ' ' + CLAUDE_FLAGS : ''}`;
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
      return send(res, 200, { sessions: list.map(listItem), projectsDir: PROJECTS_DIR, terminal: TERMINAL });
    }
    let m = p.match(/^\/api\/sessions\/([^/]+)(\/open)?$/);
    if (m) {
      const id = m[1];
      if (!UUID_RE.test(id)) return send(res, 400, { error: 'bad id' });
      const meta = getMeta(id);
      if (!meta) return send(res, 404, { error: 'not found' });
      if (m[2]) {
        // Custom header forces a CORS preflight, so other sites can't trigger this.
        if (req.method !== 'POST' || req.headers['x-cito'] !== '1') return send(res, 405, { error: 'POST with x-cito header required' });
        const cmd = resumeCommand(meta);
        await openInTerminal(cmd);
        return send(res, 200, { ok: true, command: cmd, terminal: TERMINAL });
      }
      const items = loadTranscript(meta.file);
      return send(res, 200, { meta: { ...meta, resumeCommand: resumeCommand(meta), cwdExists: !!meta.cwd && fs.existsSync(meta.cwd) }, items });
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
