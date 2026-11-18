import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Slack for work orders: a small Web API client (bot token) and the mrkdwn the replies are written in.
const MAX_FILE = 20e6;
const CHITO_URL = process.env.CHITO_PUBLIC_URL || 'http://localhost:8791';

export function slackClient(tok) {
  const call = async (method, params, post) => {
    const url = `https://slack.com/api/${method}` + (post ? '' : '?' + new URLSearchParams(params));
    const r = await fetch(url, {
      method: post ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${tok}`, ...(post ? { 'content-type': 'application/json; charset=utf-8' } : {}) },
      body: post ? JSON.stringify(params) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const d = await r.json();
    if (!d.ok && !(method === 'reactions.add' && d.error === 'already_reacted') && !(method === 'reactions.remove' && d.error === 'no_reaction')) {
      throw new Error(`slack ${method}: ${d.error}`);
    }
    return d;
  };
  return {
    me: async () => (await call('auth.test', {})).user_id,
    resolve: async name => {
      if (/^[CG][A-Z0-9]{6,}$/.test(name)) return name;
      let cursor = '';
      do {
        const d = await call('conversations.list', { limit: 1000, types: 'public_channel,private_channel', exclude_archived: true, ...(cursor ? { cursor } : {}) });
        const c = d.channels.find(x => x.name === name);
        if (c) { if (!c.is_member) throw new Error(`the bot is not in #${name}; invite it there`); return c.id; }
        cursor = d.response_metadata?.next_cursor || '';
      } while (cursor);
      throw new Error(`no channel #${name} the bot can see`);
    },
    // Every top-level message after `oldest`, following pages (Slack gives the newest 100 first).
    history: async (channel, oldest) => {
      const all = [];
      let cursor = '';
      for (let page = 0; page < 20; page++) {
        const d = await call('conversations.history', { channel, limit: 200, oldest, ...(cursor ? { cursor } : {}) });
        all.push(...(d.messages || []));
        cursor = d.has_more ? d.response_metadata?.next_cursor || '' : '';
        if (!cursor) break;
      }
      return all;
    },
    replies: async (channel, ts) => (await call('conversations.replies', { channel, ts, limit: 200 })).messages || [],
    post: async (channel, thread_ts, text, broadcast = false) =>
      (await call('chat.postMessage', { channel, thread_ts, text, unfurl_links: false, unfurl_media: false, ...(broadcast ? { reply_broadcast: true } : {}) }, true)).ts,
    react: (channel, ts, name) => call('reactions.add', { channel, timestamp: ts, name }, true),
    unreact: (channel, ts, name) => call('reactions.remove', { channel, timestamp: ts, name }, true).catch(() => {}),
    // A file attached to a message (needs the files:read scope), saved in `dir`; returns its local path.
    download: async (file, dir) => {
      // Some payloads carry only the file's id; files.info has the rest.
      if (!file.url_private_download && !file.url_private && file.id) file = { ...file, ...(await call('files.info', { file: file.id })).file };
      const url = file.url_private_download || file.url_private;
      if (!url) throw new Error(`${file.name || file.id}: no download url (${file.mode || 'unknown'} file)`);
      if (file.size > MAX_FILE) throw new Error(`${file.name}: too big (${Math.round(file.size / 1e6)} MB)`);
      const r = await fetch(url, { headers: { authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error(`${file.name}: download ${r.status}`);
      // Without files:read Slack answers with its sign-in page instead of the file.
      if (/text\/html/.test(r.headers.get('content-type') || '') && !/html/.test(file.mimetype || '')) throw new Error(`${file.name}: Slack sent a sign-in page (does the bot token have files:read?)`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_FILE) throw new Error(`${file.name}: too big`);
      fs.mkdirSync(dir, { recursive: true });
      const safe = String(file.name || 'file').replace(/[^\w.-]+/g, '_').replace(/^[._]+/, '').slice(-80) || 'file';
      const dest = path.join(dir, `${String(file.id || 'F').replace(/\W/g, '')}-${safe}`);
      fs.writeFileSync(dest, buf);
      return dest;
    },
  };
}

// ---- mrkdwn ----
export const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const projectOf = key => String(key).replace(/-\d+$/, '');
export const ticketLink = (key, project) => `<${CHITO_URL}/projects/${encodeURIComponent(project || projectOf(key))}/${encodeURIComponent(key)}|${esc(key)}>`;
export const projectLink = p => `<${CHITO_URL}/projects/${encodeURIComponent(p)}|${esc(p)}>`;
export const sessionLink = (id, title) => `<${CHITO_URL}/s/${encodeURIComponent(id)}|${esc(title || id.slice(0, 8))}>`;
const STATE_WORDS = {
  backlog: 'in the backlog', todo: 'queued', in_progress: 'started', staged: 'PR open, tests running',
  parked: 'parked, PR waiting to merge', done: 'done', failed: 'failed', canceled: 'canceled',
};
export const stateWord = s => STATE_WORDS[s] || String(s || '').replace(/_/g, ' ');
const PR_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/;
export const prOf = result => { const m = (typeof result === 'string' ? result : JSON.stringify(result ?? '')).match(PR_RE); return m ? { url: m[0], n: m[1] } : null; };
export const prLink = pr => pr ? `<${pr.url}|PR #${pr.n}>` : '';
export const ARTI = (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/chito/config.json'), 'utf8')).artiBase || null; } catch { return null; } })();
export const artiLink = (slug, text) => !slug ? '' : /^https:\/\//.test(slug) ? `<${slug}|${esc(text || slug)}>` : ARTI ? `<${ARTI.replace(/\/$/, '')}/s/${encodeURIComponent(slug)}|${esc(text || slug)}>` : '';

// Bullets, with a bold heading per project once there is more than one project or more than `flat` items.
export function grouped(items, line, { flat = 3, max = 25 } = {}) {
  if (!items.length) return ['_None._'];
  const shown = items.slice(0, max), by = new Map();
  for (const it of shown) { const p = it.project || projectOf(it.key); if (!by.has(p)) by.set(p, []); by.get(p).push(it); }
  const out = by.size === 1 && shown.length <= flat ? shown.map(x => line(x)) : [...by].flatMap(([p, xs], i) => [...(i ? [''] : []), `*${projectLink(p)}*`, ...xs.map(x => line(x))]);
  if (items.length > max) out.push(`_…and ${items.length - max} more._`);
  return out;
}
// "• MC-GENERAL-9  Fix the legend  _queued_ · PR #12 · spec"
export const ticketLine = (t, extra = '') => {
  const bits = [t.state ? `_${stateWord(t.state)}_` : '', prLink(prOf(t.result)), artiLink(t.doc_slug, 'spec'), extra].filter(Boolean);
  return `• ${ticketLink(t.key, t.project)}  ${esc(t.title || '')}${bits.length ? '  ' + bits.join(' · ') : ''}`;
};
// A small aligned table in a code block (no links inside code; keep links in the lines around it).
export function table(rows, head) {
  const all = head ? [head, ...rows] : rows;
  const w = all[0].map((_, i) => Math.max(...all.map(r => String(r[i] ?? '').length)));
  const fmt = r => r.map((c, i) => (i ? String(c ?? '').padStart(w[i]) : String(c ?? '').padEnd(w[i]))).join('  ').trimEnd();
  return '```\n' + [...(head ? [fmt(head), w.map(n => '─'.repeat(n)).join('  ')] : []), ...rows.map(fmt)].join('\n') + '\n```';
}

export function formatTriage(r) {
  const n = r.tickets.length, m = r.notes.length;
  const head = n || m ? `*Filed ${[n && `${n} ticket${n > 1 ? 's' : ''}`, m && `${m} note${m > 1 ? 's' : ''}`].filter(Boolean).join(' and ')}*` : '*Nothing filed*';
  const lines = [head];
  if (r.summary) lines.push(esc(r.summary));
  if (r.files?.length) lines.push(`_${r.files.map(f => f.path ? `Read ${esc(f.name)}` : `Couldn't fetch ${esc(f.name)}: ${esc(f.error)}`).join('; ')}._`);
  if (n) lines.push('', ...grouped(r.tickets, t => ticketLine(t, t.action && t.action !== 'created' ? `_${esc(t.action)}_` : '')));
  if (m) lines.push('', '*Notes*', ...r.notes.map(x => `• ${esc(x.title)}${x.kind ? `  _${esc(x.kind)}_` : ''}`));
  if (r.links?.length) lines.push('', ...r.links.map(l => `• <${l.url}|${esc(l.title || l.url)}>`));
  if (n) lines.push('', '_I\'ll reply in this thread as they move._');
  return lines.join('\n');
}
export function formatUpdates(changes, { allDone } = {}) {
  return [allDone ? '*All done* :tada:' : '*Update*', ...grouped(changes, c => ticketLine({ ...c, state: c.to }))].join('\n');
}
