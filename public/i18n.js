// UI strings: English is the source text and the key; each other locale is a map from it.
// t('Search sessions') or t('{n} prompts', { n }). A key missing from the locale falls back to English.
// Only chrome goes through t(): transcripts, ticket titles and bodies, and comments are never translated.
// scripts/check-i18n.mjs fails if a key used in the UI is missing from a locale.
import zhCN from '/i18n/zh-CN.js';

const LOCALES = { en: null, zh: zhCN };
const norm = v => (v === 'zh' || /^zh(-|$)/i.test(v || '') ? 'zh' : v === 'en' || /^en(-|$)/i.test(v || '') ? 'en' : null);

function pick() {
  try {
    const q = norm(new URL(location.href).searchParams.get('lang'));
    if (q) { localStorage.setItem('chito.lang', JSON.stringify(q)); return q; }
    return norm(JSON.parse(localStorage.getItem('chito.lang'))) || 'en';
  } catch { return 'en'; }
}

export const lang = pick();
// The BCP 47 tag for Intl / toLocale* calls; undefined in English keeps the browser's own formats.
export const LOCALE = lang === 'zh' ? 'zh-CN' : undefined;
const dict = LOCALES[lang];
document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';

// A key may carry a context after '|' when one English word needs two translations: t('Open|tickets').
export function t(key, vars) {
  let s = (dict && dict[key]) || key.replace(/\|[^|]*$/, '');
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}
// English plural choice: tp(n, '{n} session', '{n} sessions'). Both forms are keys; Chinese maps them alike.
export const tp = (n, one, other, vars) => t(n === 1 ? one : other, { n, ...vars });

export function setLang(v) {
  try { localStorage.setItem('chito.lang', JSON.stringify(v)); } catch { }
  const url = new URL(location.href);
  url.searchParams.delete('lang');
  location.replace(url.pathname + url.search + url.hash);
}

// Static markup: data-i18n (the element's text is the key), data-i18n-html (the attribute is a key whose
// translation is trusted markup from the strings file), data-i18n-attr="title placeholder" (each attribute's value is a key).
export function applyStatic(root = document) {
  if (!dict) return;
  root.querySelectorAll('[data-i18n]').forEach(n => { n.textContent = t(n.textContent.trim()); });
  root.querySelectorAll('[data-i18n-html]').forEach(n => { n.innerHTML = t(n.dataset.i18nHtml); });
  root.querySelectorAll('[data-i18n-attr]').forEach(n => {
    for (const a of n.dataset.i18nAttr.split(/\s+/).filter(Boolean)) if (n.hasAttribute(a)) n.setAttribute(a, t(n.getAttribute(a)));
  });
}
