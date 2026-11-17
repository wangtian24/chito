// Plain-language findings for the top of the Stats tab, each with what to do about it. From compute()'s output.
import { t as tr } from '/i18n.js';
import { median, CRASH } from '/stats-model.js';

const H = 3600e3;
export const fmtUsd = v => v == null ? '–' : v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`;
export function fmtDur(v) {
  if (v == null) return '–';
  const m = v / 6e4;
  if (m < 1) return tr('{n}s', { n: Math.round(v / 1000) });
  if (m < 90) return tr('{n}m', { n: Math.round(m) });
  if (m < 48 * 60) return tr('{n}h', { n: (m / 60).toFixed(m < 600 ? 1 : 0) });
  return tr('{n}d', { n: (m / 1440).toFixed(1) });
}
export const REASON = { 'waiting for green main': tr('Waiting for a green main'), 'worker exited': tr('Worker exited'), 'orchestrator exited': tr('Orchestrator exited'),
  quota: tr('Usage limit'), 'lease expired': tr('Lease expired'), 'new blocker': tr('New blocker'), parked: tr('Parked'), paused: tr('Paused'), released: tr('Released'), other: tr('Other') };
const pct = v => `${Math.round(v * 100)}%`;

// Returns [{ tone: 'warn' | 'good' | 'info', head, body }], most useful first, at most 7.
export function insights(m) {
  const out = [];
  const { cur, prev } = m;
  const totalB = Object.values(m.reasons).reduce((a, b) => a + b, 0);
  const green = m.reasons['waiting for green main'] || 0;
  if (green >= 5 && green / totalB > 0.25) out.push({ tone: 'warn', head: tr('A red main is the biggest drag'),
    body: tr('{n} of {t} returns to the queue ({p}) were finished PRs waiting for a green main. Keeping main green (or merging past known-red checks) frees those slots.', { n: green, t: totalB, p: pct(green / totalB) }) });
  if (m.spinning.length) {
    const top = m.spinning[0];
    out.push({ tone: 'warn', head: tr('{k} went back to the queue {n} times', { k: top.key, n: top.n }),
      body: m.spinning.length > 1 ? tr('{n} tickets are cycling claim → wait → requeue (also {more}). Each cycle is a worker start; park them until main is green.', { n: m.spinning.length, more: m.spinning.slice(1, 4).map(s => s.key).join(', ') })
        : tr('It keeps being claimed and sent back. Each cycle is a worker start; park it until what it waits on is ready.') });
  }
  if (m.queueMed != null && m.workMed && m.queueMed > 2 * m.workMed && m.queueMed > H) out.push({ tone: 'info', head: tr('Tickets wait longer to start than to finish'),
    body: tr('A done ticket waited {q} (median) before a worker picked it up, then took {w} of agent time. The wait is mostly blockers and slots, not the work itself.', { q: fmtDur(m.queueMed), w: fmtDur(m.workMed) }) });
  const crashes = Object.entries(m.reasons).filter(([k]) => CRASH.has(k)).reduce((a, [, v]) => a + v, 0);
  if (crashes >= 3) {
    const parts = Object.entries(m.reasons).filter(([k]) => CRASH.has(k)).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${REASON[k] || k} ${v}`).join(', ');
    out.push({ tone: 'warn', head: tr('{n} worker runs were lost', { n: crashes }),
      body: tr('{parts}. Each lost run starts over from scratch, so this is spend with nothing to show.', { parts }) });
  }
  if (m.quota.length) {
    const hrs = {}; for (const t of m.quota) { const h = new Date(t).getHours(); hrs[h] = (hrs[h] || 0) + 1; }
    const [h] = Object.entries(hrs).sort((a, b) => b[1] - a[1])[0];
    out.push({ tone: 'warn', head: tr('Usage limit hit {n} times', { n: m.quota.length }),
      body: tr('Most often around {h}:00. Spread heavy projects across the day or lower parallel before that hour.', { h: String(h).padStart(2, '0') }) });
  }
  if (cur.review != null && cur.reviews >= 3) {
    const tone = cur.review > 4 * H ? 'warn' : 'info';
    out.push({ tone, head: tr('Reviews wait {d} (median)', { d: fmtDur(cur.review) }),
      body: m.stuck.length ? tr('{n} tickets have sat in review for over 12 hours: {keys}.', { n: m.stuck.length, keys: m.stuck.slice(0, 4).map(s => s.key).join(', ') })
        : tr('Over {n} reviews. Nothing has been waiting more than 12 hours.', { n: cur.reviews }) });
  }
  if (m.hours >= 6 && !m.project) {
    const tone = m.util < 0.35 ? 'info' : m.util > 0.85 ? 'warn' : 'good';
    const body = m.util < 0.35 ? tr('Peak {p} busy at once of {c} slots, idle {i} of {h} hours. There is room to queue more work or raise parallel.', { p: m.peak.toFixed(1), c: m.cap, i: m.idleHours, h: m.hours })
      : m.util > 0.85 ? tr('Peak {p} of {c} slots. Work is queuing for slots; raise the cap if quota allows.', { p: m.peak.toFixed(1), c: m.cap })
        : tr('Peak {p} of {c} slots, idle {i} of {h} hours.', { p: m.peak.toFixed(1), c: m.cap, i: m.idleHours, h: m.hours });
    out.push({ tone, head: tr('Workers busy {u} of capacity', { u: pct(m.util) }), body });
  }
  const rated = m.projects.filter(p => p.done >= 3 && p.perDone != null);
  if (rated.length >= 3) {
    const med = median(rated.map(p => p.perDone));
    const hi = [...rated].sort((a, b) => b.perDone - a.perDone)[0];
    if (med && hi.perDone > 1.8 * med) out.push({ tone: 'info', head: tr('{p} costs {x}× the median per ticket', { p: hi.key, x: (hi.perDone / med).toFixed(1) }),
      body: tr('{v} per done ticket against {m}. Its tickets may be too big; splitting them usually makes them cheaper and more likely to pass first time.', { v: fmtUsd(hi.perDone), m: fmtUsd(med) }) });
    const worst = [...rated].sort((a, b) => a.cleanPct - b.cleanPct)[0];
    if (worst.cleanPct < 0.7) out.push({ tone: 'warn', head: tr('{p}: only {c} of tickets ran clean', { p: worst.key, c: pct(worst.cleanPct) }),
      body: tr('The rest crashed, failed or hit a limit on the way. Look at its failure logs before queuing more.') });
  }
  const k = m.kinds, auto = k.worker.cost + k.orchestrator.cost, all = Object.values(k).reduce((a, x) => a + x.cost, 0);
  if (all > 5 && !m.project) out.push({ tone: 'info', head: tr('{p} of spend is the factory', { p: pct(auto / all) }),
    body: tr('{a} on backlog workers and orchestrators, {i} in your own interactive sessions.', { a: fmtUsd(auto), i: fmtUsd(k.interactive.cost) }) });
  if (prev && prev.n >= 3 && cur.n >= 3) {
    const d = cur.n / prev.n - 1, dc = cur.perDone && prev.perDone ? cur.perDone / prev.perDone - 1 : 0;
    if (Math.abs(d) >= 0.2) out.push({ tone: d > 0 ? 'good' : 'info', head: d > 0 ? tr('Throughput up {p}', { p: pct(d) }) : tr('Throughput down {p}', { p: pct(-d) }),
      body: tr('{n} tickets done against {m} the period before; cost per ticket {dir} {c}.', { n: cur.n, m: prev.n, dir: dc >= 0 ? tr('up') : tr('down'), c: pct(Math.abs(dc)) }) });
  }
  const cache = m.tok.cacheRead / Math.max(1, m.tok.cacheRead + m.tok.input);
  if (m.tok.cacheRead && cache < 0.8) out.push({ tone: 'info', head: tr('Cache hit rate {p}', { p: pct(cache) }),
    body: tr('Under 80% of input comes from the prompt cache. Long gaps between turns let it expire.') });
  const order = { warn: 0, info: 1, good: 2 };
  return out.sort((a, b) => order[a.tone] - order[b.tone]).slice(0, 7);
}
