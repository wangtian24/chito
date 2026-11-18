// Slack work orders: posts become triaged orders, thread replies are follow-ups, only the moves that matter are
// reported, ?commands answer directly, ?ask relays to a session and back.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chito-wo-'));
process.env.CHITO_WO_SETTINGS = path.join(dir, 'settings.json');
process.env.CHITO_WO_STATE = path.join(dir, 'state.json');
process.env.CHITO_WO_FILES = path.join(dir, 'files');
const wo = await import('../lib/work-orders.js');
const { runCommand, isCommand } = await import('../lib/work-orders-commands.js');

const ME = 'U111AAAA';
function fakeSlack() {
  const s = {
    top: [], threads: {}, posts: [], reactions: [],
    me: async () => 'UBOT',
    resolve: async () => 'C1',
    history: async (_c, oldest) => s.top.filter(m => Number(m.ts) > Number(oldest)).reverse(),
    replies: async (_c, ts) => [s.top.find(m => m.ts === ts), ...(s.threads[ts] || [])],
    post: async (_c, thread, text, broadcast) => { s.posts.push({ thread, text, broadcast: !!broadcast }); return String(Date.now()); },
    react: async (_c, ts, name) => { s.reactions.push(`+${name}@${ts}`); },
    unreact: async (_c, ts, name) => { s.reactions.push(`-${name}@${ts}`); },
  };
  return s;
}
const later = n => (Number(wo.loadState().cursor || Date.now() / 1000) + n).toFixed(6);

test('settings are checked, and turning on needs an allowed user', () => {
  assert.throws(() => wo.saveSettings({ everyMin: 7 }), /every/);
  assert.throws(() => wo.saveSettings({ channel: 'Bad Name!' }), /channel/);
  assert.throws(() => wo.saveSettings({ enabled: true, channel: 'work-orders' }), /Only from/);
  const s = wo.saveSettings({ enabled: true, channel: '#work-orders', everyMin: 10, project: 'mc-general', users: `${ME}, junk` });
  assert.equal(s.channel, 'work-orders'); assert.equal(s.project, 'MC-GENERAL'); assert.equal(s.users, ME); assert.ok(s.resetAt);
});

test('a full order: triage, reply, follow-up, and only the moves that matter', async () => {
  const slack = fakeSlack();
  let ticket = { state: 'todo', title: 'Fix the legend', project: 'MC-GENERAL' };
  const triaged = [];
  const deps = {
    slack,
    states: async keys => Object.fromEntries(keys.filter(k => k === 'MC-GENERAL-9').map(k => [k, ticket])),
    triage: async a => { triaged.push(a); return a.thread
      ? { tickets: [{ key: 'MC-GENERAL-9', action: 'commented' }], notes: [], links: [], summary: 'Added the detail.' }
      : { tickets: [{ key: 'MC-GENERAL-9', title: 'Fix the legend' }, { key: 'MC-GENERAL-404', title: 'invented' }], notes: [{ title: 'Legends matter', kind: 'note' }], links: [], summary: 'Filed it.' }; },
  };
  // Messages from before it was turned on are history, not orders.
  slack.top.push({ ts: '1000.000001', user: ME, text: 'old' });
  assert.equal((await wo.tick(deps)).orders, 0);

  const ts = later(5);
  slack.top.push({ ts, user: ME, text: 'fix the legend' },
    { ts: later(6), user: 'UOTHER99', text: 'not allowed' },
    { ts: later(7), bot_id: 'B1', user: 'UBOT', text: 'a bot' });
  let r = await wo.tick(deps);
  assert.equal(r.orders, 1);
  assert.deepEqual(slack.reactions, [`+eyes@${ts}`, `-eyes@${ts}`, `+white_check_mark@${ts}`]);
  assert.equal(slack.posts.length, 1);
  const p0 = slack.posts[0];
  assert.equal(p0.thread, ts);
  assert.match(p0.text, /^\*Filed 1 ticket and 1 note\*/);   // the invented key is dropped
  assert.match(p0.text, /<http:\/\/localhost:8791\/projects\/MC-GENERAL\/MC-GENERAL-9\|MC-GENERAL-9>  Fix the legend  _queued_/);
  assert.doesNotMatch(p0.text, /404/);
  assert.deepEqual(wo.loadState().orders[ts].tickets, ['MC-GENERAL-9']);

  // A reply in the thread is a follow-up with the thread as context.
  slack.threads[ts] = [{ ts: later(10), user: ME, text: 'also the scale bar', thread_ts: ts }];
  r = await wo.tick(deps);
  assert.equal(r.followups, 1); assert.equal(r.updates, 0);
  assert.match(triaged[1].thread, /fix the legend/);
  assert.deepEqual(triaged[1].tickets, ['MC-GENERAL-9']);

  // Started and PR-open are not worth a message; done is, as "All done" sent to the channel, with the PR linked.
  ticket = { ...ticket, state: 'in_progress' };
  assert.equal((await wo.tick(deps)).updates, 0);
  ticket = { ...ticket, state: 'staged' };
  assert.equal((await wo.tick(deps)).updates, 0);
  assert.equal(slack.posts.length, 2);
  ticket = { ...ticket, state: 'done', result: 'merged https://github.com/o/r/pull/12' };
  r = await wo.tick(deps);
  assert.equal(r.updates, 1);
  const last = slack.posts.at(-1);
  assert.match(last.text, /^\*All done\*/); assert.match(last.text, /<https:\/\/github\.com\/o\/r\/pull\/12\|PR #12>/); assert.equal(last.broadcast, true);
  assert.equal((await wo.tick(deps)).updates, 0);
});

test('a failed triage reacts x and says why; a failed reply does not', async () => {
  const slack = fakeSlack();
  const ts = later(100);
  slack.top.push({ ts, user: ME, text: 'do a thing' });
  await wo.tick({ slack, states: async () => ({}), triage: async () => { throw new Error('claude is down'); } });
  assert.ok(slack.reactions.includes(`+x@${ts}`));
  assert.match(slack.posts[0].text, /Couldn't file this.*claude is down/);

  const s2 = fakeSlack(); s2.post = async () => { throw new Error('ratelimited'); };
  const ts2 = later(200);
  s2.top.push({ ts: ts2, user: ME, text: 'another' });
  await wo.tick({ slack: s2, states: async k => Object.fromEntries(k.map(x => [x, { state: 'todo', project: 'P' }])), triage: async () => ({ tickets: [{ key: 'P-1' }], notes: [], links: [], summary: '' }) });
  const o = wo.loadState().orders[ts2];
  assert.equal(o.error, null); assert.deepEqual(o.tickets, ['P-1']);
});

test('an order interrupted mid-triage is not triaged again', async () => {
  const st = JSON.parse(fs.readFileSync(process.env.CHITO_WO_STATE, 'utf8'));
  const ts = Object.keys(st.orders)[0];
  st.orders[ts].pending = true; fs.writeFileSync(process.env.CHITO_WO_STATE, JSON.stringify(st));
  const slack = fakeSlack(); let called = 0;
  await wo.tick({ slack, states: async () => ({}), triage: async () => { called++; return { tickets: [], notes: [], links: [], summary: '' }; } });
  assert.equal(called, 0);
  assert.match(slack.posts[0].text, /Interrupted/);
  assert.equal(wo.loadState().orders[ts].pending, false);
});

test('?commands answer in thread without triage; ?ask relays and brings the answer back', async () => {
  const slack = fakeSlack(); let triaged = 0, sent = null;
  const sid = '142fd036-ba8c-4e5b-82ab-5285f04a1769';
  const deps = {
    slack, states: async () => ({}), triage: async () => { triaged++; },
    sessions: () => [{ id: sid, title: 'Work orders setup', project: 'docs' }],
    ask: async (id, text) => { sent = { id, text }; return 77; },
    answers: async () => (sent ? [{ dir: 'out', reply_to: 77, body: 'All good <here>' }] : []),
    commands: { bl: async () => ({ daemon: { alive: true, in_flight: 3, runs_today: 9 }, projects: [] }) },
  };
  const a = later(300), b = later(301);
  slack.top.push({ ts: a, user: ME, text: '?status' }, { ts: b, user: ME, text: '?ask 142fd036 how is it going?' });
  const r = await wo.tick(deps);
  assert.equal(triaged, 0); assert.equal(r.commands, 2);
  assert.match(slack.posts[0].text, /^\*Status\*  daemon running/); assert.match(slack.posts[0].text, /```/);
  assert.equal(slack.posts[0].thread, a);
  assert.equal(sent.id, sid); assert.match(sent.text, /how is it going\?/);
  assert.match(slack.posts[1].text, /Sent to <http:\/\/localhost:8791\/s\/142fd036/);
  // The answer was already there, so it came back in the same pass.
  assert.match(slack.posts[2].text, /Work orders setup\> replied\*\nAll good &lt;here&gt;/);
  assert.equal(r.answers, 1); assert.equal(wo.loadState().asks.length, 0);
});

test('a screenshot on an order is downloaded, given to the triage by path, and noted in the reply', async () => {
  const slack = fakeSlack(), got = [];
  slack.download = async (f, d) => { got.push({ f, d }); if (f.id === 'FBAD') throw new Error('download 403'); const p = path.join(d, `${f.id}-${f.name}`); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(p, 'png'); return p; };
  let args = null;
  const ts = later(400);
  // An image with no text at all is still an order.
  slack.top.push({ ts, user: ME, text: '', files: [
    { id: 'F1', name: 'shot.png', mimetype: 'image/png', mode: 'hosted', url_private_download: 'https://files.slack.com/x' },
    { id: 'FBAD', name: 'log.txt', mimetype: 'text/plain', mode: 'hosted', url_private_download: 'https://files.slack.com/y' },
    { id: 'F3', name: 'gone.png', mode: 'tombstone' }] });
  const r = await wo.tick({ slack, states: async k => Object.fromEntries(k.map(x => [x, { state: 'todo', project: 'P' }])),
    triage: async a => { args = a; return { tickets: [{ key: 'P-2', title: 'Crash' }], notes: [], links: [], summary: 'Filed.' }; } });
  assert.equal(r.orders, 1);
  assert.equal(got.length, 2); assert.equal(got[0].d, path.join(dir, 'files', ts));
  assert.equal(args.files[0].path, path.join(dir, 'files', ts, 'F1-shot.png'));
  assert.match(args.files[1].error, /403/); assert.match(args.files[2].error, /deleted/);
  const prompt = wo.triagePrompt(args);
  assert.match(prompt, new RegExp(`- ${args.files[0].path.replace(/[.\\]/g, '\\$&')}  \\(shot\\.png, image/png\\)`));
  assert.match(prompt, /Read every attached image/); assert.match(prompt, /Attachments:/); assert.match(prompt, /only attachments/);
  assert.match(slack.posts.at(-1).text, /_Read shot\.png; Couldn't fetch log\.txt: download 403; Couldn't fetch gone\.png: deleted\._/);
  assert.deepEqual(wo.loadState().orders[ts].files, [args.files[0].path]);
});

test('slack download: bot token on the private url, saved under a safe name; a sign-in page is an error', async () => {
  const real = globalThis.fetch, calls = [];
  const d = path.join(dir, 'dl');
  try {
    globalThis.fetch = async (url, o) => { calls.push({ url, auth: o.headers.authorization });
      return url.endsWith('login') ? new Response('<html>sign in</html>', { headers: { 'content-type': 'text/html' } })
        : new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }); };
    const c = wo.slackClient('xoxb-T');
    const p = await c.download({ id: 'F9', name: '../Screen Shot 1.png', mimetype: 'image/png', url_private_download: 'https://files.slack.com/F9' }, d);
    assert.equal(p, path.join(d, 'F9-Screen_Shot_1.png'));
    assert.deepEqual([...fs.readFileSync(p)], [137, 80, 78, 71]);
    assert.deepEqual(calls[0], { url: 'https://files.slack.com/F9', auth: 'Bearer xoxb-T' });
    await assert.rejects(c.download({ id: 'F8', name: 'a.png', mimetype: 'image/png', url_private: 'https://slack.com/login' }, d), /files:read/);
    await assert.rejects(c.download({ id: 'F7', name: 'big.png', size: 30e6, url_private: 'https://x' }, d), /too big/);
  } finally { globalThis.fetch = real; }
});

test('command parsing and errors', async () => {
  assert.ok(isCommand('?status')); assert.ok(!isCommand('what? no')); assert.ok(!isCommand('? '));
  const show = { key: 'MC-GENERAL-9', project: 'MC-GENERAL', title: 'T', state: 'failed', priority: 2, result: 'see https://github.com/o/r/pull/5', blockers: [] };
  const txt = await runCommand('?MC-GENERAL-9', { bl: async () => show });
  assert.match(txt, /\*<http:\/\/localhost:8791\/projects\/MC-GENERAL\/MC-GENERAL-9\|MC-GENERAL-9>\*  T/);
  assert.match(txt, /_failed_ · priority 2 · <https:\/\/github\.com\/o\/r\/pull\/5\|PR #5>/);
  await assert.rejects(runCommand('?cancel', {}), /needs a ticket key/);
  await assert.rejects(runCommand('?ask zzz hi', { sessions: () => [] }), /needs a session id/);
  assert.match(await runCommand('?nope', {}), /don't know/);
  assert.match(await runCommand('?help', { channel: 'wo' }), /Quick commands/);
});

test('warm checks: 1 minute after activity, doubling back to the interval', () => {
  const s = { warm: true, everyMin: 10 };
  assert.equal(wo.nextGap(10, { orders: 1 }, s), 1);
  assert.equal(wo.nextGap(1, {}, s), 2);
  assert.equal(wo.nextGap(8, {}, s), 10);
  assert.equal(wo.nextGap(8, { waiting: 1 }, s), 2);
  assert.equal(wo.nextGap(1, { orders: 1 }, { warm: false, everyMin: 10 }), 10);
});

test('triage output: the last json block of the result', () => {
  const out = JSON.stringify({ result: 'did it\n```json\n{"tickets":[{"key":"A-1","title":"t"}],"notes":[],"summary":"s"}\n```' });
  assert.deepEqual(wo.parseTriage(out), { tickets: [{ key: 'A-1', title: 't' }], notes: [], links: [], summary: 's' });
  assert.throws(() => wo.parseTriage(JSON.stringify({ result: 'no block' })), /no json/);
  assert.throws(() => wo.parseTriage(JSON.stringify({ is_error: true, result: 'quota' })), /quota/);
});
