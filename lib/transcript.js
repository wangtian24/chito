// Turns a session .jsonl into a compact, render-ready list of conversation items.
import fs from 'node:fs';
import { cleanPromptText } from './index.js';

const MAX_TOOL_TEXT = 12000;
const MAX_IMAGE_B64 = 4_000_000;

function clip(s, n = MAX_TOOL_TEXT) {
  if (s == null) return '';
  s = String(s);
  return s.length > n ? s.slice(0, n) + `\n… [${(s.length - n).toLocaleString()} more chars]` : s;
}

function resultText(content) {
  if (typeof content === 'string') return { text: content, images: [] };
  const images = [];
  const parts = [];
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b.type === 'text') parts.push(b.text);
      else if (b.type === 'image' && b.source?.data && b.source.data.length < MAX_IMAGE_B64) images.push(`data:${b.source.media_type};base64,${b.source.data}`);
      else if (b.type === 'image') parts.push('[image]');
      else if (b.type === 'tool_reference') parts.push(`[tool: ${b.tool_name}]`);
    }
  }
  return { text: parts.join('\n'), images };
}

export function loadTranscript(file) {
  const text = fs.readFileSync(file, 'utf8');
  const items = [];
  const toolIndex = new Map(); // tool_use_id -> block
  let current = null; // current assistant turn
  const seenPr = new Set();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('{"type":"api-request') || line.startsWith('{"type":"file-history')) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.isSidechain) continue;
    const ts = d.timestamp;
    if (d.type === 'system') {
      if (d.subtype === 'compact_boundary') { items.push({ kind: 'divider', label: 'Conversation compacted', ts, uuid: d.uuid }); current = null; }
      else if (d.subtype === 'local_command' && d.content) {
        const out = String(d.content).replace(/<\/?local-command-std(out|err)>/g, '').trim();
        if (out) items.push({ kind: 'note', text: clip(out, 4000), ts, uuid: d.uuid });
      }
      continue;
    }
    // Claude Code re-emits pr-link on every turn; show each PR once, where it first appeared.
    if (d.type === 'pr-link' && d.prUrl) {
      if (!seenPr.has(d.prUrl)) { seenPr.add(d.prUrl); items.push({ kind: 'pr', url: d.prUrl, number: d.prNumber, repo: d.prRepository, ts }); }
      continue;
    }
    if (d.type === 'user') {
      const c = d.message?.content;
      if (d.isCompactSummary) { items.push({ kind: 'summary', text: typeof c === 'string' ? c : resultText(c).text, ts, uuid: d.uuid }); current = null; continue; }
      if (Array.isArray(c) && c.some(b => b.type === 'tool_result')) {
        for (const b of c) {
          if (b.type !== 'tool_result') continue;
          const tu = toolIndex.get(b.tool_use_id);
          const r = resultText(b.content);
          if (tu) { tu.result = clip(r.text); tu.isError = !!b.is_error; if (r.images.length) tu.images = r.images; }
        }
        continue;
      }
      if (d.isMeta) continue;
      let raw = typeof c === 'string' ? c : (Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('\n') : '');
      const textOut = cleanPromptText(raw);
      if (textOut.startsWith('<local-command-stdout>') || textOut.startsWith('<local-command-stderr>')) {
        const out = textOut.replace(/<\/?local-command-std(out|err)>/g, '').trim();
        if (out) items.push({ kind: 'note', text: clip(out, 4000), ts, uuid: d.uuid });
        continue;
      }
      const images = Array.isArray(c) ? c.filter(b => b.type === 'image' && b.source?.data && b.source.data.length < MAX_IMAGE_B64).map(b => `data:${b.source.media_type};base64,${b.source.data}`) : [];
      if (!textOut && !images.length) continue;
      if (textOut.startsWith('<task-notification>')) {
        const tag = k => (textOut.match(new RegExp(`<${k}>([\\s\\S]*?)</${k}>`)) || [])[1]?.trim();
        items.push({ kind: 'note', text: `⚑ Background task ${tag('status') || 'update'}: ${tag('summary') || tag('task-id') || ''}`, ts, uuid: d.uuid });
        continue;
      }
      if (textOut.startsWith('[Request interrupted')) { items.push({ kind: 'note', text: textOut, ts, uuid: d.uuid }); continue; }
      items.push({ kind: 'user', text: textOut, images, ts, uuid: d.uuid });
      current = null;
      continue;
    }
    if (d.type === 'assistant' && d.message && Array.isArray(d.message.content)) {
      const m = d.message;
      if (!current) {
        current = { kind: 'assistant', blocks: [], ts, uuid: d.uuid, model: m.model, endTs: ts };
        items.push(current);
      }
      current.endTs = ts;
      if (m.model && m.model !== '<synthetic>') current.model = m.model;
      for (const b of m.content) {
        if (b.type === 'text' && b.text?.trim()) current.blocks.push({ type: 'text', text: b.text });
        else if (b.type === 'thinking' && b.thinking?.trim()) current.blocks.push({ type: 'thinking', text: clip(b.thinking, 20000) });
        else if (b.type === 'tool_use') {
          const blk = { type: 'tool', id: b.id, name: b.name, input: b.input, ts };
          const s = JSON.stringify(b.input ?? {});
          if (s.length > MAX_TOOL_TEXT) blk.input = { _truncated: clip(s) };
          toolIndex.set(b.id, blk);
          current.blocks.push(blk);
        }
      }
    }
  }
  return items.filter(it => it.kind !== 'assistant' || it.blocks.length);
}
