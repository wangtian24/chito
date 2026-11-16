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
// The workflow's cron (.github/workflows/deploy.yml), in Pacific time.
const SCHEDULE_HOURS = [1, 2, 10, 12, 16, 20, 21, 22, 23];
const TZ = 'America/Los_Angeles';
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

// The next scheduled run after `now`: the first listed Pacific hour still ahead.
export function nextScheduled(now = new Date()) {
  for (let h = 0; h < 49; h++) {
    const t = new Date(Math.ceil(now.getTime() / 3600000) * 3600000 + h * 3600000);
    if (t <= now) continue;
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
      .formatToParts(t).map(p => [p.type, p.value]));
    // Hours are whole in every US zone, so an on-the-hour UTC instant is on the hour in Pacific time.
    if (Number(parts.minute) === 0 && SCHEDULE_HOURS.includes(Number(parts.hour))) return t.toISOString();
  }
  return null;
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
    next: nextScheduled(),
    schedule: { hours: SCHEDULE_HOURS, tz: TZ },
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
