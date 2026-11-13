// Backlog: a read-only view of the local `bl` ticket database (SQLite).
// Point CHITO_BACKLOG_DB (or BL_DB) at it; default ~/.backlog/backlog.db (BL_HOME).
// Sessions are linked to tickets two ways: events carry the Claude Code
// session id that wrote them, and orchestrator workers start with the
// prompt "# Backlog ticket KEY: …".
import fs from 'node:fs';
import path from 'node:path';
import { HOME, scan } from './index.js';
import { costOf, mergeUsage } from './pricing.js';

export const BACKLOG_DB = process.env.CHITO_BACKLOG_DB || process.env.BL_DB || path.join(process.env.BL_HOME || path.join(HOME, '.backlog'), 'backlog.db');

let DatabaseSync = null;
async function sqlite() {
  if (DatabaseSync) return DatabaseSync;
  // node:sqlite is still flagged experimental; keep its one-time warning out of the log.
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => (String(w).includes('SQLite') ? undefined : emit.call(process, w, ...rest));
  try { ({ DatabaseSync } = await import('node:sqlite')); } finally { process.emitWarning = emit; }
  return DatabaseSync;
}

function open() {
  if (!fs.existsSync(BACKLOG_DB)) return null;
  const db = new DatabaseSync(BACKLOG_DB, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 3000');
  return db;
}

const json = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const PROMPT_RE = /^# Backlog ticket (\S+?):/;

const hasCol = (db, t, c) => hasColumn(db, t, c);
function hasColumn(db, table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(r => r.name === col);
}

// ticketKey -> Map(sessionId -> role)
function sessionLinks(db) {
  const links = new Map();
  const add = (key, id, role) => {
    if (!key || !id) return;
    let m = links.get(key);
    if (!m) { m = new Map(); links.set(key, m); }
    const prev = m.get(id);
    // 'worker' beats 'created' beats 'touched'
    const rank = { worker: 3, created: 2, touched: 1 };
    if (!prev || rank[role] > rank[prev]) m.set(id, role);
  };
  if (hasColumn(db, 'events', 'session_id')) {
    for (const e of db.prepare("SELECT ticket, kind, session_id FROM events WHERE ticket IS NOT NULL AND session_id IS NOT NULL").all()) {
      add(e.ticket, e.session_id, e.kind === 'created' ? 'created' : ['claim', 'state', 'comment'].includes(e.kind) ? 'worker' : 'touched');
    }
  }
  for (const s of scan()) {
    const m = s.firstPrompt && s.firstPrompt.match(PROMPT_RE);
    if (m) add(m[1], s.id, 'worker');
  }
  return links;
}

function sessionInfo(ids) {
  const by = new Map(scan().map(s => [s.id, s]));
  return ids.map(id => {
    const s = by.get(id);
    return s ? { id, title: s.title, lastTime: s.lastTime, startTime: s.startTime, agent: s.agent, prLinks: s.prLinks || [] } : { id, title: null, missing: true };
  });
}

export async function backlogSummary() {
  await sqlite();
  const db = open();
  if (!db) return { available: false, db: BACKLOG_DB };
  try {
    const projects = db.prepare('SELECT * FROM projects ORDER BY key').all().map(p => ({ ...p, meta: json(p.meta, {}) }));
    const tickets = db.prepare(`SELECT id, key, project, title, state, priority, estimate, labels, assignee, doc_slug, parent,
      locks, attempts, max_attempts, claimed_by, lease_until, result, meta, created, updated, started, finished,
      ${hasCol(db, 'tickets', 'milestone') ? 'milestone,' : 'NULL AS milestone,'}
      substr(body, 1, 400) AS excerpt FROM tickets ORDER BY project, priority, id`).all()
      .map(t => ({ ...t, labels: json(t.labels, []), locks: json(t.locks, []), meta: json(t.meta, {}) }));
    const deps = db.prepare('SELECT ticket, blocker FROM deps').all();
    const settings = db.prepare('SELECT scope, key, value FROM settings').all().map(s => ({ ...s, value: json(s.value, s.value) }));
    const runs = db.prepare("SELECT * FROM runs WHERE status = 'running' OR ended > datetime('now', '-1 day') ORDER BY id DESC").all();
    for (const r of runs) {
      if (r.status === 'running') { try { process.kill(r.pid, 0); r.alive = true; } catch (e) { r.alive = e.code !== 'ESRCH'; } }
    }
    // Daemon status + the latest spawn (model, log) of every in-flight ticket.
    const dRun = db.prepare("SELECT * FROM runs WHERE kind = 'daemon' ORDER BY id DESC LIMIT 1").get();
    let daemon = null;
    if (dRun) {
      let alive = false;
      if (dRun.status === 'running') { try { process.kill(dRun.pid, 0); alive = true; } catch (e) { alive = e.code !== 'ESRCH'; } }
      const en = db.prepare("SELECT value FROM settings WHERE scope = 'global' AND key = 'daemon_enabled'").get();
      const today = new Date().toISOString().slice(0, 10) + 'T00:00:00Z';
      daemon = { pid: dRun.pid, alive, heartbeat: dRun.heartbeat, started: dRun.started, enabled: en ? json(en.value, true) !== false : true,
        runsToday: db.prepare("SELECT count(*) n FROM events WHERE kind = 'claim' AND actor LIKE 'daemon:%' AND at >= ?").get(today).n };
    }
    {
      const q = db.prepare("SELECT value FROM settings WHERE scope = 'global' AND key = 'quota_until'").get();
      const until = q ? json(q.value, '') : '';
      const last = db.prepare("SELECT body, at, ticket FROM events WHERE kind = 'quota' ORDER BY id DESC LIMIT 1").get();
      if (daemon) daemon.quota = { until: until && until > new Date().toISOString().replace(/\.\d+Z$/, 'Z') ? until : null, last: last || null };
    }
    const spawns = new Map(db.prepare(`SELECT e.ticket, e.data, e.at FROM events e JOIN tickets t ON t.key = e.ticket
      WHERE t.state = 'in_progress' AND e.kind = 'spawn' ORDER BY e.id`).all().map(e => [e.ticket, { ...json(e.data, {}), at: e.at }]));
    for (const t of tickets) if (spawns.has(t.key)) t.spawn = spawns.get(t.key);
    const links = sessionLinks(db);
    const allIds = [...new Set([...links.values()].flatMap(m => [...m.keys()]))];
    const info = new Map(sessionInfo(allIds).map(s => [s.id, s]));
    for (const t of tickets) {
      const m = links.get(t.key);
      t.sessions = m ? [...m].map(([id, role]) => ({ ...info.get(id), role })).sort((a, b) => ((b.lastTime || '') > (a.lastTime || '') ? 1 : -1)) : [];
    }
    // Milestones (optional table).
    let milestones = [];
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'milestones'").get()) {
      milestones = db.prepare('SELECT * FROM milestones ORDER BY project, seq, id').all().map(m => ({ ...m, showcases: json(m.showcases, []) }));
    }
    // Who is executing each project right now: a live orchestrator (and the session that launched it),
    // the owning session, or the daemon queue.
    const allSessions = scan();
    const byPrefix = owner => { const pre = owner.slice(3); return allSessions.find(s => s.id.startsWith(pre)); };
    for (const p of projects) {
      const ex = { kind: p.executor === 'daemon' ? 'daemon' : 'session', runs: [], owner: null };
      for (const r of runs.filter(r => r.project === p.key && r.status === 'running' && r.alive)) {
        const ev = db.prepare("SELECT data FROM events WHERE kind = 'run' AND project = ? AND body LIKE ? ORDER BY id DESC LIMIT 1").get(p.key, `run ${r.id} started%`);
        const sid = ev ? json(ev.data, {}).launcher_session : null;
        const s = sid && allSessions.find(x => x.id === sid);
        ex.runs.push({ id: r.id, pid: r.pid, started: r.started, heartbeat: r.heartbeat,
          session: s ? { id: s.id, title: s.title, lastTime: s.lastTime } : sid ? { id: sid, title: null } : null });
      }
      if (p.owner && p.owner.startsWith('cc:')) {
        const s = byPrefix(p.owner);
        ex.owner = { agent: p.owner, heartbeat: p.owner_heartbeat, session: s ? { id: s.id, title: s.title, lastTime: s.lastTime } : null };
      } else if (p.owner) ex.owner = { agent: p.owner, heartbeat: p.owner_heartbeat, session: null };
      ex.workers = tickets.filter(t => t.project === p.key && t.state === 'in_progress').map(t => ({ key: t.key, by: t.claimed_by }));
      p.execution = ex;
    }
    // Usage: a session linked (as worker) to exactly one ticket counts toward that ticket. Sessions shared by
    // several tickets (an orchestrator running subagents) and orchestrator sessions count toward the project.
    const metaById = new Map(allSessions.map(s => [s.id, s]));
    const sessTickets = new Map();
    for (const t of tickets) for (const s of t.sessions) if (s.role === 'worker') {
      if (!sessTickets.has(s.id)) sessTickets.set(s.id, new Set());
      sessTickets.get(s.id).add(t.key);
    }
    const sessUsage = id => { const m = metaById.get(id); return m ? mergeUsage(m.usage, m.subUsage) : {}; };
    for (const t of tickets) {
      t.prs = ticketPrs(t, id => sessTickets.get(id)?.size === 1);
      for (const s of t.sessions) delete s.prLinks;
    }
    for (const t of tickets) {
      const own = t.sessions.filter(s => s.role === 'worker' && sessTickets.get(s.id)?.size === 1);
      t.usage = own.length ? summarize(mergeUsage(...own.map(s => sessUsage(s.id)))) : null;
      if (t.usage) t.usage.sessions = own.length;
    }
    const ORCH_RE = /^# Backlog orchestrator for (\S+?):/;
    for (const p of projects) {
      const ids = new Set();
      for (const t of tickets) if (t.project === p.key) for (const s of t.sessions) if (s.role === 'worker') ids.add(s.id);
      const orch = allSessions.filter(s => s.firstPrompt && (s.firstPrompt.match(ORCH_RE) || [])[1] === p.key);
      for (const s of orch) ids.add(s.id);
      const shared = [...ids].filter(id => (sessTickets.get(id)?.size || 0) !== 1);
      p.usage = ids.size ? summarize(mergeUsage(...[...ids].map(sessUsage))) : null;
      p.sharedUsage = shared.length ? summarize(mergeUsage(...shared.map(sessUsage))) : null;
      p.orchSessions = orch.sort((a, b) => (b.lastTime || '') > (a.lastTime || '') ? 1 : -1).slice(0, 5)
        .map(s => ({ id: s.id, title: s.title, lastTime: s.lastTime, startTime: s.startTime }));
      if (p.execution) {
        p.execution.orchestrator = p.owner && p.owner.startsWith('orchs:') && p.orchSessions[0] ? p.orchSessions[0] : null;
      }
    }
    return { available: true, db: BACKLOG_DB, projects, tickets, deps, settings, runs, daemon, milestones, now: new Date().toISOString() };
  } finally { db.close(); }
}

function summarize(usage) {
  const c = costOf(usage);
  return { input: c.input, output: c.output, cacheRead: c.cacheRead, cacheWrite: c.cacheWrite, turns: c.msgs,
    tokens: c.input + c.output + c.cacheRead + c.cacheWrite, cost: Math.round(c.cost * 100) / 100, unpriced: c.unpriced, models: c.models };
}

// PRs for a ticket: links found in its worker sessions, plus any PR URL in its result.
const PR_RE = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;
function ticketPrs(t, dedicated = () => true) {
  const out = new Map();
  for (const s of t.sessions || []) if (s.role === 'worker' && dedicated(s.id)) for (const pr of s.prLinks || []) out.set(pr.url, { url: pr.url, repo: pr.repo, number: pr.number });
  for (const m of String(t.result || '').matchAll(PR_RE)) { const url = m[0]; if (!out.has(url)) out.set(url, { url, repo: m[1], number: Number(m[2]) }); }
  return [...out.values()];
}

export function showcaseFile(rel) {
  const home = process.env.BL_HOME || path.join(HOME, '.backlog');
  const base = fs.realpathSync(path.join(home, 'showcase'));
  const full = path.resolve(base, rel);
  if (!full.startsWith(base + path.sep) || !fs.existsSync(full)) return null;
  const real = fs.realpathSync(full);
  return real.startsWith(base + path.sep) ? real : null;
}

export async function backlogTicket(key) {
  await sqlite();
  const db = open();
  if (!db) return null;
  try {
    const t = db.prepare('SELECT * FROM tickets WHERE key = ?').get(key);
    if (!t) return null;
    t.labels = json(t.labels, []); t.locks = json(t.locks, []); t.meta = json(t.meta, {});
    t.blockers = db.prepare('SELECT b.key, b.title, b.state, b.result FROM deps d JOIN tickets b ON b.key = d.blocker WHERE d.ticket = ? ORDER BY b.id').all(key);
    t.dependents = db.prepare('SELECT x.key, x.title, x.state FROM deps d JOIN tickets x ON x.key = d.ticket WHERE d.blocker = ? ORDER BY x.id').all(key);
    t.events = db.prepare('SELECT * FROM events WHERE ticket = ? ORDER BY id').all(key).map(e => ({ ...e, data: json(e.data, {}) }));
    const m = sessionLinks(db).get(key);
    const info = new Map(sessionInfo(m ? [...m.keys()] : []).map(s => [s.id, s]));
    t.sessions = m ? [...m].map(([id, role]) => ({ ...info.get(id), role })) : [];
    const all = sessionLinks(db);
    const count = new Map();
    for (const sm of all.values()) for (const [id, role] of sm) if (role === 'worker') count.set(id, (count.get(id) || 0) + 1);
    t.prs = ticketPrs(t, id => count.get(id) === 1);
    for (const s of t.sessions) delete s.prLinks;
    return t;
  } finally { db.close(); }
}
