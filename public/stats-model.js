// The numbers behind the Stats tab, from /api/stats (ticket timelines, sessions, quota hits) and /api/backlog
// (tickets with their usage). Pure: compute(...) takes a filter and returns everything the page draws.
const H = 3600e3, D = 24 * H;
export const RANGES = [['24h', D], ['7d', 7 * D], ['30d', 30 * D], ['all', Infinity]];
const ms = s => (s ? Date.parse(s) : NaN);
const ov = (s, e, a, b) => Math.max(0, Math.min(e, b) - Math.max(s, a));
export const median = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sum = (xs, f = x => x) => xs.reduce((n, x) => n + (f(x) || 0), 0);
// Retries that cost a worker run: a crash, a usage limit or a lost lease. Parked, paused and new-blocker
// returns are the system working as designed; waiting for a green main is its own (big) bucket.
export const CRASH = new Set(['worker exited', 'orchestrator exited', 'quota', 'lease expired']);
export const SESSION_KINDS = ['worker', 'orchestrator', 'interactive', 'agent', 'headless'];

// Which backlog project a session belongs to (worker ticket's project, orchestrator's project) or null.
export function sessionProject(s, byKey) {
  if (s.ticket) return byKey.get(s.ticket)?.project || s.ticket.replace(/-\d+$/, '');
  return s.orch || null;
}

// Project color slots: the 7 biggest spenders of all time keep fixed slots (so a filter never repaints them);
// the rest share "Other".
export function colorSlots(tickets) {
  const by = {};
  for (const t of tickets) by[t.project] = (by[t.project] || 0) + (t.usage?.cost || 0) + 0.001;
  const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 7).map(([k]) => k);
  return k => { const i = top.indexOf(k); return i < 0 ? 'var(--st-other)' : `var(--st-c${i + 1})`; };
}

function buckets(from, to, range) {
  const step = range === '24h' ? H : (to - from) > 120 * D ? 7 * D : D;
  const start = step === H ? Math.floor(from / H) * H : new Date(new Date(from).setHours(0, 0, 0, 0)).getTime();
  const out = [];
  for (let s = start; s < to; s += step) out.push({ s, e: s + step, done: {}, spend: 0, agentMs: 0, created: 0, n: 0 });
  return { list: out, step, at: t => out.findIndex(b => t >= b.s && t < b.e) };
}

export function compute(stats, tickets, { range = '7d', project = null, now = Date.now(), cap = 8 } = {}) {
  const span = (RANGES.find(([k]) => k === range) || RANGES[1])[1];
  const byKey = new Map(tickets.map(t => [t.key, t]));
  const earliest = Math.min(...stats.timeline.map(t => ms(t.created)).filter(Number.isFinite), now - D);
  const from = span === Infinity ? earliest : now - span, to = now;
  const prevFrom = span === Infinity ? null : from - span;
  const inProj = k => !project || k === project;
  const tl = stats.timeline.filter(t => inProj(t.project));
  const sess = stats.sessions.map(s => ({ ...s, bproject: sessionProject(s, byKey) })).filter(s => !project || s.bproject === project);

  const facts = t => {
    const f = ms(t.finished), c = ms(t.created), fc = ms(t.firstClaim);
    const work = sum(t.work, w => (ms(w[1]) || now) - ms(w[0]));
    const review = sum(t.review, r => (ms(r[1]) || now) - ms(r[0]));
    const crashes = t.bounces.filter(b => CRASH.has(b[1])).length;
    const tk = byKey.get(t.key);
    return { key: t.key, project: t.project, title: tk?.title || '', state: t.state, finished: t.finished, cost: tk?.usage?.cost || 0,
      tokens: tk?.usage?.tokens || 0, work, review, cycle: f && fc ? f - fc : null, lead: f && c ? f - c : null, queue: fc && c ? Math.max(0, fc - c) : null,
      bounces: t.bounces.length, crashes, fails: t.fails, clean: !crashes && !t.fails, runs: t.work.length,
      model: t.work.map(w => w[3]).filter(Boolean).pop() || null };
  };
  const doneIn = (a, b) => tl.filter(t => t.state === 'done' && ms(t.finished) >= a && ms(t.finished) < b).map(facts);
  const agentMs = (a, b) => sum(tl, t => sum(t.work, w => ov(ms(w[0]), ms(w[1]) || now, a, b)));
  const spendIn = (a, b, f = () => true) => sum(sess.filter(s => ms(s.start) >= a && ms(s.start) < b && f(s)), s => s.cost);
  const isFactory = s => s.kind === 'worker' || s.kind === 'orchestrator';
  const period = (a, b) => {
    const done = doneIn(a, b), spend = spendIn(a, b), factory = spendIn(a, b, isFactory);
    const reviews = tl.flatMap(t => t.review.filter(r => r[1] && ms(r[1]) >= a && ms(r[1]) < b).map(r => ms(r[1]) - ms(r[0])));
    return { done, n: done.length, spend, factory, perDone: done.length ? factory / done.length : null,
      cycle: median(done.map(d => d.cycle).filter(v => v != null)), clean: done.length ? done.filter(d => d.clean).length / done.length : null,
      agentMs: agentMs(a, b), review: median(reviews), reviews: reviews.length };
  };
  const cur = period(from, to), prev = prevFrom != null ? period(prevFrom, from) : null;

  // Over time: done per project, spend, agent time per bucket.
  const bk = buckets(from, to, range);
  for (const d of cur.done) { const i = bk.at(ms(d.finished)); if (i >= 0) { bk.list[i].done[d.project] = (bk.list[i].done[d.project] || 0) + 1; bk.list[i].n++; } }
  for (const s of sess) { const i = bk.at(ms(s.start)); if (i >= 0) bk.list[i].spend += s.cost; }
  for (const t of tl) { const i = bk.at(ms(t.created)); if (i >= 0) bk.list[i].created++; for (const w of t.work) for (const b of bk.list) b.agentMs += ov(ms(w[0]), ms(w[1]) || now, b.s, b.e); }

  // When the floor runs: agent hours by weekday x hour (local time), and hourly busy workers for peak/utilization.
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  const hourly = new Map();
  for (const t of tl) for (const w of t.work) {
    let s = Math.max(ms(w[0]), from); const e = Math.min(ms(w[1]) || now, to);
    while (s < e) {
      const hs = Math.floor(s / H) * H, cut = Math.min(e, hs + H), d = new Date(s);
      heat[(d.getDay() + 6) % 7][d.getHours()] += (cut - s) / H;
      hourly.set(hs, (hourly.get(hs) || 0) + (cut - s) / H);
      s = cut;
    }
  }
  const hours = Math.max(1, Math.round((to - from) / H));
  const busyHours = [...hourly.values()];
  const util = sum(busyHours) / (hours * cap);
  const peak = busyHours.length ? Math.max(...busyHours) : 0;
  const idleHours = hours - hourly.size;
  // Busy workers per hour (24 h, 7 d) or per bucket (longer windows).
  const conc = range === '24h' || range === '7d'
    ? Array.from({ length: Math.ceil((to - Math.floor(from / H) * H) / H) }, (_, i) => { const hs = Math.floor(from / H) * H + i * H; return { s: hs, e: hs + H, v: hourly.get(hs) || 0 }; })
    : bk.list.map(b => ({ s: b.s, e: b.e, v: b.agentMs / (b.e - b.s) }));

  // Projects.
  const projects = {};
  for (const t of tl) {
    const p = projects[t.project] ||= { key: t.project, done: 0, open: 0, failed: 0, cost: 0, agentMs: 0, cycles: [], clean: 0, bounces: 0, crashes: 0, green: 0, queue: [], work: [], review: [] };
    if (t.state === 'failed') p.failed++;
    else if (!['done', 'canceled'].includes(t.state)) p.open++;
    p.agentMs += sum(t.work, w => ov(ms(w[0]), ms(w[1]) || now, from, to));
    for (const b of t.bounces) if (ms(b[0]) >= from) { p.bounces++; if (CRASH.has(b[1])) p.crashes++; if (b[1] === 'waiting for green main') p.green++; }
  }
  for (const d of cur.done) {
    const p = projects[d.project]; p.done++; p.cost += d.cost; if (d.clean) p.clean++;
    if (d.cycle != null) p.cycles.push(d.cycle);
    if (d.queue != null) p.queue.push(d.queue); p.work.push(d.work); p.review.push(d.review);
  }
  for (const s of sess) if (s.bproject && projects[s.bproject] && ms(s.start) >= from) projects[s.bproject].spend = (projects[s.bproject].spend || 0) + s.cost;
  const projRows = Object.values(projects).filter(p => p.done || p.agentMs || p.spend || p.open)
    .map(p => ({ ...p, spend: p.spend || 0, perDone: p.done ? (p.spend || 0) / p.done : null, cycle: median(p.cycles), cleanPct: p.done ? p.clean / p.done : null,
      perAgentH: p.agentMs > H / 4 ? (p.spend || 0) / (p.agentMs / H) : null }));

  // Why tickets bounce, cycle-time histogram, sessions by kind / model.
  const reasons = {};
  for (const t of tl) for (const b of t.bounces) if (ms(b[0]) >= from && ms(b[0]) < to) reasons[b[1]] = (reasons[b[1]] || 0) + 1;
  const EDGES = [15 * 6e4, 30 * 6e4, H, 2 * H, 4 * H, 8 * H, D, 3 * D, Infinity];
  const hist = EDGES.map(() => 0);
  for (const d of cur.done) if (d.cycle != null) hist[EDGES.findIndex(e => d.cycle < e)]++;
  const winSess = sess.filter(s => ms(s.start) >= from && ms(s.start) < to);
  const kinds = Object.fromEntries(SESSION_KINDS.map(k => [k, { cost: 0, n: 0, ms: 0 }]));
  const models = {};
  for (const s of winSess) {
    const k = kinds[s.kind] || kinds.headless; k.cost += s.cost; k.n++; k.ms += s.ms;
    const m = (s.model || 'unknown').replace(/^claude-/, '').replace(/-\d{8}$/, '');
    (models[m] ||= { cost: 0, n: 0 }).cost += s.cost; models[m].n++;
  }
  const tok = { input: sum(winSess, s => s.input), output: sum(winSess, s => s.output), cacheRead: sum(winSess, s => s.cacheRead) };
  const quota = stats.quota.filter(q => !project || (q.project || q.ticket?.replace(/-\d+$/, '')) === project).map(q => ms(q.at ?? q)).filter(t => t >= from && t < to);
  const spinning = tl.map(t => ({ key: t.key, n: t.bounces.filter(b => ms(b[0]) >= from).length })).filter(x => x.n >= 20).sort((a, b) => b.n - a.n);
  const queueMed = median(cur.done.map(d => d.queue).filter(v => v != null)), workMed = median(cur.done.map(d => d.work));
  const stuck = tl.filter(t => t.state === 'in_review').map(t => ({ key: t.key, since: ms(t.review[t.review.length - 1]?.[0]) })).filter(x => x.since && now - x.since > 12 * H);

  return { from, to, range, project, cap, cur, prev, buckets: bk, heat, util, peak, idleHours, hours, projects: projRows, reasons, hist, EDGES,
    kinds, models, tok, quota, winSess, stuck, spinning, queueMed, workMed, conc, open: tl.filter(t => t.state === 'in_progress').length };
}
