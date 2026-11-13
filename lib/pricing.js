// Nominal list prices per million tokens, used to put a dollar figure on transcript usage.
// Subscription use is not billed per token, so these are estimates. Override in
// ~/.config/chito/config.json: { "prices": { "claude-opus-5-5": { "input": 4, "output": 20, "cacheRead": 0.2, "cacheWrite": 5 } } }.
// cacheWrite defaults to 1.25x input (5-minute cache writes).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULTS = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

let custom = {};
try { custom = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'chito', 'config.json'), 'utf8')).prices || {}; } catch { }

export function priceFor(model) {
  if (!model) return null;
  const table = { ...DEFAULTS, ...custom };
  // Longest matching prefix, so dated or suffixed ids still resolve.
  const key = Object.keys(table).filter(k => model.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  if (!key) return null;
  const p = table[key];
  return { input: p.input, output: p.output, cacheRead: p.cacheRead ?? p.input * 0.1, cacheWrite: p.cacheWrite ?? p.input * 1.25 };
}

// usage: { model: { input, output, cacheRead, cacheWrite, msgs } } → totals with nominal cost
export function costOf(usage) {
  const out = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, msgs: 0, cost: 0, unpriced: false, models: [] };
  for (const [model, u] of Object.entries(usage || {})) {
    out.input += u.input; out.output += u.output; out.cacheRead += u.cacheRead; out.cacheWrite += u.cacheWrite; out.msgs += u.msgs;
    out.models.push(model);
    const p = priceFor(model);
    if (!p) { out.unpriced = true; continue; }
    out.cost += (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1e6;
  }
  return out;
}

export function mergeUsage(...parts) {
  const acc = {};
  for (const u of parts) for (const [m, x] of Object.entries(u || {})) {
    const a = acc[m] || (acc[m] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, msgs: 0 });
    a.input += x.input; a.output += x.output; a.cacheRead += x.cacheRead; a.cacheWrite += x.cacheWrite; a.msgs += x.msgs;
  }
  return acc;
}
