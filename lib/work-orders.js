// Work orders from Slack: one-way instructions posted in a channel, turned into backlog tickets and notes.
// chito checks the channel in process (warm: every minute after you post, easing back to the normal interval).
// For each new top-level message from an allowed person it reacts 👀, runs a headless `claude -p` triage that may
// only use bl, mem and read tools, replies in the thread with what it filed and reacts ✅ (❌ with the reason if it
// failed). A reply in the thread is a follow-up to the same order. A message starting with ? is a quick command
// (lib/work-orders-commands.js), and `?ask` relays a message to a live session through bl msg.
// The thread hears only what matters: a ticket done (with its PR), failed, canceled or waiting on you, and one
// "All done" when the whole order is finished. Not every step of a ticket's life.
//   settings  ~/.config/chito/work-orders.json  (Settings → Work orders)
//   state     ~/.backlog/work-orders.json       (cursor, orders, their tickets, pending asks)
//   files     ~/.backlog/work-orders-files/<order ts>/  (screenshots and attachments, Read by the triage and the worker)
//   token     CHITO_SLACK_TOKEN, or settings.tokenKey looked up in ~/.extra_secrets (never sent to the browser)
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { HOME } from './index.js';
import { slackClient, esc, formatTriage, formatUpdates, sessionLink, ARTI } from './work-orders-slack.js';
import { isCommand, runCommand, usageGuide } from './work-orders-commands.js';
export { usageGuide, slackClient };

const SETTINGS_FILE = process.env.CHITO_WO_SETTINGS || path.join(HOME, '.config/chito/work-orders.json');
const STATE_FILE = process.env.CHITO_WO_STATE || path.join(HOME, '.backlog/work-orders.json');
const SECRETS = path.join(HOME, '.extra_secrets');
const FILES_DIR = process.env.CHITO_WO_FILES || path.join(HOME, '.backlog/work-orders-files');
const MAX_FILES = 10;
const BL = process.env.CHITO_BL || 'bl';
export const EVERY_STEPS = [5, 10, 15, 30, 60];
export const DEFAULTS = { enabled: false, channel: '', everyMin: 10, warm: true, project: '', users: '', model: 'opus', tokenKey: 'CHITO_SLACK_TOKEN', resetAt: null };
const TRACK_DAYS = 14;        // follow an order's thread this long after its last activity
const ASK_HOURS = 24;         // give up waiting for a session's answer after this long
const FINAL = new Set(['done', 'canceled', 'failed']);
const REPORT = new Set(['done', 'canceled', 'failed', 'needs_you']);   // the only moves worth a message

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 2)); fs.renameSync(t, f); };
const nowTs = () => (Date.now() / 1000).toFixed(6);

export function loadSettings() { return { ...DEFAULTS, ...readJson(SETTINGS_FILE, {}) }; }
// Only the fields the UI may change, checked; returns the saved settings.
export function saveSettings(patch) {
  const cur = loadSettings(), next = { ...cur };
  if ('enabled' in patch) next.enabled = !!patch.enabled;
  if ('warm' in patch) next.warm = !!patch.warm;
  if ('channel' in patch) {
    const c = String(patch.channel || '').trim().replace(/^#/, '');
    if (c && !/^[a-z0-9._-]{1,80}$|^[CG][A-Z0-9]{6,}$/.test(c)) throw new Error('channel: a name like mapcouch-work-orders or an id like C0123ABC');
    next.channel = c;
  }
  if ('everyMin' in patch) {
    const n = Number(patch.everyMin);
    if (!EVERY_STEPS.includes(n)) throw new Error(`every: one of ${EVERY_STEPS.join(', ')} minutes`);
    next.everyMin = n;
  }
  if ('project' in patch) {
    const p = String(patch.project || '').trim().toUpperCase();
    if (p && !/^[A-Z0-9_-]{1,40}$/.test(p)) throw new Error('project: a backlog project key');
    next.project = p;
  }
  if ('users' in patch) next.users = String(patch.users || '').split(/[\s,]+/).filter(u => /^[UW][A-Z0-9]{6,}$/.test(u)).join(',');
  if ('model' in patch && ['opus', 'sonnet', 'haiku'].includes(patch.model)) next.model = patch.model;
  if (next.enabled && !next.users) throw new Error('Only from: add your Slack user ID first; chito answers nobody else');
  // Turning it on or switching channels starts from this moment: older history there is not a pile of orders.
  if (next.channel !== cur.channel || (next.enabled && !cur.enabled)) next.resetAt = nowTs();
  writeJson(SETTINGS_FILE, next);
  if (next.resetAt !== cur.resetAt) { status.gapMin = null; soon = true; }
  reschedule();
  return next;
}
export function loadState() { return { channel: null, channelId: null, cursor: null, resetAt: null, orders: {}, asks: [], ...readJson(STATE_FILE, {}) }; }
function saveState(st) { writeJson(STATE_FILE, st); }

function token(settings) {
  if (process.env.CHITO_SLACK_TOKEN) return process.env.CHITO_SLACK_TOKEN;
  try {
    const line = fs.readFileSync(SECRETS, 'utf8').split('\n').find(l => l.startsWith(settings.tokenKey + '='));
    return line ? line.slice(settings.tokenKey.length + 1).trim().replace(/^["']|["']$/g, '') : null;
  } catch { return null; }
}

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  const child = execFile(cmd, args, { maxBuffer: 16 << 20, timeout: 60000, ...opts }, (err, stdout, stderr) =>
    err ? reject(Object.assign(err, { message: String(stderr || err.message).trim().replace(/^bl: /, '').slice(0, 500) })) : resolve(String(stdout)));
  if (opts.input != null) { child.stdin.on('error', () => {}); child.stdin.end(opts.input); }
});
const cleanEnv = () => ({ ...process.env, CLAUDE_CODE_SESSION_ID: '', BL_TICKET: '', BL_AGENT: 'chito-work-orders' });
const blJson = async args => JSON.parse(await run(BL, [...args, '--json'], { env: cleanEnv(), timeout: 30000 }));

// Each ticket's state, title and links; "needs_you" when the board lists it as waiting on a human.
export async function ticketStates(keys) {
  const out = {};
  if (!keys.length) return out;
  let waiting = new Set();
  try { waiting = new Set((await blJson(['status'])).projects.flatMap(p => (p.needs_human || []).map(w => w.key))); } catch { /* keep plain states */ }
  for (const k of keys) {
    try {
      const t = await blJson(['show', k]);
      out[k] = { state: !FINAL.has(t.state) && waiting.has(k) ? 'needs_you' : t.state, title: t.title, project: t.project, result: t.result, doc_slug: t.doc_slug };
    } catch { /* gone or bl unavailable: keep the last known state */ }
  }
  return out;
}

// ---- triage: one headless claude run per order (or follow-up), limited to bl, mem and reading ----
const TRIAGE_TOOLS = ['Bash(bl:*)', 'Bash(mem:*)', 'Read', 'Grep', 'Glob'];
export function triagePrompt({ text, thread, tickets, settings, author, files = [] }) {
  return [
    'You are triaging a work order the user posted in Slack. It is a one-way instruction: they are away and will not answer questions,',
    'so decide sensibly yourself and record any assumption in the ticket body. You can only run `bl` and `mem` and read files.',
    '',
    'Turn it into backlog work with the `bl` CLI (see the backlog skill: Simple mode, coarse tickets, a clear "Done when:" in each body).',
    `Pick the project that fits with \`bl project ls\`${settings.project ? `; default to ${settings.project} when nothing fits better` : ''}.`,
    'Create tickets with `bl add <PROJECT> "<title>" -b "<body>" --json`. Prefer one ticket; split only when the parts are really separate.',
    'If part of it is a fact, decision, preference or idea rather than work, save it as a note with',
    '`mem add "<title>" "<body>" -k note|decision|todo -p <project>` (see ~/docs/memory/README.md) instead of a ticket.',
    'If it is a follow-up in a thread that already has tickets, act on those tickets instead (bl comment, bl set, bl cancel, bl reopen)',
    'and only add new tickets for new work. Do not do the work itself; only file and update.',
    'If the message is only a test or a greeting, file nothing and say so.',
    '',
    `From: Slack user ${author}`,
    tickets.length ? `Tickets already made from this order: ${tickets.join(', ')}` : '',
    thread ? `The thread so far (oldest first):\n${thread}\n\nThe new message to act on:` : 'The work order:',
    '"""', text || '(no text, only attachments)', '"""',
    '',
    ...(files.length ? [
      'Attached to this message (saved locally):',
      ...files.map(f => f.path ? `- ${f.path}  (${f.name}, ${f.mimetype || 'file'})` : `- ${f.name}: could not be fetched (${f.error})`),
      'Read every attached image and text file before filing: screenshots usually carry the actual problem (an error message,',
      'the broken UI). Write what they show into the ticket body (quote error text exactly), and add an "Attachments:" line',
      'listing the local paths so the worker can Read them too.',
      '',
    ] : []),
    'End your answer with exactly one fenced ```json block and nothing after it:',
    '{"tickets":[{"key":"MC-GENERAL-1","title":"...","action":"created|commented|updated|canceled|reopened"}],',
    ' "notes":[{"title":"...","kind":"note|decision|todo"}], "links":[{"title":"...","url":"https://..."}],',
    ' "summary":"one or two plain sentences on what you did and why"}',
    '("links" only for pages the order points at, e.g. an arti doc it names; usually empty.)',
  ].filter(x => x !== '').join('\n');
}
export function parseTriage(out) {
  let text = out, j = null;
  try { j = JSON.parse(out); } catch { /* plain text output */ }
  if (j && j.is_error) throw new Error(String(j.result || 'claude failed').slice(0, 300));
  if (j && typeof j.result === 'string') text = j.result;
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (!blocks.length) throw new Error('triage gave no json block: ' + text.slice(-300));
  const r = JSON.parse(blocks[blocks.length - 1][1]);
  return {
    tickets: (r.tickets || []).filter(t => t && typeof t.key === 'string'),
    notes: (r.notes || []).filter(n => n && n.title),
    links: (r.links || []).filter(l => l && /^https:\/\//.test(l.url || '')),
    summary: String(r.summary || ''),
  };
}
async function claudeTriage(args) {
  const out = await run('claude', ['-p', triagePrompt(args), '--model', args.settings.model || 'opus', '--output-format', 'json',
    '--allowedTools', ...TRIAGE_TOOLS, '--disallowedTools', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch'],
    { env: cleanEnv(), cwd: HOME, timeout: 15 * 60000 });
  return parseTriage(out);
}

// ---- ?ask: relay a message to a live session (bl msg), and its answer back ----
async function blAsk(sessionId, text) { return JSON.parse(await run(BL, ['msg', 'send', sessionId, '-', '--json'], { env: cleanEnv(), input: text, timeout: 20000 })).id; }
async function blAnswers(sessionId) { return (await blJson(['msg', 'ls', sessionId, '--limit', '200'])).messages || []; }

// ---- status for the settings page ----
const status = { running: false, lastAt: null, lastResult: null, lastError: null, nextAt: null, gapMin: null };
export function workOrdersStatus() {
  const st = loadState();
  const orders = Object.values(st.orders);
  return { settings: loadSettings(), steps: EVERY_STEPS, hasToken: !!token(loadSettings()), ...status,
    orders: orders.length, open: orders.filter(isOpen).length, asks: st.asks.length,
    recent: orders.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 8).map(o => ({ ts: o.ts, text: o.text.slice(0, 140), tickets: o.tickets, states: o.states, error: o.error || null })) };
}
const isOpen = o => o.tickets.some(k => !FINAL.has(o.states[k]));

// Only people on the allow list: an empty list answers nobody.
const fromAllowed = (m, me, allowed) => (!m.subtype || m.subtype === 'file_share') && !m.bot_id && m.user && m.user !== me && allowed.includes(m.user) && ((m.text || '').trim() || m.files?.length);

// The message's files, downloaded for the triage; a file that can't be fetched is listed with why, never fatal.
async function fetchFiles(slack, order, msg) {
  const out = [];
  for (const f of (msg.files || []).slice(0, MAX_FILES)) {
    const name = f.name || f.title || f.id;
    if (f.mode === 'tombstone' || f.mode === 'external') { out.push({ name, error: f.mode === 'external' ? 'an external link' : 'deleted' }); continue; }
    try {
      if (!slack.download) throw new Error('no downloader');
      out.push({ name, mimetype: f.mimetype || '', path: await slack.download(f, path.join(FILES_DIR, String(order.ts).replace(/[^\d.]/g, ''))) });
    } catch (e) { out.push({ name, error: e.message.slice(0, 200) }); }
  }
  return out;
}

// host: { sessions() } from server.js, for ?ask and ?sessions.
let host = {};
// deps: { slack, triage, states, commands, ask, answers } so tests can run it without Slack, claude or bl.
export async function tick(deps = {}) {
  const settings = loadSettings();
  if (!settings.channel) throw new Error('no channel set');
  const allowed = settings.users ? settings.users.split(',') : [];
  if (!allowed.length) throw new Error('no allowed users set (Only from)');
  const tok = deps.slack ? null : token(settings);
  if (!deps.slack && !tok) throw new Error(`no Slack token (set CHITO_SLACK_TOKEN or ${settings.tokenKey} in ~/.extra_secrets)`);
  const slack = deps.slack || slackClient(tok);
  const triage = deps.triage || claudeTriage;
  const states = deps.states || ticketStates;
  const ask = deps.ask || blAsk, answers = deps.answers || blAnswers;
  const sessions = deps.sessions || host.sessions || (() => []);
  const summary = { orders: 0, followups: 0, updates: 0, commands: 0, answers: 0, waiting: 0 };

  const st = loadState();
  const me = await slack.me();
  // A new channel (or turning it on) starts from the moment it was set; orders keep the channel they came from.
  if (st.channel !== settings.channel || st.resetAt !== settings.resetAt || !st.channelId) {
    st.channelId = await slack.resolve(settings.channel);
    st.channel = settings.channel; st.resetAt = settings.resetAt; st.cursor = settings.resetAt || nowTs();
    saveState(st);
  }
  const ch = st.channelId;
  const post = (o, text, broadcast) => slack.post(o.channel || ch, o.ts, text, broadcast);

  // An order left mid-triage (chito restarted): don't triage again, its tickets may exist. Say so once.
  for (const o of Object.values(st.orders)) {
    if (!o.pending) continue;
    o.pending = false; o.error = 'chito restarted while filing this';
    await post(o, '*Interrupted.* chito restarted while filing this, so some tickets may already exist. Check `?orders`, then reply here to finish it.').catch(() => {});
    saveState(st);
  }

  const command = async (msg, order) => {
    const threadTs = order ? order.ts : msg.ts;
    let text, asked = null;
    try {
      text = await runCommand(msg.text, { ...(deps.commands || {}), channel: settings.channel, artiBase: ARTI, orders: () => Object.values(st.orders), sessions,
        ask: async (sid, title, body) => { const id = await ask(sid, body); asked = { msgId: id, session: sid, title, threadTs, channel: order?.channel || ch, at: new Date().toISOString() }; return id; } });
    } catch (e) { text = `*Couldn't do that:* ${esc(e.message)}`; }
    try {
      await slack.post(order?.channel || ch, threadTs, text);
      await slack.react(order?.channel || ch, msg.ts, 'zap').catch(() => {});
    } catch (e) { console.error('[chito] work orders: command reply', e.message); }
    if (asked) st.asks.push(asked);
    summary.commands++;
  };

  const handle = async (order, msg, thread) => {
    const c = order.channel || ch;
    await slack.react(c, msg.ts, 'eyes').catch(() => {});
    order.pending = true; saveState(st);
    let r = null;
    const files = await fetchFiles(slack, order, msg);
    if (files.length) order.files = [...(order.files || []), ...files.filter(f => f.path).map(f => f.path)];
    try {
      r = await triage({ text: msg.text || '', thread, tickets: order.tickets, settings, author: msg.user, files });
    } catch (e) {
      order.pending = false; order.error = e.message.slice(0, 300);
      order.seen.push(msg.ts); order.activeAt = new Date().toISOString(); saveState(st);
      await slack.unreact(c, msg.ts, 'eyes');
      await slack.react(c, msg.ts, 'x').catch(() => {});
      await post(order, `*Couldn't file this.* ${esc(order.error)}\n_Reply in this thread to try again._`).catch(() => {});
      return;
    }
    // Keep only tickets bl knows; record before replying, so a failed reply never files twice.
    const known = await states(r.tickets.map(t => t.key)).catch(() => ({}));
    r.tickets = r.tickets.filter(t => known[t.key]).map(t => ({ ...known[t.key], ...t, title: t.title || known[t.key].title, state: known[t.key].state, project: known[t.key].project }));
    for (const t of r.tickets) { if (!order.tickets.includes(t.key)) order.tickets.push(t.key); order.states[t.key] = t.state; }
    order.notes.push(...r.notes.map(n => n.title));
    order.pending = false; order.error = null; order.seen.push(msg.ts); order.activeAt = new Date().toISOString();
    saveState(st);
    r.files = files;
    try {
      await post(order, formatTriage(r));
      await slack.unreact(c, msg.ts, 'eyes');
      await slack.react(c, msg.ts, 'white_check_mark');
    } catch (e) { console.error('[chito] work orders: reply', order.ts, e.message); }
  };

  // 1. New top-level messages, oldest first.
  const fresh = (await slack.history(ch, st.cursor)).filter(m => Number(m.ts) > Number(st.cursor)).sort((a, b) => Number(a.ts) - Number(b.ts));
  for (const m of fresh) {
    st.cursor = m.ts;
    if (!fromAllowed(m, me, allowed) || (m.thread_ts && m.thread_ts !== m.ts) || st.orders[m.ts]) { saveState(st); continue; }
    if (isCommand(m.text)) { await command(m, null); saveState(st); continue; }
    const order = st.orders[m.ts] = { ts: m.ts, channel: ch, user: m.user, text: m.text || '', tickets: [], states: {}, notes: [], seen: [], error: null, pending: false, activeAt: null };
    await handle(order, m, '');
    summary.orders++;
  }
  saveState(st);

  // 2. Follow-ups and the moves worth reporting, per tracked order; one bad order never stops the rest.
  const cutoff = Date.now() - TRACK_DAYS * 864e5;
  for (const order of Object.values(st.orders)) {
    const recent = new Date(order.activeAt || 0).getTime() >= cutoff;
    if (!recent && !isOpen(order)) continue;
    try {
      if (recent) {
        const msgs = (await slack.replies(order.channel || ch, order.ts).catch(e => { console.error('[chito] work orders: thread', order.ts, e.message); return []; })).filter(Boolean);
        for (const r of msgs) {
          if (r.ts === order.ts || order.seen.includes(r.ts) || !fromAllowed(r, me, allowed)) continue;
          if (isCommand(r.text)) { order.seen.push(r.ts); await command(r, order); saveState(st); continue; }
          const thread = msgs.filter(x => Number(x.ts) < Number(r.ts)).map(x => `[${x.user === me ? 'chito' : x.user || x.bot_id}] ${x.text || ''}${x.files?.length ? `  [attached: ${x.files.map(f => f.name).join(', ')}]` : ''}`).join('\n');
          await handle(order, r, thread);
          summary.followups++;
        }
      }
      if (!order.tickets.length) continue;
      const now = await states(order.tickets);
      const changes = [], next = { ...order.states };
      for (const [k, v] of Object.entries(now)) {
        if (v.state && v.state !== order.states[k]) { next[k] = v.state; if (REPORT.has(v.state)) changes.push({ ...v, key: k, from: order.states[k], to: v.state }); }
      }
      if (changes.length) {
        // The order's last ticket finishing is also sent to the channel, so it shows outside the thread.
        const allDone = order.tickets.every(k => FINAL.has(next[k]));
        await post(order, formatUpdates(changes, { allDone }), allDone);
        order.activeAt = new Date().toISOString();
        summary.updates += changes.length;
      }
      order.states = next;   // only after the post went out (or nothing needed posting)
      saveState(st);
    } catch (e) { console.error('[chito] work orders: order', order.ts, e.message); }
  }

  // 3. Answers from sessions to ?ask.
  const keep = [];
  for (const a of st.asks) {
    try {
      const reply = (await answers(a.session)).find(m => m.dir === 'out' && m.reply_to === a.msgId);
      if (reply) {
        await slack.post(a.channel, a.threadTs, `*${sessionLink(a.session, a.title)} replied*\n${esc(reply.body).slice(0, 3500)}`);
        summary.answers++; continue;
      }
      if (Date.now() - new Date(a.at) > ASK_HOURS * 36e5) { await slack.post(a.channel, a.threadTs, `_No answer from ${sessionLink(a.session, a.title)} after ${ASK_HOURS} hours; I stopped waiting._`); continue; }
    } catch (e) { console.error('[chito] work orders: ask', a.msgId, e.message); }
    keep.push(a);
  }
  st.asks = keep; summary.waiting = keep.length;
  saveState(st);
  return summary;
}

// ---- in-process schedule ----
let timer = null, started = false, soon = false;
export async function runNow(deps) {
  if (status.running) return { ok: false, error: 'a check is already running' };
  status.running = true;
  try {
    const r = await tick(deps);
    status.lastResult = r; status.lastError = null;
    if (r.orders || r.followups || r.updates || r.commands || r.answers) console.log('[chito] work orders:', JSON.stringify(r));
    return { ok: true, ...r };
  } catch (e) {
    status.lastError = e.message.slice(0, 300);
    console.error('[chito] work orders:', e.message);
    return { ok: false, error: status.lastError };
  } finally { status.running = false; status.lastAt = new Date().toISOString(); }
}
// Warm checks: after anything from you the next check is in 1 minute, then the gap doubles (2, 4, 8…) back to the
// normal interval. While a session's answer is awaited, it stays at 2 minutes or less.
export function nextGap(prevGap, result, s) {
  if (!s.warm) return s.everyMin;
  if (result && (result.orders || result.followups || result.commands || result.answers)) return 1;
  const g = Math.min(s.everyMin, (prevGap || s.everyMin) * 2);
  return result?.waiting ? Math.min(g, 2) : g;
}
function reschedule() {
  if (!started) return;
  clearTimeout(timer); timer = null; status.nextAt = null;
  const s = loadSettings();
  if (!s.enabled || !s.channel) return;
  status.gapMin = soon ? 1 : nextGap(status.gapMin, status.lastError ? null : status.lastResult, s);
  soon = false;
  const ms = status.gapMin * 60000;
  status.nextAt = new Date(Date.now() + ms).toISOString();
  timer = setTimeout(async () => { if (!status.running) await runNow(); reschedule(); }, ms);
}
// A "Check now" from the page: run, then start the gap over from the result.
export async function checkNow() { const r = await runNow(); reschedule(); return r; }
export function startWorkOrders(h = {}) {
  host = h; started = true;
  const s = loadSettings();
  if (s.enabled && s.channel) runNow().finally(reschedule);
}
