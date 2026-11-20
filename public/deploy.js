// Deployment: Mapcouch's merges on main as one chain, newest at the top. Two pointers ride it:
// HEAD (the newest merge) and Live (the commit production runs). Merges above Live are waiting;
// each prod/ release below it is a knot that says when it shipped and how many merges it carried.
import { t, tp, LOCALE } from '/i18n.js';

const $ = s => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

let ctx = {};
let data = null, error = null, loading = null, timer = null, showOlder = false, armed = null, armedAt = 0;
const OLDER_RELEASES = 4;   // releases shown below Live before "Show older"

export function initDeploy(c) { ctx = c; load(); setInterval(() => { if (!document.hidden && !timer) load(); }, 5 * 60000); }

export function startDeployPolling() {
  stopDeployPolling();
  timer = setInterval(() => { if (!document.hidden) load(); }, data?.run ? 20000 : 60000);
}
export function stopDeployPolling() { clearInterval(timer); timer = null; }

async function load(refresh = false) {
  if (loading) { if (refresh) loading.then(() => load(true)); return loading; }
  let done; loading = new Promise(r => { done = r; });
  try {
    const r = await fetch('/api/deploy' + (refresh ? '?refresh=1' : ''));
    const d = await r.json();
    if (d.error) { error = d.error; data = null; } else { error = null; data = d; }
  } catch (e) { error = e.message; }
  loading = null; done();
  const n = $('#dp-count');
  if (n) n.textContent = data?.waiting ? String(data.waiting) : '';
  if (!$('#deploy').hidden) { renderDeploy(); if (timer) startDeployPolling(); }
}

const short = sha => (sha || '').slice(0, 7);
const ghBase = () => `https://github.com/${data.repo}`;
function fmtIn(iso) {
  const s = (new Date(iso) - Date.now()) / 1000;
  if (s < 60) return t('in under a minute');
  const mins = Math.round(s / 60);
  if (mins < 60) return t('in {n}m', { n: mins });
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? t('in {h}h {m}m', { h, m }) : t('in {h}h', { h });
}
// Pin every deploy timestamp to Pacific Time, including daylight saving transitions.
function pacificTime(iso, date = true) {
  if (!iso || !Number.isFinite(new Date(iso).getTime())) return '—';
  return new Date(iso).toLocaleString(LOCALE || 'en-US', {
    timeZone: 'America/Los_Angeles',
    ...(date ? { month: 'short', day: 'numeric', year: 'numeric' } : {}),
    hour: 'numeric', minute: '2-digit',
  }) + ' PT';
}
const clock = iso => pacificTime(iso, false);
function ext(href, text, cls) { const a = el('a', cls, text); a.href = href; a.target = '_blank'; a.rel = 'noopener'; return a; }
function inner(href, text, cls) {
  const a = el('a', cls, text); a.href = href;
  a.addEventListener('click', e => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); ctx.navigate(href); });
  return a;
}

function stat(label, value, note, cls) {
  const c = el('div', 'dp-stat' + (cls ? ' ' + cls : ''));
  c.append(el('div', 'dp-stat-label', label));
  const v = el('div', 'dp-stat-value'); v.append(value); c.append(v);
  if (note) { const n = el('div', 'dp-stat-note'); n.append(note); c.append(n); }
  return c;
}

function deployButton() {
  const b = el('button', 'btn primary');
  b.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';
  const label = el('span');
  b.append(label);
  const n = data.waiting;
  if (data.run) { b.disabled = true; label.textContent = t('Deploy running…'); }
  else if (n === 0) { b.disabled = true; label.textContent = t('Nothing to deploy'); }
  else if (armed && n == null) { label.textContent = t('Confirm: deploy main'); b.classList.add('armed'); }
  else if (armed) { label.textContent = tp(n, 'Confirm: ship {n} merge', 'Confirm: ship {n} merges'); b.classList.add('armed'); }
  else label.textContent = t('Deploy main');
  b.title = t('Deploys main from this laptop: tests, ship, verify, release note to Slack');
  b.addEventListener('click', async () => {
    if (!armed) { armedAt = Date.now(); armed = setTimeout(() => { armed = null; renderDeploy(); }, 5000); renderDeploy(); return; }
    if (Date.now() - armedAt < 500) return;   // the second half of a double-click is not a confirm
    clearTimeout(armed); armed = null;
    b.disabled = true; label.textContent = t('Starting…');
    try {
      const r = await fetch('/api/deploy/run', { method: 'POST', headers: { 'x-chito': '1' } });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      ctx.toast(t('Deploy started on this laptop. Tests take about 10 minutes; the result posts to Slack.'));
    } catch (e) { ctx.toast(t('Could not start the deploy: {err}', { err: e.message })); }
    await load(true);
  });
  return b;
}

// Pauses or resumes chito's deploy schedule; Deploy main still works while it is paused.
function pauseButton() {
  const paused = !!data.auto?.paused;
  const b = el('button', 'btn');
  b.innerHTML = paused
    ? '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z"/></svg>'
    : '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5v14M15 5v14"/></svg>';
  b.append(el('span', null, paused ? t('Resume schedule') : t('Pause schedule')));
  b.title = paused ? t('Let the schedule deploy main again at its next slot') : t('Stop scheduled deploys until you resume; Deploy main still works');
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const r = await fetch('/api/deploy/schedule', { method: 'POST', headers: { 'x-chito': '1', 'content-type': 'application/json' }, body: JSON.stringify({ paused: !paused }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      ctx.toast(d.paused ? t('Schedule paused. No scheduled deploys until you resume.') : t('Schedule resumed.'));
    } catch (e) { ctx.toast(t('Could not change the schedule: {err}', { err: e.message })); }
    await load();
  });
  return b;
}

function head() {
  const h = el('div', 'board-head');
  const left = el('div');
  left.append(el('h1', null, t('Deployment')));
  const p = el('p');
  p.append(ext('https://mapcouch.com', 'mapcouch.com'), ' · ', ext(ghBase(), data.repo), ' · ',
    data.auto?.paused ? t('the schedule is paused; deploys run when you press Deploy')
      : data.schedule?.text === 'every hour' ? t('checks every hour and deploys only when main has something new; or press Deploy')
      : data.schedule?.text ? t('checks on a schedule ({when}) and deploys only when main has something new; or press Deploy', { when: data.schedule.text })
      : t('deploys when you press Deploy'));
  left.append(p);
  const right = el('div', 'bl-head-right');
  const rf = el('button', 'btn');
  rf.title = t('Fetch main and the release tags again');
  rf.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.9-3.9M4 5v4h4M4 13a8 8 0 0 0 14.9 3.9M20 19v-4h-4"/></svg>';
  rf.append(el('span', null, t('Refresh')));
  rf.addEventListener('click', async () => { rf.disabled = true; await load(true); ctx.toast(t('Up to date')); });
  right.append(rf);
  if (data.auto?.enabled) right.append(pauseButton());
  right.append(deployButton());
  h.append(left, right);
  return h;
}

function stats() {
  const row = el('div', 'dp-stats');
  const live = data.live;
  row.append(stat(t('Live'), live ? live.tag.replace(/^prod\//, '') : short(data.production) || '—',
    live ? t('deployed at {time}', { time: pacificTime(live.at) }) : null, 'is-live'));
  row.append(stat(t('Waiting'), data.waiting == null ? '?' : data.waiting ? tp(data.waiting, '{n} merge', '{n} merges') : t('Up to date'),
    data.waiting ? t('HEAD {sha}, merged at {time}', { sha: short(data.head), time: pacificTime(data.commits[0]?.at) }) : t('main is live'),
    data.waiting ? 'is-waiting' : ''));
  if (data.run) {
    const started = data.run.createdAt;
    row.append(stat(t('Deploying now'), t('started at {time}', { time: pacificTime(started) }),
      ext(data.run.url, t('Watch the run')), 'is-running'));
  } else if (data.next) {
    row.append(stat(t('Next deploy'), data.next ? clock(data.next) : '—',
      data.next ? (data.waiting ? t('{in}, ships what is waiting', { in: fmtIn(data.next) }) : t('{in}, skipped if nothing new', { in: fmtIn(data.next) })) : null));
  }
  const lr = data.lastRun;
  if (lr) {
    const ok = lr.conclusion === 'success';
    const word = { success: t('Succeeded'), failure: t('Failed'), cancelled: t('Cancelled') }[lr.conclusion] || lr.conclusion;
    const note = el('span');
    note.append(pacificTime(lr.updatedAt), ' · ', ext(lr.url, ok ? t('run') : t('log')));
    row.append(stat(t('Last run'), word, note, ok ? '' : 'is-failed'));
  }
  return row;
}

function ticketChip(tk) {
  const label = tk.key;
  const cls = 'dp-ticket bl-st-' + (tk.state || 'unknown');
  // The ticket opens in the side panel over this page (?ticket=KEY), as on Projects.
  const a = tk.project ? inner(`/deploy?ticket=${encodeURIComponent(tk.key)}`, label, cls) : el('span', cls, label);
  if (tk.title) a.title = `${tk.title}${tk.state ? ` (${tk.state.replace('_', ' ')})` : ''}`;
  return a;
}

function commitRow(c, zone, marks) {
  const li = el('li', `dp-commit ${zone}`);
  li.append(el('span', 'dp-dot', null));
  const body = el('div', 'dp-body');
  const top = el('div', 'dp-title-row');
  for (const m of marks) top.append(m);
  top.append(el('span', 'dp-title', c.title || c.subject));
  body.append(top);
  const meta = el('div', 'dp-meta');
  meta.append(ext(`${ghBase()}/commit/${c.sha}`, short(c.sha), 'dp-sha num'));
  if (c.pr) meta.append(ext(`${ghBase()}/pull/${c.pr}`, `#${c.pr}`, 'dp-pr num'));
  for (const tk of c.tickets) meta.append(ticketChip(tk));
  const when = el('span', 'dp-when', pacificTime(c.at));
  when.title = pacificTime(c.at);
  meta.append(when);
  body.append(meta);
  li.append(body);
  return li;
}

function pointer(cls, text, title) { const p = el('span', 'dp-ptr ' + cls, text); if (title) p.title = title; return p; }

function releaseKnot(rel, count, isLive) {
  const li = el('li', 'dp-knot' + (isLive ? ' is-live' : ''));
  li.append(el('span', 'dp-ring'));
  const b = el('div', 'dp-knot-body');
  if (isLive) b.append(el('span', 'dp-knot-badge', t('Live on mapcouch.com')));
  const tag = ext(`${ghBase()}/releases/tag/${encodeURIComponent(rel.tag)}`, rel.tag, 'dp-tag num');
  b.append(tag);
  const when = el('span', 'dp-knot-when', t('shipped at {time}', { time: pacificTime(rel.at) }));
  when.title = pacificTime(rel.at);
  b.append(when, el('span', 'dp-knot-count', count == null ? '' : tp(count, '{n} merge', '{n} merges')));
  if (rel.redeploys) b.append(el('span', 'dp-knot-count', tp(rel.redeploys, 'redeployed {n} time', 'redeployed {n} times')));
  li.append(b);
  return li;
}

// chito runs the schedule itself: what it does, and what it did last.
function scheduleLine() {
  const b = data.auto || {};
  const p = el('p', 'dp-backup');
  if (!b.enabled) { p.textContent = t('No schedule: deploys run only when you press Deploy (CHITO_DEPLOY_CRON=off).'); return p; }
  if (b.paused) {
    p.append(el('span', 'dp-backup-err', b.pausedAt ? t('Schedule paused at {time}.', { time: pacificTime(b.pausedAt) }) : t('Schedule paused.')),
      ' ', t('chito skips its checks ({when}) until you press Resume schedule; Deploy main still works.', { when: data.schedule.text }));
    return p;
  }
  p.append(t('Schedule: chito checks {when} ({tz}); if main has something new and nothing is running, it deploys main. A commit whose deploy failed waits for the next merge.', { when: data.schedule.text, tz: data.schedule.tz }));
  if (b.lastAt) {
    const last = el('span', 'dp-backup-last');
    last.append(' ', b.lastAction === 'started' ? t('Last check at {time}: started one.', { time: pacificTime(b.lastAt) }) : t('Last check at {time}: nothing to do ({why}).', { time: pacificTime(b.lastAt), why: String(b.lastAction || '').replace(/^skipped: /, '') }));
    if (b.lastUrl) last.append(' ', ext(b.lastUrl, t('run')));
    p.append(last);
  }
  if (b.lastError) p.append(' ', el('span', 'dp-backup-err', t('Last check failed: {err}', { err: b.lastError })));
  return p;
}

function chain() {
  const ol = el('ol', 'dp-chain');
  const commits = data.commits;
  const liveIdx = commits.findIndex(c => c.sha === data.production);
  const runSha = data.run?.headSha;
  const failSha = data.lastRun && data.lastRun.conclusion !== 'success' ? data.lastRun.headSha : null;

  // The schedule's next stop sits above HEAD while there is something to ship.
  if (data.waiting && !data.run && data.next) {
    const li = el('li', 'dp-next');
    li.append(el('span', 'dp-clock'));
    li.append(el('div', 'dp-next-body', t('Next scheduled deploy at {time} ({in}) ships everything below down to Live', { time: clock(data.next), in: fmtIn(data.next) })));
    ol.append(li);
  }

  // Merges each release carried: from it down to the next older release.
  // The oldest release in the window has no older one to count to, so it shows no count.
  const carried = new Map();
  let prev = null;
  for (let i = 0; i < commits.length; i++) if (commits[i].release) { if (prev != null) carried.set(prev, i - prev); prev = i; }

  let releasesBelow = 0, cut = commits.length;
  if (!showOlder && liveIdx >= 0) {
    for (let i = liveIdx + 1; i < commits.length; i++) if (commits[i].release && ++releasesBelow > OLDER_RELEASES) { cut = i; break; }
  }
  if (liveIdx < 0 && data.production) {
    const li = el('li', 'dp-next');
    li.append(el('span', 'dp-clock'));
    li.append(el('div', 'dp-next-body', t('Live ({sha}) is older than the last {n} merges shown here', { sha: short(data.production), n: commits.length })));
    ol.append(li);
  }

  for (let i = 0; i < cut; i++) {
    const c = commits[i];
    const zone = liveIdx < 0 || i < liveIdx ? 'is-waiting' : 'is-shipped';
    if (c.release) ol.append(releaseKnot(c.release, carried.get(i) ?? null, i === liveIdx));
    const marks = [];
    if (i === 0) marks.push(pointer('ptr-head', 'HEAD', t('Newest merge on main')));
    if (c.sha === runSha) marks.push(pointer('ptr-run', t('Deploying'), t('The deploy running now ships up to here')));
    else if (c.sha === failSha && i < (liveIdx < 0 ? Infinity : liveIdx)) marks.push(pointer('ptr-fail', t('Deploy failed'), t('The last deploy run stopped on this commit')));
    ol.append(commitRow(c, zone + (c.sha === runSha ? ' is-deploying' : ''), marks));
  }
  const frag = document.createDocumentFragment();
  frag.append(ol);
  if (cut < commits.length || showOlder) {
    const more = el('button', 'btn dp-more', showOlder ? t('Show fewer') : tp(commits.length - cut, 'Show {n} older merge', 'Show {n} older merges'));
    more.addEventListener('click', () => { showOlder = !showOlder; renderDeploy(); });
    frag.append(more);
  }
  return frag;
}

export function renderDeploy() {
  const root = $('#deploy-inner');
  if (!root) return;
  root.textContent = '';
  if (error) {
    const h = el('div', 'board-head'); const d = el('div'); d.append(el('h1', null, t('Deployment'))); h.append(d);
    root.append(h, el('div', 'board-status', t('Could not read the Mapcouch repo: {err}', { err: error })));
    return;
  }
  if (!data) { root.append(el('div', 'board-status', t('Loading…'))); return; }
  root.append(head(), stats());
  if (data.runsError) root.append(el('div', 'board-status', t('GitHub run status unavailable: {err}', { err: data.runsError })));
  root.append(scheduleLine());
  root.append(chain());
}
