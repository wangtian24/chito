// `?` commands in the work-orders channel: quick answers straight from the backlog, no triage.
// A message whose first word is ?command gets its answer in its thread (or the order thread it was posted in).
import { execFile } from 'node:child_process';
import { esc, projectOf, ticketLink, projectLink, sessionLink, grouped, ticketLine, table, stateWord, prOf, prLink, artiLink } from './work-orders-slack.js';

const BL = process.env.CHITO_BL || 'bl';
const KEY_RE = /^[A-Z][A-Z0-9_-]*-\d+$/;
const PROJ_RE = /^[A-Z][A-Z0-9_-]{0,39}$/;
const GUIDE_SLUG = process.env.CHITO_WO_GUIDE || 'chito-work-orders';

const blRun = args => new Promise((resolve, reject) =>
  execFile(BL, args, { maxBuffer: 32 << 20, timeout: 30000, env: { ...process.env, CLAUDE_CODE_SESSION_ID: '', BL_TICKET: '', BL_AGENT: 'chito-work-orders' } },
    (err, stdout, stderr) => err ? reject(new Error(String(stderr || err.message).trim().replace(/^bl: /, '').slice(0, 300))) : resolve(String(stdout))));
const blJson = async args => JSON.parse(await blRun([...args, '--json']));
const live = p => p.status === 'executing' || p.status === 'planning';
const FINAL = new Set(['done', 'canceled', 'failed']);

export const COMMANDS = [
  ['?help', 'this guide'],
  ['?status', 'the daemon, what is running, what waits on you'],
  ['?projects', 'active projects and their progress'],
  ['?project KEY', 'one project: progress, running, failed, waiting on you'],
  ['?open', 'tickets from work orders here that are not finished'],
  ['?orders', 'the last work orders and where their tickets are'],
  ['?handoff', 'tickets waiting on you (also ?waiting)'],
  ['?running', 'tickets being worked on now'],
  ['?failed', 'tickets that failed'],
  ['?ticket KEY', 'one ticket: state, PR, spec (or just ?KEY)'],
  ['?retry KEY', 'reopen a failed or canceled ticket'],
  ['?cancel KEY', 'cancel a ticket'],
  ['?pause  ?resume', 'pause or resume the backlog daemon'],
  ['?sessions', 'live Claude sessions you can ?ask'],
  ['?ask ID text', 'send text to a live session; its answer comes back here'],
];
export function usageGuide(channel, guideUrl) {
  const w = Math.max(...COMMANDS.map(([c]) => c.length));
  return [
    `*Work orders in ${channel ? `#${esc(channel)}` : 'this channel'}*`,
    'Post a request here and walk away. I react :eyes: while I triage it, file backlog tickets and notes, and answer in its thread with links to chito. That thread only hears what matters after that: a ticket *done* (with its PR), *failed*, *canceled* or *waiting on you*, and *All done* when the whole order is finished.',
    '_Reply in a work order\'s thread to add to it or change it: "also do X", "drop the second one", "make it high priority"._',
    '',
    '*Quick commands* (answered right away, no triage)',
    '```\n' + COMMANDS.map(([c, d]) => `${c.padEnd(w)}  ${d}`).join('\n') + '\n```',
    '_Only messages from Tian are read; everything else here is ignored._' + (guideUrl ? `  Full guide: <${guideUrl}|work orders on arti>` : ''),
  ].join('\n');
}

export const isCommand = text => /^\s*\?[A-Za-z]/.test(text || '');

// deps: { bl(args), blRaw(args), orders(), sessions(), ask(id, title, text), channel, artiBase } so tests can fake them.
export async function runCommand(text, deps = {}) {
  const bl = deps.bl || blJson, raw = deps.blRaw || blRun;
  const words = text.trim().split(/\s+/);
  let cmd = words[0].slice(1).toLowerCase();
  let arg = (words[1] || '').toUpperCase().replace(/[<>*_`]/g, '');
  if (KEY_RE.test(cmd.toUpperCase()) && !arg) { arg = cmd.toUpperCase(); cmd = 'ticket'; }
  const needKey = () => { if (!KEY_RE.test(arg)) throw new Error(`\`?${cmd}\` needs a ticket key, like \`?${cmd} MC-GENERAL-12\``); };
  const waitingOf = s => s.projects.flatMap(p => (p.needs_human || []).map(w => ({ ...w, project: p.project })));

  switch (cmd) {
    case 'help': case 'usage': case 'commands':
      return usageGuide(deps.channel, deps.artiBase ? `${deps.artiBase.replace(/\/$/, '')}/s/${GUIDE_SLUG}` : null);
    case 'status': {
      const s = await bl(['status']);
      const d = s.daemon || {};
      const running = await bl(['ls', '--state', 'in_progress']).catch(() => []);
      const failed = await bl(['ls', '--state', 'failed']).catch(() => []);
      const waiting = waitingOf(s);
      const orders = deps.orders ? deps.orders() : [];
      const daemon = !d.alive ? '*not running*' : d.enabled === false ? '*paused*' : 'running';
      return [
        `*Status*  daemon ${daemon}${d.quota_until ? `, _quota pause until ${esc(d.quota_until)}_` : ''}`,
        table([
          ['In flight', d.in_flight ?? 0], ['Runs today', d.runs_today ?? 0], ['Running', running.length],
          ['Waiting on you', waiting.length], ['Failed', failed.length],
          ['Projects executing', s.projects.filter(p => p.status === 'executing').length],
          ['Open work orders', orders.filter(o => o.tickets.some(k => !FINAL.has(o.states[k]))).length],
        ]),
        ...(waiting.length ? ['*Waiting on you*', ...grouped(waiting, ticketLine, { max: 10 })] : []),
        '_More: `?running`  `?failed`  `?projects`_',
      ].join('\n');
    }
    case 'projects': {
      const s = await bl(['status']);
      const ps = s.projects.filter(live).sort((a, b) => a.status.localeCompare(b.status) || a.project.localeCompare(b.project));
      const rows = ps.map(p => {
        const c = p.counts || {}, total = Object.entries(c).filter(([k]) => k !== 'canceled').reduce((n, [, v]) => n + v, 0);
        return [p.project, p.status, `${c.done || 0}/${total}`, c.in_progress || 0, c.todo || 0, c.failed || 0, p.needs_human?.length || 0];
      });
      return ['*Active projects*', table(rows, ['Project', 'State', 'Done', 'Run', 'Queue', 'Fail', 'You']),
        ps.map(p => projectLink(p.project)).join(' · ')].join('\n');
    }
    case 'project': {
      if (!PROJ_RE.test(arg)) throw new Error('`?project` needs a project key, like `?project MC-GENERAL`');
      const s = await bl(['status']);
      const p = s.projects.find(x => x.project === arg);
      if (!p) throw new Error(`no project ${arg}`);
      const tickets = await bl(['ls', arg]);
      const c = p.counts || {};
      const running = tickets.filter(t => t.state === 'in_progress'), failed = tickets.filter(t => t.state === 'failed');
      return [
        `*${projectLink(arg)}*  _${esc(p.status)}${p.evergreen ? ', evergreen' : ''}_`,
        Object.entries(c).map(([k, v]) => `${v} ${stateWord(k)}`).join(' · '),
        ...(running.length ? ['', '*Running*', ...grouped(running, ticketLine)] : []),
        ...(failed.length ? ['', '*Failed*', ...grouped(failed, ticketLine)] : []),
        ...(p.needs_human?.length ? ['', '*Waiting on you*', ...grouped(p.needs_human.map(w => ({ ...w, project: arg })), ticketLine)] : []),
      ].join('\n');
    }
    case 'handoff': case 'handoffs': case 'waiting': case 'needs':
      return ['*Waiting on you*', ...grouped(waitingOf(await bl(['status'])), ticketLine)].join('\n');
    case 'running': return ['*Running now*', ...grouped(await bl(['ls', '--state', 'in_progress']), ticketLine)].join('\n');
    case 'failed': return ['*Failed*', ...grouped(await bl(['ls', '--state', 'failed']), ticketLine)].join('\n');
    case 'open': {
      const orders = deps.orders ? deps.orders() : [];
      const keys = [...new Set(orders.flatMap(o => o.tickets.filter(k => !FINAL.has(o.states[k]))))];
      const tickets = [];
      for (const k of keys) { try { const t = await bl(['show', k]); if (!FINAL.has(t.state)) tickets.push(t); } catch { /* gone */ } }
      return ['*Open from work orders*', ...grouped(tickets, ticketLine)].join('\n');
    }
    case 'orders': {
      const orders = (deps.orders ? deps.orders() : []).slice().sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 10);
      if (!orders.length) return '*Recent work orders*\n_None yet._';
      return ['*Recent work orders*', ...orders.map(o => {
        const text = esc(o.text.replace(/\s+/g, ' ').slice(0, 70)) + (o.text.length > 70 ? '…' : '');
        const tk = o.tickets.map(k => `${ticketLink(k)} _${stateWord(o.states[k])}_`).join(', ');
        return `• ${text}\n      ${tk || (o.error ? `_${esc(o.error)}_` : '_nothing filed_')}`;
      })].join('\n');
    }
    case 'ticket': case 't': case 'show': {
      needKey();
      const t = await bl(['show', arg]);
      const extra = [prLink(prOf(t.result)), artiLink(t.doc_slug, 'spec')].filter(Boolean);
      return [`*${ticketLink(t.key, t.project)}*  ${esc(t.title)}`,
        `_${stateWord(t.state)}_ · priority ${t.priority ?? '-'}${t.attempts ? ` · ${t.attempts} attempt${t.attempts === 1 ? '' : 's'}` : ''}${extra.length ? ' · ' + extra.join(' · ') : ''}`,
        t.blockers?.length ? `Waits on ${t.blockers.map(b => ticketLink(b.key || b)).join(', ')}` : ''].filter(Boolean).join('\n');
    }
    case 'retry': case 'reopen': needKey(); await raw(['reopen', arg, '--reason', 'from Slack work orders']); return `Reopened ${ticketLink(arg)}.`;
    case 'cancel': needKey(); await raw(['cancel', arg, '--reason', 'from Slack work orders']); return `Canceled ${ticketLink(arg)}.`;
    case 'pause': await raw(['daemon', 'pause']); return 'Paused the backlog daemon. `?resume` starts it again.';
    case 'resume': await raw(['daemon', 'resume']); return 'Resumed the backlog daemon.';
    case 'sessions': {
      const ss = (deps.sessions ? deps.sessions() : []).slice(0, 12);
      if (!ss.length) return '*Live sessions*\n_None running._';
      return ['*Live sessions*  _(`?ask <id> <text>` with the first 8 characters)_',
        ...ss.map(s => `• \`${s.id.slice(0, 8)}\`  ${sessionLink(s.id, s.title)}${s.project ? `  _${esc(s.project)}_` : ''}`)].join('\n');
    }
    case 'ask': case 'tell': {
      const prefix = (words[1] || '').toLowerCase();
      const body = text.trim().replace(/^\S+\s+\S+\s*/, '');
      if (!/^[0-9a-f-]{4,36}$/.test(prefix) || !body) throw new Error('`?ask` needs a session id and a message, like `?ask 142fd036 how is it going?` (see `?sessions`)');
      const ss = (deps.sessions ? deps.sessions() : []).filter(s => s.id.startsWith(prefix));
      if (!ss.length) throw new Error(`no live session starts with \`${prefix}\` (see \`?sessions\`)`);
      if (ss.length > 1) throw new Error(`\`${prefix}\` matches ${ss.length} sessions; give more of the id`);
      const s = ss[0];
      const msg = `Message from Tian via Slack #${deps.channel || 'work orders'} (relayed by chito; answer with bl msg reply, it goes back to Slack):\n\n${body}`;
      await deps.ask(s.id, s.title, msg);
      return `Sent to ${sessionLink(s.id, s.title)}. _It gets it on its next tool call; I'll post the answer here._`;
    }
    default: return `I don't know \`?${esc(cmd)}\`. \`?help\` lists the commands.`;
  }
}
