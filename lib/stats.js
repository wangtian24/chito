// Stats for the Projects → Stats tab: per-ticket timelines rebuilt from the backlog event log (queue, work and
// review intervals, bounces and failures, who claimed it and on what model), plus every Claude session's
// estimated spend. The page filters and aggregates these on the client, so this only shapes the raw facts.
import fs from 'node:fs';
import { scan } from './index.js';
import { BACKLOG_DB } from './backlog.js';
import { costOf, mergeUsage } from './pricing.js';

const json = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const STATE_RE = /^(\w+) → (\w+)(?::\s*(.*))?/s;
const TICKET_RE = /^# Backlog ticket (\S+?):/m;
const ORCH_RE = /^# Backlog orchestrator for (\S+?):/m;

// Why a ticket went back from in_progress to todo, in a few buckets.
export function bounceReason(body) {
  const b = (body || '').toLowerCase();
  if (/green|main (is |still )?red|ci (is )?red/.test(b)) return 'waiting for green main';
  if (/orchestrator exited/.test(b)) return 'orchestrator exited';
  if (/worker exited|exited \(\d+\)|without reporting/.test(b)) return 'worker exited';
  if (/quota|rate limit|usage limit|limit reached/.test(b)) return 'quota';
  if (/blocker/.test(b)) return 'new blocker';
  if (/parked|pr ready/.test(b)) return 'parked';
  if (/daemon stopped|project paused|paused/.test(b)) return 'paused';
  if (/lease|expired|stale|heartbeat/.test(b)) return 'lease expired';
  if (/released|release/.test(b)) return 'released';
  return 'other';
}
export const actorKind = a => {
  const k = String(a || '').split(':')[0];
  return k === 'daemon' ? 'daemon' : k === 'orch' || k === 'orchs' ? 'orchestrator' : k === 'cc' ? 'session' : k === 'user' ? 'you' : k || 'other';
};

// events: rows ordered by id. Returns Map(key -> timeline).
export function timelines(events, tickets) {
  const out = new Map();
  for (const t of tickets) out.set(t.key, { key: t.key, project: t.project, created: t.created, finished: t.finished, state: t.state,
    work: [], review: [], bounces: [], fails: 0, firstClaim: null });
  for (const e of events) {
    const tl = out.get(e.ticket);
    if (!tl) continue;
    const open = tl.work[tl.work.length - 1];
    if (e.kind === 'claim') {
      if (open && !open[1]) open[1] = e.at;   // a re-claim closes a dangling interval
      tl.work.push([e.at, null, actorKind(e.actor), null]);
      tl.firstClaim ||= e.at;
    } else if (e.kind === 'spawn') {
      if (open && !open[1]) open[3] = json(e.data, {}).model || null;
    } else if (e.kind === 'state') {
      const m = STATE_RE.exec(e.body || '');
      if (!m) continue;
      const [, from, to, why] = m;
      if (from === 'in_progress' && open && !open[1]) open[1] = e.at;
      if (to === 'in_progress' && !(open && !open[1])) { tl.work.push([e.at, null, actorKind(e.actor), null]); tl.firstClaim ||= e.at; }
      const rv = tl.review[tl.review.length - 1];
      if (from === 'in_review' && rv && !rv[1]) rv[1] = e.at;
      if (to === 'in_review') tl.review.push([e.at, null]);
      if (to === 'failed') tl.fails++;
      if (from === 'in_progress' && to === 'todo') tl.bounces.push([e.at, bounceReason(why)]);
    }
  }
  // A ticket that is no longer in a state has no open interval in it.
  for (const tl of out.values()) {
    const end = tl.finished || null;
    for (const w of tl.work) if (!w[1] && tl.state !== 'in_progress') w[1] = end || w[0];
    for (const r of tl.review) if (!r[1] && tl.state !== 'in_review') r[1] = end || r[0];
  }
  return out;
}

export function sessionKind(s) {
  const p = s.firstPrompt || '';
  if (TICKET_RE.test(p)) return 'worker';
  if (ORCH_RE.test(p)) return 'orchestrator';
  if (s.agent) return 'agent';
  return s.entrypoint === 'cli' ? 'interactive' : 'headless';
}

export function sessionRows(sessions) {
  return sessions.filter(s => s.startTime).map(s => {
    const u = mergeUsage(s.usage, s.subUsage);
    const c = costOf(u);
    let top = null, best = -1;
    for (const [m, x] of Object.entries(u)) { const n = x.output + x.input; if (n > best) { best = n; top = m; } }
    const tk = (s.firstPrompt || '').match(TICKET_RE), om = (s.firstPrompt || '').match(ORCH_RE);
    return { id: s.id, title: s.title || null, project: s.project, kind: sessionKind(s), start: s.startTime, last: s.lastTime,
      ms: s.activeMs || 0, cost: Math.round(c.cost * 100) / 100, tokens: c.input + c.output + c.cacheRead + c.cacheWrite,
      cacheRead: c.cacheRead, input: c.input, output: c.output, turns: s.userTurns || 0, tools: s.toolCalls || 0,
      subagents: s.subagents || 0, model: top, ticket: tk ? tk[1] : null, orch: om ? om[1] : null };
  });
}

let DatabaseSync = null;
async function sqlite() {
  if (DatabaseSync) return DatabaseSync;
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => (String(w).includes('SQLite') ? undefined : emit.call(process, w, ...rest));
  try { ({ DatabaseSync } = await import('node:sqlite')); } finally { process.emitWarning = emit; }
  return DatabaseSync;
}

let cache = null;   // { at, data }: the event log is small but scan + rebuild is not free; 30 s is plenty fresh
export async function statsSummary({ refresh = false } = {}) {
  if (!refresh && cache && Date.now() - cache.at < 30e3) return cache.data;
  const sessions = sessionRows(scan());
  let timeline = [], quota = [], available = false;
  if (fs.existsSync(BACKLOG_DB)) {
    await sqlite();
    const db = new DatabaseSync(BACKLOG_DB, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 3000');
      const tickets = db.prepare('SELECT key, project, state, created, finished FROM tickets').all();
      const events = db.prepare("SELECT ticket, kind, actor, body, data, at FROM events WHERE ticket IS NOT NULL AND kind IN ('claim', 'spawn', 'state') ORDER BY id").all();
      timeline = [...timelines(events, tickets).values()];
      quota = db.prepare("SELECT at, COALESCE(project, '') project FROM events WHERE kind = 'quota' ORDER BY id").all();
      available = true;
    } finally { db.close(); }
  }
  const data = { available, timeline, sessions, quota, now: new Date().toISOString() };
  cache = { at: Date.now(), data };
  return data;
}
