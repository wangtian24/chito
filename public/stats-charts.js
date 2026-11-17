// Small chart kit for the Stats tab: cards, stat tiles, bar lists, stacked columns, an area line, a heatmap,
// 100% split bars and a sortable table. Plain DOM + inline SVG; one shared hover tooltip.
import { t as tr } from '/i18n.js';

export const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v); return e; };

// ---- tooltip ----
let tipEl = null;
export function tip(e, lines) {
  if (!tipEl) { tipEl = el('div', 'st-tip'); tipEl.setAttribute('role', 'tooltip'); document.body.append(tipEl); }
  tipEl.textContent = '';
  for (const [i, l] of lines.entries()) {
    if (Array.isArray(l)) {   // [swatch color, label, value]
      const r = el('div', 'st-tip-row'); const sw = el('span', 'st-sw'); sw.style.background = l[0];
      r.append(sw, el('span', null, l[1]), el('b', 'num', l[2])); tipEl.append(r);
    } else tipEl.append(el('div', i === 0 ? 'st-tip-h' : 'st-tip-row', l));
  }
  tipEl.classList.add('on');
  const r = e.currentTarget?.getBoundingClientRect?.();
  const x = e.clientX ?? (r ? r.left + r.width / 2 : 0), y = e.clientY ?? (r ? r.top : 0);
  const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  tipEl.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, x + 14))}px`;
  tipEl.style.top = `${Math.max(8, y - h - 12 < 8 ? y + 16 : y - h - 12)}px`;
}
export const untip = () => tipEl?.classList.remove('on');
function hover(node, lines) {
  node.addEventListener('mousemove', e => tip(e, typeof lines === 'function' ? lines() : lines));
  node.addEventListener('focus', e => tip(e, typeof lines === 'function' ? lines() : lines));
  node.addEventListener('mouseleave', untip); node.addEventListener('blur', untip);
}

// ---- layout ----
export function card(title, sub, body, { span = 1, cls = '' } = {}) {
  const c = el('section', `st-card st-span-${span}${cls ? ' ' + cls : ''}`);
  if (title) {
    const h = el('header', 'st-card-head'); h.append(el('h3', null, title));
    if (sub) h.append(el('p', 'st-card-sub', sub));
    c.append(h);
  }
  if (body) c.append(body);
  return c;
}
export function kpi(label, value, sub, delta) {
  const k = el('div', 'st-kpi');
  k.append(el('span', 'st-kpi-label', label), el('b', 'num st-kpi-value', value));
  const foot = el('span', 'num st-kpi-sub');
  if (delta && delta.text) { const d = el('span', `st-delta ${delta.tone || ''}`, delta.text); d.title = delta.title || ''; foot.append(d, ' '); }
  if (sub) foot.append(sub);
  k.append(foot);
  return k;
}
export const empty = text => el('div', 'st-empty', text || tr('Nothing in this window.'));

// rows: [{ label, value, text, color, sub, href, onClick, tip }]
export function barList(rows, { limit = 8 } = {}) {
  if (!rows.length) return empty();
  const max = Math.max(...rows.map(r => r.value), 1e-9);
  const list = el('ol', 'st-bars');
  for (const r of rows.slice(0, limit)) {
    const li = el('li', 'st-bar');
    const lab = el(r.href || r.onClick ? 'a' : 'span', 'st-bar-label');
    if (r.color) { const sw = el('span', 'st-sw'); sw.style.background = r.color; lab.append(sw); }
    lab.append(el('span', `st-bar-name${r.long ? ' long' : ''}`, r.label));
    if (r.sub) lab.append(el('span', 'st-bar-sub', r.sub));
    if (r.href) lab.href = r.href;
    if (r.onClick) { lab.href ||= '#'; lab.addEventListener('click', e => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); r.onClick(); }); }
    const track = el('span', 'st-bar-track');
    const fill = el('span', 'st-bar-fill'); fill.style.width = `${Math.max(0.5, r.value / max * 100)}%`;
    if (r.color) fill.style.background = r.color;
    track.append(fill);
    li.append(lab, track, el('b', 'num st-bar-val', r.text));
    if (r.tip) { li.tabIndex = -1; hover(li, r.tip); }
    list.append(li);
  }
  if (rows.length > limit) list.append(el('li', 'st-more', tr('{n} more', { n: rows.length - limit })));
  return list;
}

// cols: [{ label, segs: [{ v, color, name }], tip: [...] }]; axis labels under every `every`-th column.
export function columns(cols, { height = 150, every = 1, fmt = v => String(Math.round(v)), refLine } = {}) {
  const max = Math.max(...cols.map(c => c.segs.reduce((s, x) => s + x.v, 0)), refLine || 0, 1e-9);
  const wrap = el('div', 'st-cols-wrap');
  const plot = el('div', 'st-cols'); plot.style.height = `${height}px`;
  const scale = el('div', 'num st-scale'); scale.append(el('span', null, fmt(max)), el('span', null, fmt(max / 2)), el('span', null, '0'));
  cols.forEach(c => {
    const col = el('div', 'st-col'); col.tabIndex = 0;
    for (const s of c.segs) {
      if (!s.v) continue;
      const seg = el('span', 'st-seg'); seg.style.height = `${s.v / max * 100}%`; seg.style.background = s.color;
      col.append(seg);
    }
    hover(col, c.tip);
    plot.append(col);
  });
  if (refLine) { const r = el('div', 'st-ref'); r.style.bottom = `${refLine / max * 100}%`; plot.append(r); }
  const axis = el('div', 'num st-axis');
  cols.forEach((c, i) => axis.append(el('span', null, i % every === 0 || i === cols.length - 1 ? c.label : '')));
  wrap.append(scale, plot, axis);
  return wrap;
}

// points: [{ label, v, tip }]; one series as an area; refLine draws a dashed level (the cap).
export function area(points, { height = 150, fmt = v => String(v), refLine, refLabel } = {}) {
  if (points.length < 2) return empty();
  const W = 600, H = height, max = Math.max(...points.map(p => p.v), refLine || 0, 1e-9) * 1.08;
  const x = i => i / (points.length - 1) * W, y = v => H - v / max * H;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'st-area', role: 'img' });
  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  svg.append(svgEl('polygon', { points: `0,${H} ${line} ${W},${H}`, class: 'st-area-fill' }), svgEl('polyline', { points: line, class: 'st-area-line' }));
  if (refLine) svg.append(svgEl('line', { x1: 0, x2: W, y1: y(refLine), y2: y(refLine), class: 'st-area-ref' }));
  const cross = svgEl('line', { x1: 0, x2: 0, y1: 0, y2: H, class: 'st-cross' });
  svg.append(cross);
  const box = el('div', 'st-area-wrap'); box.style.height = `${H}px`;
  const scale = el('div', 'num st-scale'); scale.append(el('span', null, fmt(max)), el('span', null, fmt(max / 2)), el('span', null, '0'));
  if (refLine && refLabel) { const r = el('span', 'st-ref-label', refLabel); r.style.bottom = `${refLine / max * 100}%`; box.append(r); }
  box.append(svg);
  box.addEventListener('mousemove', e => {
    const r = box.getBoundingClientRect();
    const i = Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * (points.length - 1));
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.classList.add('on');
    tip(e, points[i].tip);
  });
  box.addEventListener('mouseleave', () => { cross.classList.remove('on'); untip(); });
  const axis = el('div', 'num st-axis st-axis-spread');
  const n = 6; for (let k = 0; k < n; k++) axis.append(el('span', null, points[Math.round(k / (n - 1) * (points.length - 1))].label));
  const wrap = el('div', 'st-cols-wrap'); wrap.append(scale, box, axis);
  return wrap;
}

// grid[row][col] values; rows/cols labels; cell shade = value/max in one hue.
export function heatmap(grid, rowLabels, colLabels, { fmt = v => String(v), tipFor } = {}) {
  const max = Math.max(...grid.flat(), 1e-9);
  const g = el('div', 'st-heat'); g.style.setProperty('--st-cols', String(colLabels.length));
  g.append(el('span'));
  colLabels.forEach((l, i) => g.append(el('span', 'num st-heat-col', i % 3 === 0 ? l : '')));
  grid.forEach((row, r) => {
    g.append(el('span', 'st-heat-row', rowLabels[r]));
    row.forEach((v, c) => {
      const cell = el('span', 'st-cell');
      cell.style.setProperty('--st-p', `${v ? 12 + Math.round(v / max * 88) : 0}%`);
      hover(cell, tipFor ? tipFor(r, c, v) : [`${rowLabels[r]} ${colLabels[c]}`, fmt(v)]);
      g.append(cell);
    });
  });
  return g;
}

// rows: [{ label, parts: [{ name, v, color, text }], total, href, onClick }] as 100% bars with a shared legend.
export function splitBars(rows, legend) {
  if (!rows.length) return empty();
  const box = el('div', 'st-split');
  const lg = el('div', 'st-legend');
  for (const [name, color] of legend) { const i = el('span', 'st-leg'); const sw = el('span', 'st-sw'); sw.style.background = color; i.append(sw, name); lg.append(i); }
  box.append(lg);
  for (const r of rows) {
    const line = el('div', 'st-split-row');
    const lab = el(r.onClick ? 'a' : 'span', 'st-bar-label', r.label);
    if (r.onClick) { lab.href = '#'; lab.addEventListener('click', e => { e.preventDefault(); r.onClick(); }); }
    const bar = el('span', 'st-split-bar');
    const tot = r.parts.reduce((s, p) => s + p.v, 0) || 1;
    for (const p of r.parts) { if (!p.v) continue; const s = el('span', 'st-seg'); s.style.width = `${p.v / tot * 100}%`; s.style.background = p.color; bar.append(s); }
    hover(bar, [r.label, ...r.parts.map(p => [p.color, p.name, `${p.text} · ${Math.round(p.v / tot * 100)}%`])]);
    line.append(lab, bar, el('b', 'num st-bar-val', r.total || ''));
    box.append(line);
  }
  return box;
}

// cols: [{ key, label, num, fmt, val, title }]; rows are objects; state: { col, dir } kept by the caller.
export function sortTable(cols, rows, state, { onRow, rowTitle, limit = 50, onSort } = {}) {
  const sorted = [...rows].sort((a, b) => {
    const c = cols.find(x => x.key === state.col) || cols[0];
    const va = c.val ? c.val(a) : a[c.key], vb = c.val ? c.val(b) : b[c.key];
    if (va == null && vb == null) return 0; if (va == null) return 1; if (vb == null) return -1;
    return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * state.dir;
  });
  const tbl = el('table', 'st-table');
  const thr = el('tr');
  for (const c of cols) {
    const th = el('th', c.num ? 'num' : null);
    const b = el('button', 'st-th', c.label); b.type = 'button'; if (c.title) b.title = c.title;
    if (state.col === c.key) { th.setAttribute('aria-sort', state.dir > 0 ? 'ascending' : 'descending'); b.append(state.dir > 0 ? ' ↑' : ' ↓'); }
    b.addEventListener('click', () => { if (state.col === c.key) state.dir = -state.dir; else { state.col = c.key; state.dir = c.num ? -1 : 1; } onSort?.(); });
    th.append(b); thr.append(th);
  }
  const thead = el('thead'); thead.append(thr); tbl.append(thead);
  const tb = el('tbody');
  for (const r of sorted.slice(0, limit)) {
    const tr_ = el('tr');
    if (onRow) { tr_.classList.add('click'); tr_.tabIndex = 0; tr_.addEventListener('click', () => onRow(r)); tr_.addEventListener('keydown', e => { if (e.key === 'Enter') onRow(r); }); }
    if (rowTitle) tr_.title = rowTitle(r);
    for (const c of cols) {
      const v = c.val ? c.val(r) : r[c.key];
      const td = el('td', c.num ? 'num' : null);
      const out = c.fmt ? c.fmt(v, r) : v ?? '–';
      if (out instanceof Node) td.append(out); else td.textContent = out == null ? '–' : String(out);
      tr_.append(td);
    }
    tb.append(tr_);
  }
  tbl.append(tb);
  const w = el('div', 'st-table-wrap'); w.append(tbl);
  return w;
}
