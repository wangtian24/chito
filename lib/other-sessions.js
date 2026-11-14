// Local Pi and Codex transcript adapters for Chito's common session view.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const ROOTS = [
  ['codex', process.env.CHITO_CODEX_SESSIONS_DIR || path.join(HOME, '.codex', 'sessions')],
  ['pi', process.env.CHITO_PI_SESSIONS_DIR || path.join(HOME, '.pi', 'agent', 'sessions')],
];
const cache = new Map();
const LIMIT = 12000;
const clip = value => { const s = typeof value === 'string' ? value : JSON.stringify(value ?? ''); return s.length > LIMIT ? s.slice(0, LIMIT) + '\n…' : s; };
const blocksText = blocks => (Array.isArray(blocks) ? blocks : []).filter(b => ['text', 'input_text', 'output_text'].includes(b.type)).map(b => b.text || '').join('\n').trim();
const emptyTokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function files(dir, depth = 0) {
  if (depth > 6) return [];
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap(e => e.isDirectory() ? files(path.join(dir, e.name), depth + 1) : e.isFile() && e.name.endsWith('.jsonl') ? [path.join(dir, e.name)] : []);
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').flatMap(line => { try { return line ? [JSON.parse(line)] : []; } catch { return []; } });
}

function base(source, file, stat, id, cwd, startTime) {
  return { source, id, file, size: stat.size, cwd, projectDir: cwd ? path.basename(cwd) : source,
    project: cwd === HOME ? '~' : cwd ? path.basename(cwd) : source, gitBranch: null,
    startTime: startTime || new Date(stat.mtimeMs).toISOString(), lastTime: startTime || new Date(stat.mtimeMs).toISOString(),
    title: 'Untitled session', customTitle: null, aiTitle: null, summary: null, firstPrompt: null, lastPrompt: null, lastAnswer: null,
    userTurns: 0, assistantMsgs: 0, toolCalls: 0, compactions: 0, models: [], tokens: emptyTokens(), usage: {}, subUsage: {},
    prLinks: [], tools: {}, subagents: 0, version: null, entrypoint: null, agent: false };
}

function recordPrompt(meta, text) {
  if (!text || /^\s*<environment_context>/.test(text) || /^\s*>Warning:/.test(text)) return;
  meta.userTurns++;
  meta.firstPrompt ||= text.slice(0, 400);
  meta.lastPrompt = text.slice(0, 400);
}
function recordTool(meta, name) {
  meta.toolCalls++;
  meta.tools[name] = (meta.tools[name] || 0) + 1;
}
function recordUsage(meta, model, input, output, cacheRead = 0, cacheWrite = 0) {
  if (!model) return;
  const u = meta.usage[model] || (meta.usage[model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, msgs: 0 });
  u.input += input; u.output += output; u.cacheRead += cacheRead; u.cacheWrite += cacheWrite; u.msgs++;
}
function finish(meta, items, stat) {
  meta.lastTime = items.at(-1)?.endTs || items.at(-1)?.ts || new Date(stat.mtimeMs).toISOString();
  meta.title = meta.customTitle || meta.firstPrompt?.match(/^# Backlog ticket .+$/m)?.[0].slice(0, 90)
    || meta.firstPrompt?.split('\n')[0].slice(0, 90) || 'Untitled session';
  meta.lastAnswer = [...items].reverse().find(it => it.kind === 'assistant')?.blocks.filter(b => b.type === 'text').map(b => b.text).join('\n\n').slice(0, 1200) || null;
  meta.agent = !!meta.agent || (!!meta.cwd && !meta.cwd.startsWith(HOME));
  return { meta, items };
}

function parsePi(file, stat, rows) {
  const header = rows.find(d => d.type === 'session');
  if (!header?.id) return null;
  const meta = base('pi', file, stat, header.id, header.cwd, header.timestamp);
  meta.version = header.version;
  const items = [], models = new Set(), calls = new Map();
  let current = null;
  for (const d of rows) {
    if (d.type === 'session_info' && d.name) meta.customTitle = d.name;
    if (d.type !== 'message') continue;
    const m = d.message || {}, ts = d.timestamp || m.timestamp;
    if (m.role === 'user') {
      const value = typeof m.content === 'string' ? m.content : blocksText(m.content);
      if (!value || /^\s*>Warning:/.test(value)) continue;
      items.push({ kind: 'user', text: value, ts, uuid: d.id }); recordPrompt(meta, value); current = null;
    } else if (m.role === 'assistant') {
      meta.assistantMsgs++;
      if (m.model) models.add(m.model);
      const usage = m.usage || {};
      meta.tokens.input += usage.input || 0; meta.tokens.output += usage.output || 0;
      meta.tokens.cacheRead += usage.cacheRead || 0; meta.tokens.cacheWrite += usage.cacheWrite || 0;
      recordUsage(meta, m.model, usage.input || 0, usage.output || 0, usage.cacheRead || 0, usage.cacheWrite || 0);
      if (!current) { current = { kind: 'assistant', source: 'pi', blocks: [], ts, endTs: ts, uuid: d.id, model: m.model }; items.push(current); }
      current.endTs = ts; current.model = m.model || current.model;
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type === 'text' && b.text) current.blocks.push({ type: 'text', text: b.text });
        else if (b.type === 'thinking' && b.thinking) current.blocks.push({ type: 'thinking', text: clip(b.thinking) });
        else if (b.type === 'toolCall') {
          const tool = { type: 'tool', id: b.id, name: b.name || 'tool', input: b.arguments || {}, ts };
          current.blocks.push(tool); calls.set(b.id, tool); recordTool(meta, tool.name);
        }
      }
    } else if (m.role === 'toolResult') {
      const tool = calls.get(m.toolCallId);
      if (tool) { tool.result = clip(blocksText(m.content)); tool.isError = !!m.isError; }
    }
  }
  meta.models = [...models];
  return finish(meta, items.filter(it => it.kind !== 'assistant' || it.blocks.length), stat);
}

function parseCodex(file, stat, rows) {
  const header = rows.find(d => d.type === 'session_meta')?.payload;
  if (!header?.id) return null;
  const meta = base('codex', file, stat, header.id, header.cwd, rows[0]?.timestamp);
  meta.version = header.cli_version;
  meta.gitBranch = header.git?.branch || null;
  meta.agent = header.source?.subagent || false;
  const items = [], models = new Set(), calls = new Map();
  let current = null;
  let rowNumber = 0;
  for (const d of rows) {
    rowNumber++;
    const p = d.payload || {}, ts = d.timestamp;
    const uuid = p.id || `codex-${rowNumber}`;
    if (d.type === 'turn_context' && p.model) models.add(p.model);
    if (d.type === 'token_usage_record') {
      const u = p.usage || {};
      meta.tokens.input += u.input_tokens || 0; meta.tokens.output += u.output_tokens || 0;
      meta.tokens.cacheRead += u.cached_input_tokens || 0; meta.tokens.cacheWrite += u.cache_write_input_tokens || 0;
      recordUsage(meta, [...models].at(-1), u.input_tokens || 0, u.output_tokens || 0,
        u.cached_input_tokens || 0, u.cache_write_input_tokens || 0);
    }
    if (d.type !== 'response_item') continue;
    if (p.type === 'message' && p.role === 'user') {
      const value = blocksText(p.content);
      if (!value || /^\s*<environment_context>/.test(value)) continue;
      items.push({ kind: 'user', text: value, ts, uuid }); recordPrompt(meta, value); current = null;
    } else if (p.type === 'message' && p.role === 'assistant') {
      const value = blocksText(p.content);
      if (!value) continue;
      if (!current) { current = { kind: 'assistant', source: 'codex', blocks: [], ts, endTs: ts, uuid, model: null }; items.push(current); }
      current.blocks.push({ type: 'text', text: value }); current.endTs = ts; current.model = [...models].at(-1) || null;
      meta.assistantMsgs++;
    } else if (['function_call', 'custom_tool_call'].includes(p.type)) {
      if (!current) { current = { kind: 'assistant', source: 'codex', blocks: [], ts, endTs: ts, uuid, model: [...models].at(-1) || null }; items.push(current); }
      let input = p.arguments || p.input || {};
      if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { command: clip(input) }; } }
      const tool = { type: 'tool', id: p.call_id || p.id, name: p.name || 'tool', input, ts };
      current.blocks.push(tool); calls.set(tool.id, tool); recordTool(meta, tool.name);
    } else if (['function_call_output', 'custom_tool_call_output'].includes(p.type)) {
      const tool = calls.get(p.call_id);
      if (tool) tool.result = clip(p.output);
    }
  }
  meta.models = [...models];
  return finish(meta, items.filter(it => it.kind !== 'assistant' || it.blocks.length), stat);
}

export function scanOtherSessions() {
  const live = new Set(), list = [];
  for (const [source, root] of ROOTS) for (const file of files(root)) {
    live.add(file);
    let stat; try { stat = fs.statSync(file); } catch { continue; }
    let entry = cache.get(file);
    if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
      try {
        const rows = readLines(file);
        const parsed = source === 'pi' ? parsePi(file, stat, rows) : parseCodex(file, stat, rows);
        entry = parsed && { mtimeMs: stat.mtimeMs, size: stat.size, ...parsed };
        if (entry) cache.set(file, entry);
      } catch { continue; }
    }
    if (entry?.meta.userTurns || entry?.meta.assistantMsgs) list.push(entry);
  }
  for (const file of cache.keys()) if (!live.has(file)) cache.delete(file);
  return list;
}
