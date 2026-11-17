// Settings → Work orders: the Slack channel chito checks for work orders, how often, and where tickets go.
import { t, tp } from '/i18n.js';

const $ = s => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const ago = iso => {
  if (!iso) return null;
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  return s < 60 ? t('just now') : t('{rel} ago', { rel: s < 3600 ? t('{n}m', { n: Math.round(s / 60) }) : t('{n}h', { n: Math.round(s / 3600) }) });
};
const until = iso => { const m = Math.max(0, Math.round((new Date(iso) - Date.now()) / 60000)); return t('in {n} min', { n: m }); };

let data = null, poll = null;
async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'x-chito': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || r.statusText);
  return d;
}
async function save(patch) {
  try { data = await api('/api/work-orders/settings', patch); render(); }
  catch (e) { render(); $('#wo-status').textContent = e.message; $('#wo-status').classList.add('wo-err'); }
}

function seg(values, cur, label, onPick) {
  const s = el('div', 'seg');
  s.setAttribute('role', 'radiogroup');
  for (const [v, text] of values) {
    const b = el('button', null, text);
    b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(v === cur));
    b.addEventListener('click', () => { if (v !== cur) onPick(v); });
    s.append(b);
  }
  return s;
}
function field(value, placeholder, onSave) {
  const i = el('input', 'wo-input');
  i.value = value || ''; i.placeholder = placeholder; i.spellcheck = false;
  const commit = () => { if (i.value.trim() !== (value || '')) onSave(i.value.trim()); };
  i.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); i.blur(); } e.stopPropagation(); });
  i.addEventListener('blur', commit);
  return i;
}
function row(label, note, control) {
  const r = el('div', 'opt-row');
  const l = el('div', 'opt-label');
  l.append(el('b', null, label), el('span', null, note));
  r.append(l, control);
  return r;
}

function group(caption, ...rows) {
  const g = el('section', 'wo-group');
  g.append(el('h3', 'wo-caption', caption), ...rows);
  return g;
}
const STATE_TEXT = { backlog: 'backlog', todo: 'queued', in_progress: 'running', staged: 'PR open', parked: 'parked', done: 'done', failed: 'failed', canceled: 'canceled', needs_you: 'needs you' };

function statusCard(s) {
  const card = el('div', 'wo-card');
  const on = s.enabled && s.channel && data.hasToken;
  const dot = el('span', 'wo-dot ' + (data.lastError ? 'bad' : on ? 'on' : 'off'));
  const head = el('div', 'wo-card-head');
  const title = el('b', null, !s.channel ? t('No channel yet') : on ? t('Watching #{channel}', { channel: s.channel }) : t('Paused: #{channel}', { channel: s.channel }));
  head.append(dot, title);
  const bits = [];
  if (!data.hasToken) bits.push(t('No Slack token: set CHITO_SLACK_TOKEN'));
  if (data.running) bits.push(t('Checking now…'));
  else if (data.lastAt) bits.push(t('Last check {when}', { when: ago(data.lastAt) }));
  if (on && data.nextAt && !data.running) bits.push(data.gapMin && data.gapMin < s.everyMin ? t('next {when} (warm)', { when: until(data.nextAt) }) : t('next {when}', { when: until(data.nextAt) }));
  const sub = el('div', 'wo-sub', bits.join(' · '));
  sub.id = 'wo-status';
  const counts = el('div', 'wo-counts');
  for (const [n, label] of [[data.orders, tp(data.orders, 'order', 'orders')], [data.open, t('open')], [data.asks, tp(data.asks, 'answer awaited', 'answers awaited')]]) {
    const c = el('span', 'wo-count'); c.append(el('b', null, String(n)), el('span', null, label)); counts.append(c);
  }
  const now = el('button', 'btn wo-now', data.running ? t('Checking…') : t('Check now'));
  now.type = 'button'; now.disabled = data.running || !s.channel || !s.users;
  now.addEventListener('click', async () => { try { data = await api('/api/work-orders/run', {}); } catch (e) { data.lastError = e.message; } render(); watch(); });
  const left = el('div', 'wo-card-main'); left.append(head, sub, counts);
  card.append(left, now);
  if (data.lastError) card.append(el('div', 'wo-err wo-card-err', data.lastError));
  return card;
}

function render() {
  const box = $('#wo-panel');
  if (!box || !data) return;
  const s = data.settings;
  box.textContent = '';
  box.append(
    statusCard(s),
    group(t('Channel'),
      row(t('Check Slack'), t('Read the channel and file what you post there'), seg([[true, t('On')], [false, t('Off')]], s.enabled, '', v => save({ enabled: v }))),
      row(t('Channel'), t('The bot must be in it'), field(s.channel, 'mapcouch-work-orders', v => save({ channel: v }))),
      row(t('Only from'), t('Slack user IDs, comma separated; nobody else is answered'), field(s.users, 'U0123ABCD', v => save({ users: v })))),
    group(t('Timing'),
      row(t('Check every'), t('The normal gap between checks'), seg(data.steps.map(n => [n, t('{n} min', { n })]), s.everyMin, '', v => save({ everyMin: v }))),
      row(t('Warm checks'), t('After you post: 1 minute, then 2, 4, 8… back to the normal gap'), seg([[true, t('On')], [false, t('Off')]], s.warm, '', v => save({ warm: v })))),
    group(t('Filing'),
      row(t('Default project'), t('Used when no project fits better'), field(s.project, 'MC-GENERAL', v => save({ project: v })))),
  );
  if (data.recent.length) {
    const list = el('ul', 'wo-recent');
    for (const o of data.recent) {
      const li = el('li');
      li.append(el('span', 'wo-text', o.text));
      const tk = el('span', 'wo-tickets');
      for (const k of o.tickets) {
        const a = el('a', 'wo-chip st-' + (o.states[k] || 'unknown'));
        a.href = `/projects/${encodeURIComponent(k.replace(/-\d+$/, ''))}/${encodeURIComponent(k)}`;
        a.append(el('b', null, k), el('span', null, STATE_TEXT[o.states[k]] || o.states[k] || ''));
        tk.append(a);
      }
      if (!o.tickets.length) tk.append(el('span', 'wo-none', o.error ? o.error : t('nothing filed')));
      li.append(tk);
      list.append(li);
    }
    box.append(group(t('Recent orders'), list));
  }
}
// While a check runs, refresh until it ends.
function watch() {
  clearTimeout(poll);
  if (!data?.running || $('#settings').hidden) return;
  poll = setTimeout(async () => { await load(); watch(); }, 3000);
}
export async function load() {
  try { data = await api('/api/work-orders'); render(); watch(); }
  catch (e) { const b = $('#wo-panel'); if (b) b.textContent = e.message; }
}
