// Pausing the deploy schedule persists in a small state file and survives a re-read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chito-pause-'));
process.env.CHITO_DEPLOY_PAUSE_FILE = path.join(dir, 'state', 'deploy-schedule.json');
const { schedulePause, setSchedulePaused } = await import('../lib/deploy.js');

test('schedule pause: off by default, on after pausing, off after resuming', () => {
  assert.deepEqual(schedulePause(), { paused: false });
  const p = setSchedulePaused(true);
  assert.equal(p.paused, true);
  assert.ok(!Number.isNaN(Date.parse(p.pausedAt)));
  assert.equal(schedulePause().paused, true);
  assert.deepEqual(setSchedulePaused(false), { paused: false });
  assert.deepEqual(schedulePause(), { paused: false });
});

test('schedule pause: a corrupt state file reads as not paused', () => {
  fs.writeFileSync(process.env.CHITO_DEPLOY_PAUSE_FILE, '{nope');
  assert.deepEqual(schedulePause(), { paused: false });
});
