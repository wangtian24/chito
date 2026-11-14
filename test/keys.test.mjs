import test from 'node:test';
import assert from 'node:assert/strict';
import { makeChords } from '../public/keys.js';

const setup = () => {
  let t = 0;
  const go = () => 'projects';
  const chord = makeChords({ 'g p': go }, { timeout: 1000, now: () => t });
  return { chord, go, tick: ms => { t += ms; } };
};

test('g then p runs the sequence', () => {
  const { chord, go, tick } = setup();
  assert.equal(chord('g'), null);
  tick(200);
  assert.equal(chord('p'), go);
});

test('p alone, or p after a slow g, does not', () => {
  const { chord, tick } = setup();
  assert.equal(chord('p'), null);
  chord('g'); tick(1500);
  assert.equal(chord('p'), null);
});

test('another key in between breaks the sequence; Shift does not', () => {
  const { chord, go } = setup();
  chord('g'); chord('j');
  assert.equal(chord('p'), null);
  chord('g'); chord('Shift');
  assert.equal(chord('p'), go);
});

test('a finished sequence does not chain into the next key', () => {
  const { chord } = setup();
  chord('g'); chord('p');
  assert.equal(chord('p'), null);
});
