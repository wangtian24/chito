// The deploy schedule: chito's own cron (CHITO_DEPLOY_CRON), and when a slot starts a deploy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSchedule, nextScheduled, scheduleDecision, prevScheduled, SCHEDULE } from '../lib/deploy.js';

const yml = c => `on:\n  schedule:\n    - cron: '${c}'\n      timezone: America/Los_Angeles\n`;
const at = '2026-11-16T01:04:00Z';   // 5:04 PM Pacific

test('every hour: the next top of the hour', () => {
  assert.equal(nextScheduled(parseSchedule(yml('0 * * * *')), new Date(at)), '2026-11-16T02:00:00.000Z');
});
test('listed Pacific hours: the next one, across midnight', () => {
  assert.equal(nextScheduled(parseSchedule(yml('0 1,2,10 * * *')), new Date(at)), '2026-11-16T09:00:00.000Z');
});
test('no schedule: no next run', () => {
  assert.equal(nextScheduled(parseSchedule('on: workflow_dispatch'), new Date(at)), null);
});

const slot = '2026-11-16T05:00:00.000Z';
test('schedule: deploys at the slot only when main has something new and nothing ran since', () => {
  const d = o => scheduleDecision({ slot, runs: [], mainSha: 'b', prodSha: 'a', ...o }).act;
  assert.equal(d({}), true);
  assert.equal(d({ mainSha: 'a' }), false);   // nothing new
  assert.equal(d({ runs: [{ status: 'completed', conclusion: 'success', createdAt: '2026-11-16T05:12:00Z' }] }), false);   // ran since
  assert.equal(d({ runs: [{ status: 'in_progress', createdAt: '2026-11-16T04:50:00Z' }] }), false);   // running
  assert.equal(d({ runs: [{ status: 'completed', conclusion: 'failure', headSha: 'b', createdAt: '2026-11-16T04:10:00Z' }] }), false);   // failed on this commit
  assert.equal(d({ runs: [{ status: 'completed', conclusion: 'failure', headSha: 'x', createdAt: '2026-11-16T04:10:00Z' }] }), true);   // main moved since
});
test('the default schedule is every hour, Pacific', () => {
  assert.deepEqual(SCHEDULE, { crons: ['0 * * * *'], tz: 'America/Los_Angeles' });
  assert.equal(prevScheduled(SCHEDULE, new Date('2026-11-16T05:40:00Z')), slot);
});
