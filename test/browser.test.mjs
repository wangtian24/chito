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

test('Projects tab opens with every lane expanded', { skip }, async () => {
  await page.evaluate(() => localStorage.setItem('chito.blCollapsed', JSON.stringify(['CHITO'])));
  await page.goto(BASE + '/projects?tab=projects');
  await page.waitForSelector('.bl-lanes .bl-chev');
  assert.equal(await page.locator('.bl-lanes .bl-chev:not(.open)').count(), 0);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'projects.png'), fullPage: true });
  await page.click('.bl-collapse-all');
  await page.waitForSelector('.bl-lane-compact');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'projects-collapsed.png'), fullPage: true });
});

test('project page loads at /projects/<KEY>', { skip }, async () => {
  await page.goto(BASE + '/projects/CHITO');
  await page.waitForSelector('.bl-back');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'project.png') });
});
