// The deploy schedule is read from the workflow's cron, in its timezone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSchedule, nextScheduled, backupDecision, prevScheduled } from '../lib/deploy.js';

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
const after = m => new Date(Date.parse(slot) + m * 60000).getTime();
test('backup: starts a deploy only when the slot was skipped and main has something new', () => {
  assert.equal(backupDecision({ slot, now: after(31), runs: [], mainSha: 'b', prodSha: 'a' }).act, true);
  assert.equal(backupDecision({ slot, now: after(31), runs: [], mainSha: 'a', prodSha: 'a' }).act, false);   // nothing new
  assert.equal(backupDecision({ slot, now: after(20), runs: [], mainSha: 'b', prodSha: 'a' }).act, false);   // too early
  assert.equal(backupDecision({ slot, now: after(31), runs: [{ status: 'completed', createdAt: '2026-11-16T05:12:00Z' }], mainSha: 'b', prodSha: 'a' }).act, false);   // ran late
  assert.equal(backupDecision({ slot, now: after(31), runs: [{ status: 'in_progress', createdAt: '2026-11-16T04:50:00Z' }], mainSha: 'b', prodSha: 'a' }).act, false);   // running
});
test('the last scheduled slot', () => {
  assert.equal(prevScheduled(parseSchedule(yml('0 * * * *')), new Date('2026-11-16T05:40:00Z')), slot);
});
