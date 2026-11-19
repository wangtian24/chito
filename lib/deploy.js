// Deployment: where Mapcouch production stands against main.
// Everything but the run status comes from the local clone (git fetch, no API budget): merges on
// main, the prod/ release tags (the deploy history) and the `production` tag (what is live).
// Deploys run on this laptop (skill mapcouch-local-deploy): chito starts the script detached, and each run
// leaves a record (<id>.json) and a log (<id>.log) in RUNS, which this page lists. No GitHub Actions minutes.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { HOME } from './index.js';
import { ticketInfo } from './backlog.js';

export const DEPLOY_REPO = process.env.CHITO_DEPLOY_REPO || path.join(HOME, 'workspace/mapcouch');
const GH_REPO = process.env.CHITO_DEPLOY_GH || 'wangtian24/mapcouch';
const DEPLOY_CMD = process.env.CHITO_DEPLOY_CMD || path.join(HOME, '.claude/skills/mapcouch-local-deploy/bin/mapcouch-local-deploy');
export const RUNS = process.env.MAPCOUCH_DEPLOY_RUNS || path.join(HOME, '.local/state/mapcouch-deploy/runs');
const LIMIT = 120;

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) =>
  execFile(cmd, args, { maxBuffer: 8 << 20, timeout: 60000, ...opts }, (err, stdout, stderr) =>
    err ? reject(Object.assign(err, { stderr: String(stderr || '') })) : resolve(String(stdout))));
const git = args => run('git', ['-C', DEPLOY_REPO, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes' } });

let lastFetch = 0, fetching = null;
function fetchOrigin(force) {
  if (fetching) return fetching;
  if (!force && Date.now() - lastFetch < 60000) return Promise.resolve();
  fetching = git(['-c', 'credential.helper=', '-c', "credential.helper=!gh auth git-credential", 'fetch', '-q', '--tags', '--force', 'origin', 'main'])
    .catch(e => console.error('[chito] deploy fetch:', e.stderr || e.message))
    .finally(() => { lastFetch = Date.now(); fetching = null; });
  return fetching;
}

let runsCache = { at: 0, data: null, error: null };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// The last local runs, newest first, in the shape the page used for GitHub runs (url = the run's log here).
export function localRuns(limit = 5) {
  let files = [];
  try { files = fs.readdirSync(RUNS).filter(f => f.endsWith('.json')).sort().reverse().slice(0, limit * 3); } catch { return []; }
  return files.map(f => {
    let r; try { r = JSON.parse(fs.readFileSync(path.join(RUNS, f), 'utf8')); } catch { return null; }
    if (!r?.databaseId || !r.status) return null;   // only run records (release notes live in notes/)
    // A run whose process died without finishing its record (reboot, kill -9) counts as failed.
    if (r.status !== 'completed' && r.pid && !alive(r.pid)) r = { ...r, status: 'completed', conclusion: 'failure', summary: r.summary || `stopped at: ${r.step || 'start'}` };
    return { ...r, url: `/api/deploy/log?id=${encodeURIComponent(r.databaseId)}` };
  }).filter(Boolean).slice(0, limit);
}
async function deployRuns() {
  runsCache = { at: Date.now(), data: localRuns(), error: null };
  return runsCache;
}
export function runLog(id) {
  if (!/^[\w.-]+$/.test(id || '')) return null;
  try { return fs.readFileSync(path.join(RUNS, `${id}.log`), 'utf8'); } catch { return null; }
}

// One cron field ("*", "5", "1,2,10", "9-17", "*/2", "8-20/4") as the set of values it allows.
function cronField(f, lo, hi) {
  const out = new Set();
  for (const part of String(f).split(',')) {
    const [range, stepS] = part.split('/');
    const step = stepS ? Number(stepS) : 1;
    let [a, b] = range === '*' ? [lo, hi] : range.split('-').map(Number);
    if (b === undefined) b = stepS ? hi : a;
    if (!Number.isInteger(a) || !Number.isInteger(b) || !(step > 0)) return null;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

// A workflow's `schedule:` crons and their timezone (kept for reading GitHub-style schedules).
export function parseSchedule(yml) {
  const crons = [...String(yml).matchAll(/^\s*-\s*cron:\s*['"]([^'"]+)['"]/gm)].map(m => m[1].trim());
  const tz = (String(yml).match(/^\s*timezone:\s*['"]?([\w/+-]+)['"]?/m) || [])[1] || 'UTC';
  return { crons, tz };
}

// A test for "does this minute match any of the crons?" in their timezone; null when none parse.
function scheduleMatcher(sched) {
  const parsed = (sched?.crons || []).map(c => {
    const f = c.split(/\s+/);
    if (f.length !== 5) return null;
    const m = { min: cronField(f[0], 0, 59), hour: cronField(f[1], 0, 23), dom: cronField(f[2], 1, 31), mon: cronField(f[3], 1, 12), dow: cronField(f[4], 0, 7) };
    return Object.values(m).every(Boolean) ? m : null;
  }).filter(Boolean);
  if (!parsed.length) return null;
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: sched.tz, hour: 'numeric', minute: 'numeric', day: 'numeric', month: 'numeric', weekday: 'short', hourCycle: 'h23' });
  const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return t => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map(x => [x.type, x.value]));
    const v = { min: +p.minute, hour: +p.hour, dom: +p.day, mon: +p.month, dow: DOW[p.weekday] };
    return parsed.some(c => c.min.has(v.min) && c.hour.has(v.hour) && c.dom.has(v.dom) && c.mon.has(v.mon) && (c.dow.has(v.dow) || (v.dow === 0 && c.dow.has(7))));
  };
}
// The next scheduled minute after `now`.
export function nextScheduled(sched, now = new Date()) {
  const hit = scheduleMatcher(sched); if (!hit) return null;
  const start = Math.floor(now.getTime() / 60000) * 60000 + 60000;
  for (let t = start; t < start + 8 * 86400000; t += 60000) if (hit(t)) return new Date(t).toISOString();
  return null;
}
// The latest scheduled minute at or before `now`.
export function prevScheduled(sched, now = new Date()) {
  const hit = scheduleMatcher(sched); if (!hit) return null;
  const start = Math.floor(now.getTime() / 60000) * 60000;
  for (let t = start; t > start - 8 * 86400000; t -= 60000) if (hit(t)) return new Date(t).toISOString();
  return null;
}

// Plain words for the schedule: "every hour", "at 1, 2, 10 … (America/Los_Angeles)", or the raw cron.
function describeSchedule(sched) {
  if (!sched?.crons?.length) return null;
  if (sched.crons.length === 1) {
    const [mi, hr, dom, mon, dow] = sched.crons[0].split(/\s+/);
    if (dom === '*' && mon === '*' && dow === '*' && /^\d+$/.test(mi)) {
      if (hr === '*') return mi === '0' ? 'every hour' : `every hour at :${mi.padStart(2, '0')}`;
      const m = hr.match(/^\*\/(\d+)$/); if (m) return `every ${m[1]} hours`;
    }
  }
  return sched.crons.join('; ');
}

const TICKET_RE = /\b[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)+-\d+\b/g;   // MC-LAYERS-24, MC-MCP-PERF-4
function parseSubject(s) {
  const pr = s.match(/\(#(\d+)\)\s*$/);
  const tickets = [...new Set(s.match(TICKET_RE) || [])];
  let title = s.replace(/\s*\(#\d+\)\s*$/, '');
  for (const k of tickets) title = title.replace(new RegExp(`\\s*\\(${k}\\)`), '');
  return { title: title.trim(), pr: pr ? Number(pr[1]) : null, tickets };
}

export async function deploySummary({ refresh = false } = {}) {
  if (!fs.existsSync(path.join(DEPLOY_REPO, '.git'))) return { error: `No clone at ${DEPLOY_REPO}` };
  if (refresh) await fetchOrigin(true); else fetchOrigin(false);   // a normal poll serves what's local and fetches behind it
  const [logOut, tagOut, prodOut, runs] = await Promise.all([
    git(['log', '--first-parent', '-n', String(LIMIT), '--format=%H%x1f%cI%x1f%an%x1f%s', 'origin/main']),
    git(['for-each-ref', '--sort=-creatordate', '--format=%(refname:short)%1f%(*objectname)%1f%(objectname)%1f%(creatordate:iso-strict)', 'refs/tags/prod/']),
    git(['rev-parse', '--verify', '-q', 'production^{commit}']).catch(() => ''),
    deployRuns(refresh),
  ]);
  const sched = SCHEDULE, pause = schedulePause();
  const commits = logOut.trim().split('\n').filter(Boolean).map(l => {
    const [sha, at, author, subject] = l.split('\x1f');
    return { sha, at, author, subject, ...parseSubject(subject) };
  });
  const releases = tagOut.trim().split('\n').filter(Boolean).map(l => {
    const [tag, peeled, obj, at] = l.split('\x1f');
    return { tag, sha: peeled || obj, at };
  });
  const production = prodOut.trim() || null;

  // Each release sits on the commit it shipped; a commit shipped by several (redeploys) keeps the newest.
  const relBySha = new Map();
  for (const r of releases) if (!relBySha.has(r.sha)) relBySha.set(r.sha, { tag: r.tag, at: r.at, redeploys: 0 });
  else relBySha.get(r.sha).redeploys++;
  for (const c of commits) { const r = relBySha.get(c.sha); if (r) c.release = r; }

  const liveIdx = production ? commits.findIndex(c => c.sha === production) : -1;
  const keys = [...new Set(commits.flatMap(c => c.tickets))];
  const info = await ticketInfo(keys).catch(() => new Map());
  for (const c of commits) c.tickets = c.tickets.map(k => ({ key: k, ...(info.get(k) || {}) }));

  const list = runs.data || [];
  const current = list.find(r => r.status !== 'completed') || null;
  const last = list.find(r => r.status === 'completed') || null;
  // Live outside the window (or unknown): count exactly with git rather than report the window size.
  let waiting = liveIdx;
  if (liveIdx < 0) waiting = production ? Number((await git(['rev-list', '--first-parent', '--count', `${production}..origin/main`]).catch(() => '')).trim()) || null : null;
  return {
    repo: GH_REPO,
    head: commits[0]?.sha || null,
    production,
    live: liveIdx >= 0 ? commits[liveIdx].release || relBySha.get(production) || null : relBySha.get(production) || null,
    liveInWindow: liveIdx >= 0,
    waiting,
    commits,
    releaseCount: releases.length,
    run: current, lastRun: last, runsError: runs.error, runsAt: runs.at ? new Date(runs.at).toISOString() : null,
    next: pause.paused ? null : nextScheduled(sched),
    auto: { ...auto, ...pause },
    schedule: { ...sched, text: describeSchedule(sched) },
    fetchedAt: lastFetch ? new Date(lastFetch).toISOString() : null,
  };
}

let starting = null;
// Starts a local deploy of main (or `target`) detached from chito, and returns at once with its run id.
export async function triggerDeploy({ target = 'main' } = {}) {
  if (starting) throw new Error('A deploy is already being started');
  if (!fs.existsSync(DEPLOY_CMD)) throw new Error(`No deploy script at ${DEPLOY_CMD}`);
  if (!/^[\w./-]+$/.test(target)) throw new Error('bad target');
  starting = true;
  try {
    const active = localRuns().find(r => r.status !== 'completed');
    if (active) throw new Error(`A deploy is already running (${active.databaseId})`);
    fs.mkdirSync(RUNS, { recursive: true });
    const id = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-chito`;
    const log = fs.openSync(path.join(RUNS, `${id}.log`), 'a');
    const child = spawn(DEPLOY_CMD, ['deploy', target, '--run-id', id], {
      detached: true, stdio: ['ignore', log, log], cwd: HOME,
      env: { ...process.env, MAPCOUCH_DEPLOY_LOGGED: '1', MAPCOUCH_DEPLOY_RUNS: RUNS },
    });
    child.unref(); fs.closeSync(log);
    return { id, url: `/api/deploy/log?id=${id}` };
  } finally { starting = null; }
}

// ---- chito's own deploy schedule ----
// Deploys run on this laptop, so chito keeps the schedule (GitHub's cron went away with its minutes, 2026-11-16).
// At each slot, if main has merges production doesn't and no deploy is running or has started since the slot,
// chito starts one (the same as pressing Deploy main). One decision per slot; a slot missed while the laptop
// slept is caught up once on wake. A commit whose last run failed isn't retried until main moves.
//   CHITO_DEPLOY_CRON  a 5-field cron, default "0 * * * *" (every hour); "off" turns the schedule off
//   CHITO_DEPLOY_TZ    its timezone, default America/Los_Angeles
const CRON = (process.env.CHITO_DEPLOY_CRON ?? '0 * * * *').trim();
export const SCHEDULE = /^(off|none|0|)$/i.test(CRON) ? { crons: [], tz: 'UTC' }
  : { crons: [CRON], tz: process.env.CHITO_DEPLOY_TZ || 'America/Los_Angeles' };
const auto = { enabled: SCHEDULE.crons.length > 0, lastSlot: null, lastAction: null, lastAt: null, lastUrl: null, lastError: null };
// Pausing the schedule (the page's Pause button) survives restarts. Slots that pass while paused are skipped, not caught up.
const PAUSE_FILE = process.env.CHITO_DEPLOY_PAUSE_FILE || path.join(HOME, '.local/state/chito/deploy-schedule.json');
export function schedulePause() {
  try { const j = JSON.parse(fs.readFileSync(PAUSE_FILE, 'utf8')); return j?.paused ? { paused: true, pausedAt: j.pausedAt || null } : { paused: false }; }
  catch { return { paused: false }; }
}
export function setSchedulePaused(paused) {
  fs.mkdirSync(path.dirname(PAUSE_FILE), { recursive: true });
  fs.writeFileSync(PAUSE_FILE, JSON.stringify(paused ? { paused: true, pausedAt: new Date().toISOString() } : { paused: false }) + '\n');
  if (!paused) auto.lastSlot = prevScheduled(SCHEDULE) || auto.lastSlot;   // resuming never catches up a slot that passed while paused
  return schedulePause();
}
export function scheduleDecision({ slot, runs, mainSha, prodSha }) {
  if (!slot) return { act: false, why: 'no schedule' };
  if (runs.some(r => r.status !== 'completed')) return { act: false, why: 'a deploy is running' };
  if (runs.some(r => new Date(r.createdAt) >= new Date(slot))) return { act: false, why: 'a deploy ran since the slot' };
  if (!mainSha || mainSha === prodSha) return { act: false, why: 'main is already live' };
  const last = runs.find(r => r.status === 'completed');
  if (last && last.conclusion !== 'success' && last.headSha === mainSha) return { act: false, why: 'the last run of this commit failed' };
  return { act: true, why: 'main has something new' };
}
async function scheduleTick() {
  try {
    const slot = prevScheduled(SCHEDULE);
    if (!slot || slot === auto.lastSlot) return;
    auto.lastSlot = slot;   // one decision per slot, whatever it is
    if (schedulePause().paused) { auto.lastAt = new Date().toISOString(); auto.lastAction = 'skipped: paused'; auto.lastError = null; auto.lastUrl = null; return; }
    await fetchOrigin(true);
    const [mainSha, prodSha] = await Promise.all([
      git(['rev-parse', 'origin/main']).then(x => x.trim()).catch(() => ''),
      git(['rev-parse', '--verify', '-q', 'production^{commit}']).then(x => x.trim()).catch(() => ''),
    ]);
    const d = scheduleDecision({ slot, runs: localRuns(), mainSha, prodSha });
    auto.lastAt = new Date().toISOString();
    auto.lastAction = d.act ? 'started' : `skipped: ${d.why}`;
    auto.lastError = null; auto.lastUrl = null;
    if (d.act && schedulePause().paused) { auto.lastAction = 'skipped: paused'; return; }   // paused while this check was fetching
    if (d.act) {
      const r = await triggerDeploy();
      auto.lastUrl = r.url;
      console.log(`[chito] scheduled deploy for ${slot}: started ${r.id}`);
    }
  } catch (e) {
    auto.lastError = e.message.slice(0, 200);
    console.error('[chito] scheduled deploy:', e.message);
  }
}
export function startDeploySchedule() {
  if (!auto.enabled || !fs.existsSync(path.join(DEPLOY_REPO, '.git'))) return;
  setInterval(scheduleTick, 60000);
}
