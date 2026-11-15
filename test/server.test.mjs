// Starts chito on a spare port and checks the board's URLs: /projects is served, old /backlog links redirect.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 18000 + Math.floor(Math.random() * 2000);
const BASE = `http://localhost:${PORT}`;
let srv;

before(async () => {
  srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, CHITO_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error('server did not start')), 10000);
    srv.stdout.on('data', d => { if (String(d).includes(`:${PORT}`)) { clearTimeout(t); ok(); } });
    srv.on('exit', c => fail(new Error(`server exited ${c}`)));
  });
});
after(() => srv?.kill());

const get = p => fetch(BASE + p, { redirect: 'manual' });

test('/projects and project pages serve the app', async () => {
  for (const p of ['/projects', '/projects/CHITO', '/projects/CHITO/CHITO-8']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    assert.match(await r.text(), /<a class="view-tab" href="\/projects" data-view="backlog">(<span data-i18n>)?Projects/);
  }
});

test('old /backlog URLs redirect to /projects, keeping the path and query', async () => {
  const cases = [['/backlog', '/projects'], ['/backlog/CHITO', '/projects/CHITO'], ['/backlog/CHITO/CHITO-8', '/projects/CHITO/CHITO-8'], ['/backlog?tab=projects', '/projects?tab=projects']];
  for (const [from, to] of cases) {
    const r = await get(from);
    assert.equal(r.status, 301, from);
    assert.equal(r.headers.get('location'), to, from);
  }
});

test('the Keys help lists g p', async () => {
  const html = await (await get('/projects')).text();
  assert.match(html, /<kbd>g<\/kbd> <kbd>p<\/kbd><\/div><div[^>]*>Projects/);
});

test('keys.js is served', async () => {
  const r = await get('/keys.js');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /javascript/);
});

// Tickets in search and on sessions. These read the real backlog DB and transcripts, so they skip when there is none.
async function linkedTicket() {
  const b = await (await get('/api/backlog')).json();
  if (!b.available) return null;
  for (const tk of b.tickets) {
    const s = (tk.sessions || []).find(x => x.role === 'worker' && !x.missing);
    if (s) return { tk, sid: s.id };
  }
  return null;
}

test('ticket search finds a key exactly, then by title words', async t => {
  const hit = await linkedTicket();
  if (!hit) return t.skip('no backlog with linked sessions here');
  const { tk } = hit;
  const byKey = await (await get(`/api/backlog/search?q=${encodeURIComponent(tk.key.toLowerCase())}`)).json();
  assert.equal(byKey.tickets[0].key, tk.key);
  assert.equal(byKey.tickets[0].exact, true);
  assert.equal(byKey.tickets[0].project, tk.project);
  const words = tk.title.split(/\s+/).filter(w => w.length > 3).slice(0, 2).join(' ');
  if (words) {
    const byTitle = await (await get(`/api/backlog/search?q=${encodeURIComponent(words)}`)).json();
    assert.ok(byTitle.tickets.length <= 8);
    assert.ok(byTitle.tickets.every(x => (x.key + ' ' + x.title).toLowerCase().includes(words.split(' ')[0].toLowerCase())));
  }
  assert.deepEqual((await (await get('/api/backlog/search?q=')).json()).tickets, []);
});

test('a session lists the tickets it is linked to', async t => {
  const hit = await linkedTicket();
  if (!hit) return t.skip('no backlog with linked sessions here');
  const s = await (await get(`/api/sessions/${hit.sid}`)).json();
  const mine = s.meta.tickets.find(x => x.key === hit.tk.key);
  assert.ok(mine, `session ${hit.sid} should link ${hit.tk.key}`);
  assert.equal(mine.project, hit.tk.project);
  assert.ok(['worker', 'created', 'touched', 'mentioned'].includes(mine.role));
});
