// Projects → Stats tab: how the factory is doing. Filters (window, project) on one row, then insights, stat tiles
// and cards two or three to a row: throughput, spend, projects, top tickets and sessions, when the floor runs,
// why tickets bounce, cycle times and where the time goes. Everything hovers; rows and bars click through.
import { t as tr, tp as trp, LOCALE } from '/i18n.js';
import { compute, colorSlots, RANGES, SESSION_KINDS } from '/stats-model.js';
import { insights, fmtUsd, fmtDur, REASON } from '/stats-insights.js';
import { el, card, kpi, barList, columns, area, heatmap, splitBars, sortTable, empty } from '/stats-charts.js';

const H = 3600e3;
const store = {
  get(k, d) { try { const v = localStorage.getItem('chito.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('chito.' + k, JSON.stringify(v)); } catch { } },
};
const st = { data: null, loading: null, error: null, range: store.get('statsRange', '7d'), project: store.get('statsProject', null),
  projSort: { col: 'spend', dir: -1 } };
if (!RANGES.some(([k]) => k === st.range)) st.range = '7d';
const KIND = { worker: tr('Backlog workers'), orchestrator: tr('Orchestrators'), interactive: tr('Your sessions'), agent: tr('Agent (AHS)'), headless: tr('Other headless') };
const RANGE_LABEL = { '24h': tr('24 hours'), '7d': tr('7 days'), '30d': tr('30 days'), all: tr('All time') };
const fmtN = v => (v == null ? '–' : Math.round(v).toLocaleString(LOCALE));
const fmtH = v => (v == null ? '–' : `${(v / H).toFixed(v < 10 * H ? 1 : 0)}h`);
const pct = v => (v == null ? '–' : `${Math.round(v * 100)}%`);

async function load(rerender, refresh = false) {
  if (st.loading) return st.loading;
  st.loading = fetch(`/api/stats${refresh ? '?refresh=1' : ''}`).then(r => r.json()).then(d => { st.data = d; st.error = null; })
    .catch(e => { st.error = e.message; }).finally(() => { st.loading = null; rerender(); });
  return st.loading;
}

// h: { data (backlog), cap, linkTo, openPath, projPath, openSession, rerender }
export function renderStatsTab(root, h) {
  if (!st.data) { root.append(el('div', 'prs-empty', st.error ? tr('Could not load stats: {error}', { error: st.error }) : tr('Loading…'))); if (!st.loading && !st.error) load(h.rerender); return; }
  const tickets = h.data.tickets;
  const color = colorSlots(tickets);
  const projects = [...new Set(tickets.map(t => t.project))].sort();
  if (st.project && !projects.includes(st.project)) st.project = null;
  const m = compute(st.data, tickets, { range: st.range, project: st.project, cap: h.cap });
  const set = (k, v) => { st[k] = v; store.set(k === 'range' ? 'statsRange' : 'statsProject', v); h.rerender(); };
  const tk = key => h.data.tickets.find(t => t.key === key);
  const openTicket = key => { const t = tk(key); if (t) h.go(h.openPath(t)); };

  // ---- filters ----
  const bar = el('div', 'st-filters');
  const seg = el('div', 'seg'); seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', tr('Time window'));
  for (const [k] of RANGES) { const b = el('button', null, RANGE_LABEL[k]); b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(k === st.range)); b.addEventListener('click', () => set('range', k)); seg.append(b); }
  const ps = el('select'); ps.setAttribute('aria-label', tr('Project'));
  for (const k of [null, ...projects]) { const o = el('option', null, k || tr('All projects')); o.value = k || ''; if (k === st.project) o.selected = true; ps.append(o); }
  ps.addEventListener('change', () => set('project', ps.value || null));
  const pl = el('label', 'bl-proj-sort'); pl.append(el('span', 'bl-cap', tr('Project')), ps);
  const rf = el('button', 'btn', tr('Refresh')); rf.type = 'button'; rf.addEventListener('click', () => load(h.rerender, true));
  bar.append(seg, pl, el('span', 'num st-asof', tr('as of {t}', { t: new Date(st.data.now).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' }) })), rf);
  root.append(bar);

  // ---- insights + tiles ----
  const ins = insights(m);
  const grid = el('div', 'st-grid');
  if (ins.length) {
    const list = el('ul', 'st-insights');
    for (const i of ins) { const li = el('li', `st-ins ${i.tone}`); li.append(el('span', 'st-ins-tag', i.tone === 'warn' ? tr('Fix') : i.tone === 'good' ? tr('Good') : tr('Note')), el('b', null, i.head), el('span', null, i.body)); list.append(li); }
    grid.append(card(tr('What stands out'), tr('From the window and project picked above.'), list, { span: 3 }));
  }
  const delta = (a, b, upGood, f = v => pct(v)) => {
    if (a == null || b == null || !m.prev || !b) return null;
    const d = a / b - 1; if (!Number.isFinite(d) || Math.abs(d) < 0.02) return { text: '±0', tone: '' };
    return { text: `${d > 0 ? '▲' : '▼'} ${d >= 2 ? `${(a / b).toFixed(a / b >= 10 ? 0 : 1)}×` : f(Math.abs(d))}`, tone: (d > 0) === upGood ? 'good' : 'bad', title: tr('against the {r} before', { r: RANGE_LABEL[st.range] }) };
  };
  const c = m.cur, p = m.prev || {};
  const tiles = el('div', 'st-kpis');
  tiles.append(
    kpi(tr('Tickets done'), fmtN(c.n), tr('{n} in flight now', { n: m.open }), delta(c.n, p.n, true)),
    kpi(tr('Spend (est.)'), fmtUsd(c.spend), tr('all sessions'), delta(c.spend, p.spend, false)),
    kpi(tr('Cost per ticket'), fmtUsd(c.perDone), tr('workers + orchestrators'), delta(c.perDone, p.perDone, false)),
    kpi(tr('Cycle time'), fmtDur(c.cycle), tr('median'), delta(c.cycle, p.cycle, false)),
    kpi(tr('Clean runs'), pct(c.clean), tr('no crash'), delta(c.clean, p.clean, true)),
    kpi(tr('Agent hours'), fmtH(c.agentMs), tr('{u} of capacity', { u: pct(m.util) }), delta(c.agentMs, p.agentMs, true)),
    kpi(tr('Review wait'), fmtDur(c.review), trp(c.reviews, '{n} review', '{n} reviews'), delta(c.review, p.review, false)));
  grid.append(card(null, null, tiles, { span: 3, cls: 'st-bare' }));

  // ---- over time ----
  const fmtB = b => m.buckets.step === H ? new Date(b.s).toLocaleTimeString(LOCALE, { hour: '2-digit' }) : new Date(b.s).toLocaleDateString(LOCALE, { month: 'numeric', day: 'numeric' });
  const every = Math.ceil(m.buckets.list.length / 10);
  const projKeys = [...new Set(m.cur.done.map(d => d.project))];
  const legend = el('div', 'st-legend');
  const seen = new Set();
  for (const k of projKeys.sort()) { const col = color(k); const name = col === 'var(--st-other)' ? tr('Other') : k; if (seen.has(name)) continue; seen.add(name); const i = el('span', 'st-leg'); const sw = el('span', 'st-sw'); sw.style.background = col; i.append(sw, name); legend.append(i); }
  const thr = el('div'); thr.append(legend, columns(m.buckets.list.map(b => {
    const by = new Map();   // projects without a slot of their own fold into one "Other" segment
    for (const [k, v] of Object.entries(b.done)) { const c2 = color(k), name = c2 === 'var(--st-other)' ? tr('Other') : k; const x = by.get(name) || { v: 0, color: c2, name }; x.v += v; by.set(name, x); }
    const segs = [...by.values()].sort((x, y) => x.color.localeCompare(y.color));
    return { label: fmtB(b), segs, tip: [fmtB(b), ...segs.map(s => [s.color, s.name, String(s.v)]), tr('{n} created · {h} agent hours · {s}', { n: b.created, h: (b.agentMs / H).toFixed(1), s: fmtUsd(b.spend) })] };
  }), { every }));
  grid.append(card(tr('Throughput'), tr('Tickets done per {u}, by project', { u: m.buckets.step === H ? tr('hour') : m.buckets.step > 864e5 ? tr('week') : tr('day') }), thr, { span: 2 }));
  const kinds = SESSION_KINDS.map((k, i) => ({ label: KIND[k], value: m.kinds[k].cost, text: fmtUsd(m.kinds[k].cost), color: `var(--st-c${i + 1})`, sub: fmtN(m.kinds[k].n),
    tip: [KIND[k], tr('{n} sessions · {h} active', { n: m.kinds[k].n, h: fmtH(m.kinds[k].ms) }), tr('{v} per session', { v: fmtUsd(m.kinds[k].n ? m.kinds[k].cost / m.kinds[k].n : 0) })] })).filter(r => r.value > 0);
  grid.append(card(tr('Spend by session kind'), tr('Every Claude session started in the window'), barList(kinds)));

  const spend = area(m.buckets.list.map(b => ({ label: fmtB(b), v: b.spend, tip: [fmtB(b), fmtUsd(b.spend)] })), { fmt: fmtUsd });
  grid.append(card(tr('Spend over time'), tr('Estimated at list prices, by session start'), spend, { span: 2 }));
  const models = Object.entries(m.models).sort((a, b) => b[1].cost - a[1].cost).map(([k, v]) => ({ label: k, value: v.cost, text: fmtUsd(v.cost), sub: trp(v.n, '{n} session', '{n} sessions') }));
  grid.append(card(tr('Spend by model'), tr("Each session's main model"), barList(models, { limit: 6 })));

  // ---- projects ----
  const cols = [
    { key: 'key', label: tr('Project'), fmt: v => { const s = el('span', 'st-pname'); const sw = el('span', 'st-sw'); sw.style.background = color(v); s.append(sw, v); return s; } },
    { key: 'done', label: tr('Done'), num: true }, { key: 'open', label: tr('Open'), num: true }, { key: 'failed', label: tr('Failed'), num: true },
    { key: 'spend', label: tr('Spend'), num: true, fmt: fmtUsd }, { key: 'perDone', label: tr('$ / ticket'), num: true, fmt: fmtUsd },
    { key: 'cycle', label: tr('Cycle'), num: true, fmt: fmtDur, title: tr('Median claim to done') },
    { key: 'cleanPct', label: tr('Clean'), num: true, fmt: pct, title: tr('Done tickets with no crash or failure') },
    { key: 'crashes', label: tr('Lost runs'), num: true, title: tr('Worker exits, usage limits and lost leases') },
    { key: 'green', label: tr('Red-main waits'), num: true, title: tr('Finished PRs sent back to wait for a green main') },
    { key: 'agentMs', label: tr('Agent h'), num: true, fmt: fmtH }, { key: 'perAgentH', label: tr('$ / agent h'), num: true, fmt: fmtUsd }];
  const tbl = m.projects.length ? sortTable(cols, m.projects, st.projSort, { onRow: r => set('project', st.project === r.key ? null : r.key), onSort: h.rerender, rowTitle: () => tr('Click to filter the page to this project') }) : empty();
  grid.append(card(tr('Projects'), tr('Click a row to filter the page to that project; click again to clear.'), tbl, { span: 3 }));

  // ---- top lists ----
  const done = m.cur.done;
  const tRow = (d, value, text) => ({ label: d.key, sub: d.title, value, text, color: color(d.project), onClick: () => openTicket(d.key),
    tip: [`${d.key} ${d.title}`, tr('{c} · {w} agent time · {r} runs', { c: fmtUsd(d.cost), w: fmtDur(d.work), r: d.runs }), d.model ? tr('model {m}', { m: d.model }) : ''].filter(Boolean) });
  grid.append(card(tr('Most expensive tickets'), tr('Done in the window'), barList([...done].sort((a, b) => b.cost - a.cost).filter(d => d.cost > 0).map(d => tRow(d, d.cost, fmtUsd(d.cost))))));
  grid.append(card(tr('Longest agent time'), tr('Done in the window, all runs added up'), barList([...done].sort((a, b) => b.work - a.work).filter(d => d.work > 0).map(d => tRow(d, d.work, fmtDur(d.work))))));
  const sRows = [...m.winSess].sort((a, b) => b.cost - a.cost).filter(s => s.cost > 0).map(s => ({ label: s.title || s.id.slice(0, 8), long: true, value: s.cost, text: fmtUsd(s.cost),
    onClick: () => h.openSession(s.id), tip: [s.title || s.id, `${KIND[s.kind]} · ${s.project || ''}`, tr('{h} active · {t} turns · {n} tool calls', { h: fmtDur(s.ms), t: s.turns, n: s.tools })] }));
  grid.append(card(tr('Most expensive sessions'), tr('Any kind; click to open'), barList(sRows)));

  // ---- time use ----
  const days = [tr('Mon'), tr('Tue'), tr('Wed'), tr('Thu'), tr('Fri'), tr('Sat'), tr('Sun')];
  const hrs = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
  grid.append(card(tr('When the floor runs'), tr('Agent hours by weekday and hour, local time'), heatmap(m.heat, days, hrs, { tipFor: (r, c2, v) => [`${days[r]} ${hrs[c2]}:00`, tr('{h} agent hours', { h: v.toFixed(1) })] })));
  const fmtC = b => (b.e - b.s) <= H ? new Date(b.s).toLocaleString(LOCALE, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : fmtB(b);
  const conc = m.conc.map(b => ({ label: (b.e - b.s) <= H && st.range !== '24h' ? new Date(b.s).toLocaleDateString(LOCALE, { month: 'numeric', day: 'numeric' }) : fmtB(b), v: b.v,
    tip: [fmtC(b), tr('{n} workers busy on average', { n: b.v.toFixed(1) }), tr('cap {c}', { c: m.cap })] }));
  grid.append(card(tr('Workers busy'), m.conc.length && m.conc[0].e - m.conc[0].s <= H ? tr('Average at once, per hour; the dashed line is the cap') : tr('Average at once; the dashed line is the cap'), area(conc, { fmt: v => v.toFixed(1), refLine: m.cap, refLabel: tr('cap {c}', { c: m.cap }) }), { span: 2 }));

  const reasons = Object.entries(m.reasons).sort((a, b) => b[1] - a[1]).map(([k, v], i) => ({ label: REASON[k] || k, value: v, text: fmtN(v) }));
  grid.append(card(tr('Why tickets went back to the queue'), tr('In progress → todo, by reason'), barList(reasons)));
  const hl = [tr('<15m'), tr('<30m'), tr('<1h'), tr('<2h'), tr('<4h'), tr('<8h'), tr('<1d'), tr('<3d'), tr('3d+')];
  grid.append(card(tr('Cycle time'), tr('Done tickets by claim-to-done time'), columns(m.hist.map((v, i) => ({ label: hl[i], segs: [{ v, color: 'var(--st-c1)' }], tip: [hl[i], trp(v, '{n} ticket', '{n} tickets')] })), { height: 130 })));
  const QC = 'var(--st-c4)', WC = 'var(--st-c1)', RC = 'var(--st-c2)';
  const split = m.projects.filter(p => p.done).sort((a, b) => b.done - a.done).slice(0, 8).map(p => {
    const q = med(p.queue), w = med(p.work), r = med(p.review);
    return { label: p.key, total: fmtDur(q + w + r), onClick: () => set('project', p.key),
      parts: [{ name: tr('Waiting to start'), v: q, color: QC, text: fmtDur(q) }, { name: tr('Agent working'), v: w, color: WC, text: fmtDur(w) }, { name: tr('In review'), v: r, color: RC, text: fmtDur(r) }] };
  });
  grid.append(card(tr('Where a ticket’s time goes'), tr('Median per done ticket, by project'), splitBars(split, [[tr('Waiting to start'), QC], [tr('Agent working'), WC], [tr('In review'), RC]])));
  root.append(grid);
}
const med = xs => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };
