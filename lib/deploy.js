// Deployment: where Mapcouch production stands against main.
// Everything but the run status comes from the local clone (git fetch, no API budget): merges on
// main, the prod/ release tags (the deploy history) and the `production` tag (what is live).
// The deploy workflow's runs come from GitHub, cached so an open page costs at most one call a minute.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { HOME } from './index.js';
import { ticketInfo } from './backlog.js';

export const DEPLOY_REPO = process.env.CHITO_DEPLOY_REPO || path.join(HOME, 'workspace/mapcouch');
const GH_REPO = process.env.CHITO_DEPLOY_GH || 'wangtian24/mapcouch';
const BIN = path.join(HOME, '.claude/skills/mapcouch-deploy/bin');
const DEPLOY_CMD = path.join(BIN, 'mapcouch-deploy');
const GH = fs.existsSync(path.join(BIN, 'gh-mapcouch')) ? path.join(BIN, 'gh-mapcouch') : 'gh';
// The schedule is read from the deploy workflow on origin/main each time, so it can't drift from what runs.
const WORKFLOW = '.github/workflows/deploy.yml';
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
async function deployRuns(force) {
  const active = runsCache.data?.some(r => r.status !== 'completed');
  const ttl = active ? 45000 : 5 * 60000;
  if (!force && Date.now() - runsCache.at < ttl) return runsCache;
  try {
    const out = await run(GH, ['run', 'list', '--repo', GH_REPO, '--workflow', 'deploy.yml', '-L', '5',
      '--json', 'databaseId,status,conclusion,createdAt,updatedAt,url,event,headSha'], { timeout: 20000 });
    runsCache = { at: Date.now(), data: JSON.parse(out), error: null };
  } catch (e) {
    runsCache = { at: Date.now(), data: runsCache.data, error: (e.stderr || e.message).split('\n').filter(l => !/^gh-mapcouch:/.test(l)).join(' ').trim().slice(0, 200) };
  }
  return runsCache;
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

// The workflow's `schedule:` crons and their timezone (GitHub's cron timezone option; UTC without one).
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
  const [logOut, tagOut, prodOut, runs, ymlOut] = await Promise.all([
    git(['log', '--first-parent', '-n', String(LIMIT), '--format=%H%x1f%cI%x1f%an%x1f%s', 'origin/main']),
    git(['for-each-ref', '--sort=-creatordate', '--format=%(refname:short)%1f%(*objectname)%1f%(objectname)%1f%(creatordate:iso-strict)', 'refs/tags/prod/']),
    git(['rev-parse', '--verify', '-q', 'production^{commit}']).catch(() => ''),
    deployRuns(refresh),
    git(['show', `origin/main:${WORKFLOW}`]).catch(() => ''),
  ]);
  const sched = parseSchedule(ymlOut);
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
    next: nextScheduled(sched),
    backup: { ...backup, enabled: BACKUP_ON, afterMinutes: BACKUP_AFTER_MIN },
    schedule: { ...sched, text: describeSchedule(sched) },
    fetchedAt: lastFetch ? new Date(lastFetch).toISOString() : null,
  };
}

let starting = null;
// Starts the deploy workflow for main (the same thing /mapcouch-deploy does) and returns at once.
export async function triggerDeploy() {
  if (starting) throw new Error('A deploy is already being started');
  if (!fs.existsSync(DEPLOY_CMD)) throw new Error(`No deploy script at ${DEPLOY_CMD}`);
  starting = true;   // set before any await, so two quick POSTs can't both start one
  try {
    const cur = await deployRuns(true);
    const active = cur.data?.find(r => r.status !== 'completed');
    if (active) throw Object.assign(new Error(`A deploy is already running: ${active.url}`), { plain: true });
    const out = await run(DEPLOY_CMD, ['deploy', 'main'], { timeout: 90000 });
    runsCache.at = 0;
    return { out: out.trim(), url: (out.match(/https:\/\/github\.com\/\S+\/actions\/runs\/\d+/) || [])[0] || null };
  } catch (e) {
    if (e.plain) throw e;
    throw new Error((e.stderr || e.message).trim().split('\n').slice(-3).join(' '));
  } finally { starting = null; }
}

// ---- backup for GitHub's schedule ----
// GitHub runs scheduled workflows best-effort and often skips them silently. So chito checks 30 minutes after
// each scheduled slot: if no deploy run of any kind has started since that slot, and main has merges production
// doesn't, it starts one (the same as pressing Deploy main). One try per slot. CHITO_DEPLOY_BACKUP=0 turns it off.
const BACKUP_ON = process.env.CHITO_DEPLOY_BACKUP !== '0';
const BACKUP_AFTER_MIN = 30;
const backup = { lastCheck: null, lastSlot: null, lastAction: null, lastAt: null, lastUrl: null, lastError: null };
export function backupDecision({ slot, now, runs, mainSha, prodSha }) {
  if (!slot) return { act: false, why: 'no schedule' };
  if (now - new Date(slot) < BACKUP_AFTER_MIN * 60000) return { act: false, why: 'too early' };
  if (runs.some(r => r.status !== 'completed')) return { act: false, why: 'a deploy is running' };
  if (runs.some(r => new Date(r.createdAt) >= new Date(slot))) return { act: false, why: 'a deploy ran since the slot' };
  if (!mainSha || mainSha === prodSha) return { act: false, why: 'main is already live' };
  return { act: true, why: 'the scheduled run never started' };
}
async function backupTick() {
  try {
    const ymlOut = await git(['show', `origin/main:${WORKFLOW}`]).catch(() => '');
    const slot = prevScheduled(parseSchedule(ymlOut));
    if (!slot || slot === backup.lastSlot || Date.now() - new Date(slot) < BACKUP_AFTER_MIN * 60000) return;
    backup.lastSlot = slot;   // one decision per slot, whatever it is
    await fetchOrigin(true);
    const [mainSha, prodSha, runs] = await Promise.all([
      git(['rev-parse', 'origin/main']).then(x => x.trim()).catch(() => ''),
      git(['rev-parse', '--verify', '-q', 'production^{commit}']).then(x => x.trim()).catch(() => ''),
      deployRuns(true),
    ]);
    if (!runs.data) { backup.lastError = runs.error || 'no run list from GitHub'; return; }
    const d = backupDecision({ slot, now: Date.now(), runs: runs.data, mainSha, prodSha });
    backup.lastCheck = new Date().toISOString();
    backup.lastAction = d.act ? 'started' : `skipped: ${d.why}`;
    backup.lastAt = backup.lastCheck; backup.lastError = null; backup.lastUrl = null;
    if (d.act) {
      const r = await triggerDeploy();
      backup.lastUrl = r.url;
      console.log(`[chito] deploy backup: the ${slot} scheduled run never started; started one (${r.url || 'no url'})`);
    }
  } catch (e) {
    backup.lastError = e.message.slice(0, 200);
    console.error('[chito] deploy backup:', e.message);
  }
}
export function startDeployBackup() {
  if (!BACKUP_ON || !fs.existsSync(path.join(DEPLOY_REPO, '.git'))) return;
  setInterval(backupTick, 60000);
}
