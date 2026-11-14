#!/usr/bin/env node
// Fails if a UI string key is missing from a locale, or a translation drops or invents a {placeholder}.
// Keys come from t('…') / tr('…') and tp(n, '…', '…') / trp(n, '…', '…') in public/*.js, and from
// data-i18n, data-i18n-attr and data-i18n-html in public/index.html.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const LOCALES = ['zh-CN'];
const keys = new Map();   // key -> first place it was seen
const problems = [];
const see = (k, where) => { if (!keys.has(k)) keys.set(k, where); };

// A JS string literal starting at s[i] ('…', "…" or `…` without ${}); returns [value, end] or null.
function literal(s, i) {
  const q = s[i];
  if (!`'"\``.includes(q)) return null;
  let out = '';
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { const n = s[++j]; out += n === 'n' ? '\n' : n === 't' ? '\t' : n; continue; }
    if (q === '`' && c === '$' && s[j + 1] === '{') return { dynamic: true, end: j };
    if (c === q) return { value: out, end: j + 1 };
    out += c;
  }
  return null;
}
const lineOf = (s, i) => s.slice(0, i).split('\n').length;

for (const f of fs.readdirSync(PUB).filter(f => f.endsWith('.js') && f !== 'i18n.js')) {
  const src = fs.readFileSync(path.join(PUB, f), 'utf8');
  const re = /(?<![\w.$])(t|tr|tp|trp)\(/g;
  let m;
  while ((m = re.exec(src))) {
    const where = `${f}:${lineOf(src, m.index)}`;
    let i = m.index + m[0].length;
    const plural = m[1] === 'tp' || m[1] === 'trp';
    if (plural) {   // skip the count argument: up to the first top-level comma
      let depth = 0;
      for (; i < src.length; i++) { const c = src[i]; if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--; else if (c === ',' && depth === 0) { i++; break; } }
    }
    for (let n = 0; n < (plural ? 2 : 1); n++) {
      while (/\s/.test(src[i])) i++;
      const lit = literal(src, i);
      if (!lit) { problems.push(`${where}: ${m[1]}() needs a string literal key, so it can be checked`); break; }
      if (lit.dynamic) { problems.push(`${where}: ${m[1]}() key is a template with \${}; use {placeholders}`); break; }
      see(lit.value, where);
      i = lit.end;
      while (/\s/.test(src[i])) i++;
      if (plural && n === 0) { if (src[i] !== ',') { problems.push(`${where}: ${m[1]}() needs two string forms`); break; } i++; }
    }
  }
}

const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const unescape = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const attrsOf = tag => Object.fromEntries([...tag.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].slice(1).map(a => [a[1], a[2] == null ? '' : unescape(a[2])]));
for (const m of html.matchAll(/<(\w+)(\s[^>]*)>/g)) {
  const where = `index.html:${lineOf(html, m.index)}`;
  const a = attrsOf(m[0]);
  if ('data-i18n' in a) {
    const rest = html.slice(m.index + m[0].length);
    const text = rest.match(/^([^<]*)<\/\w+>/);
    if (!text || !text[1].trim()) problems.push(`${where}: data-i18n needs an element whose only content is text`);
    else see(unescape(text[1].trim()), where);
  }
  if ('data-i18n-html' in a) see(a['data-i18n-html'], where);
  if ('data-i18n-attr' in a) for (const name of a['data-i18n-attr'].split(/\s+/).filter(Boolean)) {
    if (a[name] == null) problems.push(`${where}: data-i18n-attr names ${name}, which the element lacks`);
    else see(a[name], where);
  }
}

const holes = s => [...s.matchAll(/\{(\w+)\}/g)].map(x => x[1]).sort().join(',');
for (const loc of LOCALES) {
  const dict = (await import(pathToFileURL(path.join(PUB, 'i18n', `${loc}.js`)).href)).default;
  for (const [k, where] of keys) {
    if (!(k in dict)) problems.push(`${loc}: missing ${JSON.stringify(k)} (used at ${where})`);
    else if (typeof dict[k] !== 'string' || !dict[k]) problems.push(`${loc}: empty translation for ${JSON.stringify(k)}`);
    else if (holes(dict[k]) !== holes(k)) {
      problems.push(`${loc}: placeholders differ for ${JSON.stringify(k)}: ${JSON.stringify(dict[k])}`);
    }
  }
  const unused = Object.keys(dict).filter(k => !keys.has(k));
  if (unused.length) console.warn(`${loc}: ${unused.length} unused key(s): ${unused.slice(0, 10).map(k => JSON.stringify(k)).join(', ')}${unused.length > 10 ? ' …' : ''}`);
}

if (problems.length) { console.error(problems.join('\n')); console.error(`\n${problems.length} i18n problem(s).`); process.exit(1); }
console.log(`i18n ok: ${keys.size} keys, all present in ${LOCALES.join(', ')}.`);
