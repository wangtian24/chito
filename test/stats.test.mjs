// Stats tab: the server rebuilds ticket timelines from the event log; the page's model aggregates them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { timelines, bounceReason, actorKind, sessionKind } from '../lib/stats.js';
import { compute, colorSlots, sessionProject } from '../public/stats-model.js';

const ev = (ticket, kind, at, body = '', actor = 'daemon:1:1', data = '{}') => ({ ticket, kind, at, body, actor, data });

test('bounce reasons fall into buckets', () => {
  assert.equal(bounceReason('PR #599 ready at 1974b6b3, still waiting for green'), 'waiting for green main');
  assert.equal(bounceReason('usage limit; retry after 2026-11-15T10:24:23Z'), 'quota');
  assert.equal(bounceReason('worker exited (143) without reporting'), 'worker exited');
  assert.equal(bounceReason('orchestrator exited (1)'), 'orchestrator exited');
  assert.equal(bounceReason(undefined), 'other');
  assert.equal(actorKind('orchs:abc'), 'orchestrator');
  assert.equal(actorKind('cc:1234'), 'session');
});

test('timelines rebuild work and review intervals, bounces and failures', () => {
  const tickets = [{ key: 'P-1', project: 'P', state: 'done', created: '2026-11-10T00:00:00Z', finished: '2026-11-10T05:00:00Z' }];
  const events = [
    ev('P-1', 'claim', '2026-11-10T01:00:00Z'),
    ev('P-1', 'spawn', '2026-11-10T01:00:01Z', '', 'daemon', '{"model":"opus"}'),
    ev('P-1', 'state', '2026-11-10T01:30:00Z', 'in_progress → todo: worker exited (1) without reporting'),
    ev('P-1', 'claim', '2026-11-10T02:00:00Z', '', 'orch:x'),
    ev('P-1', 'state', '2026-11-10T03:00:00Z', 'in_progress → in_review: PR up'),
    ev('P-1', 'state', '2026-11-10T04:00:00Z', 'in_review → done: merged'),
  ];
  const [tl] = timelines(events, tickets).values();
  assert.equal(tl.firstClaim, '2026-11-10T01:00:00Z');
  assert.deepEqual(tl.work, [['2026-11-10T01:00:00Z', '2026-11-10T01:30:00Z', 'daemon', 'opus'], ['2026-11-10T02:00:00Z', '2026-11-10T03:00:00Z', 'orchestrator', null]]);
  assert.deepEqual(tl.review, [['2026-11-10T03:00:00Z', '2026-11-10T04:00:00Z']]);
  assert.deepEqual(tl.bounces, [['2026-11-10T01:30:00Z', 'worker exited']]);
});

test('session kinds come from the first prompt and entrypoint', () => {
  assert.equal(sessionKind({ firstPrompt: '# Backlog ticket P-1: do it' }), 'worker');
  assert.equal(sessionKind({ firstPrompt: '# Backlog orchestrator for P: run' }), 'orchestrator');
  assert.equal(sessionKind({ firstPrompt: 'hi', entrypoint: 'cli' }), 'interactive');
  assert.equal(sessionProject({ ticket: 'P-1' }, new Map([['P-1', { project: 'P' }]])), 'P');
});

test('compute: done, spend per ticket, clean runs, bounces and the window', () => {
  const now = Date.parse('2026-11-11T00:00:00Z');
  const tl = (key, finished, bounces = [], fails = 0) => ({ key, project: key.split('-')[0], state: 'done', created: '2026-11-10T00:00:00Z', finished,
    firstClaim: '2026-11-10T10:00:00Z', work: [['2026-11-10T10:00:00Z', finished, 'daemon', 'opus']], review: [], bounces, fails });
  const stats = {
    timeline: [tl('A-1', '2026-11-10T11:00:00Z'), tl('A-2', '2026-11-10T12:00:00Z', [['2026-11-10T11:00:00Z', 'quota']]), tl('B-1', '2026-11-01T12:00:00Z')],
    sessions: [{ id: 's1', kind: 'worker', ticket: 'A-1', start: '2026-11-10T10:00:00Z', cost: 3, ms: 0, input: 0, output: 0, cacheRead: 0 },
      { id: 's2', kind: 'interactive', start: '2026-11-10T09:00:00Z', cost: 5, ms: 0, input: 0, output: 0, cacheRead: 0 }],
    quota: [],
  };
  const tickets = [{ key: 'A-1', project: 'A', usage: { cost: 3 } }, { key: 'A-2', project: 'A' }, { key: 'B-1', project: 'B' }];
  const m = compute(stats, tickets, { range: '24h', now, cap: 4 });
  assert.equal(m.cur.n, 2);                 // B-1 finished outside the window
  assert.equal(m.cur.spend, 8);
  assert.equal(m.cur.perDone, 1.5);         // factory spend (3) / 2 done
  assert.equal(m.cur.clean, 0.5);           // A-2 hit a usage limit
  assert.equal(m.reasons.quota, 1);
  assert.equal(m.cur.cycle, 1.5 * 3600e3);
  const a = compute(stats, tickets, { range: '24h', now, project: 'A', cap: 4 });
  assert.equal(a.cur.spend, 3);             // interactive sessions belong to no project
  const color = colorSlots(tickets);
  assert.equal(color('A'), 'var(--st-c1)');
});
