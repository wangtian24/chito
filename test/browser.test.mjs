// Real-browser check of the Projects board: g p navigates there, and an old /backlog link lands on /projects.
// Uses a global Playwright install (npm root -g); skipped when there is none. SHOTS=dir saves screenshots.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let chromium = null;
try { chromium = createRequire(path.join(execSync('npm root -g').toString().trim(), 'x.js'))('playwright').chromium; } catch { }
const PORT = 20000 + Math.floor(Math.random() * 2000);
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.SHOTS;
let srv, browser, page;

before(async () => {
  if (!chromium) return;
  srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, CHITO_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error('server did not start')), 10000);
    srv.stdout.on('data', d => { if (String(d).includes(`:${PORT}`)) { clearTimeout(t); ok(); } });
  });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
});
after(async () => { await browser?.close(); srv?.kill(); });

const skip = !chromium && 'playwright is not installed globally';

test('g then p opens Projects', { skip }, async () => {
  await page.goto(BASE + '/');
  await page.waitForSelector('#list');
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => { });
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('g');
  await page.keyboard.press('p');
  await page.waitForURL(u => new URL(u).pathname === '/projects');
  await page.waitForSelector('#backlog:not([hidden]) .board-head h1');
  assert.equal((await page.textContent('#backlog .board-head h1')).trim(), 'Projects');
  assert.match(await page.textContent('.views .view-tab[data-view="backlog"]'), /^Projects/);
});

test('an old /backlog link lands on /projects', { skip }, async () => {
  await page.goto(BASE + '/backlog');
  assert.equal(new URL(page.url()).pathname, '/projects');
  await page.waitForSelector('#backlog:not([hidden]) .bl-tabs');
});

test('Overview has the open-projects list and no In flight section', { skip }, async () => {
  await page.goto(BASE + '/projects?tab=overview');
  await page.waitForSelector('.bl-open-projects');
  const h2 = await page.$$eval('#backlog .bl-h2', hs => hs.map(h => h.textContent.trim()));
  assert.ok(h2.includes('Open projects'), h2.join(','));
  assert.ok(!h2.includes('In flight'), h2.join(','));
  assert.equal(await page.locator('.bl-open-projects .bl-chev').count(), 0, 'Overview rows are read-only');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'overview.png'), fullPage: true });
});

const checked = () => page.$eval('.board-controls .seg [aria-checked="true"]', b => b.textContent.trim());
const fresh = async () => { await page.goto(BASE + '/projects?tab=overview'); await page.evaluate(() => localStorage.clear()); };

test('Projects tab defaults to every lane expanded and Open', { skip }, async () => {
  await fresh();
  await page.goto(BASE + '/projects?tab=projects');
  await page.waitForSelector('.bl-lanes .bl-chev');
  assert.equal(await page.locator('.bl-lanes .bl-chev:not(.open)').count(), 0);
  assert.equal(await checked(), 'Open');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'projects.png'), fullPage: true });
});

test('project page defaults to All, sorted by Updated newest first', { skip }, async () => {
  await fresh();
  await page.goto(BASE + '/projects/CHITO');
  await page.waitForSelector('.bl-table');
  assert.equal(await checked(), 'All');
  assert.equal(await page.getAttribute('.bl-table th.c-updated', 'aria-sort'), 'descending');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'project.png') });
});

test('Projects tab remembers collapse and filter; the project page and Overview ignore them', { skip }, async () => {
  await fresh();
  await page.goto(BASE + '/projects?tab=projects');
  await page.waitForSelector('.bl-collapse-all');
  await page.click('.bl-collapse-all');
  await page.click('.board-controls .seg button:has-text("+ 24h")');
  await page.reload();
  await page.waitForSelector('.bl-lane-compact');
  assert.equal(await page.locator('.bl-lanes .bl-chev.open').count(), 0, 'lanes stay collapsed');
  assert.equal(await checked(), '+ 24h');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'projects-remembered.png'), fullPage: true });
  await page.goto(BASE + '/projects/CHITO');
  await page.waitForSelector('.bl-table');
  assert.equal(await checked(), 'All', 'project page keeps its own filter');
  await page.goto(BASE + '/projects?tab=overview');
  await page.waitForSelector('.bl-open-projects');
  assert.equal(await page.locator('#backlog .board-controls').count(), 0, 'Overview has no controls');
  assert.equal(await page.locator('.bl-open-projects .bl-chev').count(), 0);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'overview.png'), fullPage: true });
});

test('project page remembers its filter and sort; the Projects tab ignores them', { skip }, async () => {
  await fresh();
  await page.goto(BASE + '/projects/CHITO');
  await page.waitForSelector('.bl-table');
  await page.click('.board-controls .seg button:has-text("Open")');
  await page.click('.bl-table th.c-key button');
  await page.reload();
  await page.waitForSelector('.bl-table');
  assert.equal(await checked(), 'Open');
  assert.equal(await page.getAttribute('.bl-table th.c-key', 'aria-sort'), 'ascending');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'project-remembered.png') });
  await page.goto(BASE + '/projects?tab=projects');
  await page.waitForSelector('.bl-lanes .bl-chev');
  assert.equal(await checked(), 'Open');
  assert.equal(await page.locator('.bl-lanes .bl-chev:not(.open)').count(), 0);
});

test('the board still works with storage blocked', { skip }, async () => {
  const ctx2 = await browser.newContext();
  await ctx2.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } }); });
  const p2 = await ctx2.newPage();
  const errs = []; p2.on('pageerror', e => errs.push(e.message));
  await p2.goto(BASE + '/projects/CHITO');
  await p2.waitForSelector('.bl-table');
  await p2.click('.board-controls .seg button:has-text("Open")');
  assert.equal(await p2.$eval('.board-controls .seg [aria-checked="true"]', b => b.textContent.trim()), 'Open');
  await ctx2.close();
  assert.deepEqual(errs, []);
});

test('search finds a ticket by key and Enter opens it; the session header links back to it', { skip }, async t => {
  const b = await (await fetch(BASE + '/api/backlog')).json();
  const tk = b.available && b.tickets.find(x => (x.sessions || []).some(s => s.role === 'worker' && !s.missing));
  if (!tk) return t.skip('no backlog with linked sessions here');
  const sid = tk.sessions.find(s => s.role === 'worker' && !s.missing).id;
  await page.goto(BASE + '/');
  await page.fill('#q', tk.key);
  await page.waitForSelector(`.ticket-hit[href="/projects/${tk.project}/${tk.key}"]`);
  await page.press('#q', 'Enter');
  await page.waitForURL(u => new URL(u).pathname === `/projects/${tk.project}/${tk.key}`);
  await page.waitForSelector(`#bl-drawer:not([hidden]) .bl-d-sess[href="/s/${sid}"]`);
  await page.click(`.bl-d-sess[href="/s/${sid}"]`);
  await page.waitForURL(u => new URL(u).pathname === `/s/${sid}`);
  assert.ok(await page.locator('#bl-drawer').isHidden(), 'the ticket panel closes when you leave the board');
  await page.waitForSelector(`#session-tickets .session-ticket[href="/projects/${tk.project}/${tk.key}"]`);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'session-tickets.png') });
});
