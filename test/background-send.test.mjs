// Background send: POST /send with background:true spawns a headless resume (a fake claude here) in the
// session's cwd, reports it as running, blocks a second send, and clears when the process exits.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 20000 + Math.floor(Math.random() * 2000);
const BASE = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chito-bg-'));
const ID = randomUUID();
const CWD = path.join(TMP, 'work');
const ARGS_OUT = path.join(TMP, 'args.json');
let srv;

before(async () => {
  fs.mkdirSync(CWD);
  const proj = path.join(TMP, 'projects', '-work');
  fs.mkdirSync(proj, { recursive: true });
  const ts = new Date().toISOString();
  fs.writeFileSync(path.join(proj, `${ID}.jsonl`), [
    { type: 'user', cwd: CWD, sessionId: ID, timestamp: ts, permissionMode: 'acceptEdits', message: { role: 'user', content: 'hello' } },
    { type: 'assistant', cwd: CWD, sessionId: ID, timestamp: ts, message: { id: 'm1', role: 'assistant', model: 'x', content: [{ type: 'text', text: 'hi' }] } },
  ].map(x => JSON.stringify(x)).join('\n') + '\n');
  // Fake claude: record argv and cwd, wait for a release file, then exit.
  const fake = path.join(TMP, 'fake-claude.mjs');
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(ARGS_OUT)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
console.log('fake reply');
const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(path.join(TMP, 'release'))})) { clearInterval(t); process.exit(0); } }, 50);
`, { mode: 0o755 });
  srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, CHITO_PORT: String(PORT), CHITO_PROJECTS_DIR: path.join(TMP, 'projects'), CHITO_CLAUDE_BIN: fake, CHITO_BG_LOG_DIR: path.join(TMP, 'logs'), CHITO_CLAUDE_FLAGS: '--allow-dangerously-skip-permissions' },
  });
  await new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error('server did not start')), 15000);
    srv.stdout.on('data', d => { if (String(d).includes(`:${PORT}`)) { clearTimeout(t); ok(); } });
    srv.on('exit', c => fail(new Error(`server exited ${c}`)));
  });
});
after(() => { srv?.kill(); fs.rmSync(TMP, { recursive: true, force: true }); });

const sendMsg = text => fetch(`${BASE}/api/sessions/${ID}/send`, { method: 'POST', headers: { 'x-chito': '1', 'content-type': 'application/json' }, body: JSON.stringify({ text, background: true }) });
const waitFor = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };

test('background send resumes headless in the session cwd, blocks a second send, then clears', async () => {
  const r = await sendMsg('do the thing');
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.action, 'background');
  assert.ok(j.bg.pid > 0);

  assert.ok(await waitFor(() => fs.existsSync(ARGS_OUT)), 'fake claude ran');
  const { argv, cwd } = JSON.parse(fs.readFileSync(ARGS_OUT, 'utf8'));
  assert.deepEqual(argv, ['--resume', ID, '--allow-dangerously-skip-permissions', '--permission-mode', 'acceptEdits', '-p', 'do the thing']);
  assert.equal(fs.realpathSync(cwd), fs.realpathSync(CWD));

  const meta = (await (await fetch(`${BASE}/api/sessions/${ID}`)).json()).meta;
  assert.equal(meta.bg?.pid, j.bg.pid);
  assert.match(fs.readFileSync(meta.bg.log, 'utf8'), /fake reply/);
  const listed = (await (await fetch(`${BASE}/api/sessions`)).json()).sessions.find(s => s.id === ID);
  assert.equal(listed.bg?.pid, j.bg.pid);

  const again = await sendMsg('second');
  assert.equal(again.status, 409);
  assert.match((await again.json()).error, /background send is still running/);

  fs.writeFileSync(path.join(TMP, 'release'), '');
  assert.ok(await waitFor(async () => !(await (await fetch(`${BASE}/api/sessions/${ID}`)).json()).meta.bg), 'bg cleared after exit');
});
