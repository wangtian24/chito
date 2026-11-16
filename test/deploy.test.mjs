// The deploy schedule is read from the workflow's cron, in its timezone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSchedule, nextScheduled } from '../lib/deploy.js';

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
