// PR state from GitHub through the local `gh` CLI (no app or token setup: it reuses `gh auth`).
// One GraphQL request per batch of PRs; results are cached by how likely they are to change.
import { execFile } from 'node:child_process';

const FIELDS = `title state isDraft merged mergedAt closedAt createdAt updatedAt url
  author { login } additions deletions changedFiles headRefName baseRefName reviewDecision
  comments { totalCount }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BATCH = 40;
const cache = new Map(); // url -> { at, data, error }
let lastError = null;

// Merged PRs never change; closed ones rarely reopen; open ones move.
function ttl(entry) {
  if (!entry.data) return 5 * 60e3;
  if (entry.data.state === 'MERGED') return 6 * 3600e3;
  if (entry.data.state === 'CLOSED') return 10 * 60e3;
  return 60e3;
}

function gh(query) {
  return new Promise(resolve => {
    execFile('gh', ['api', 'graphql', '-f', `query=${query}`], { maxBuffer: 16 << 20, timeout: 30e3 }, (err, stdout, stderr) => {
      // Partial failures (a deleted repo, a missing PR) exit 1 but still print data for the rest.
      let json = null;
      try { json = JSON.parse(stdout); } catch { }
      if (!json) return resolve({ error: (stderr || err?.message || 'gh failed').trim() });
      resolve({ json });
    });
  });
}

function shape(pr) {
  if (!pr) return null;
  return {
    title: pr.title,
    state: pr.isDraft && pr.state === 'OPEN' ? 'DRAFT' : pr.state, // OPEN | DRAFT | MERGED | CLOSED
    mergedAt: pr.mergedAt, closedAt: pr.closedAt, createdAt: pr.createdAt, updatedAt: pr.updatedAt,
    author: pr.author?.login || null,
    additions: pr.additions, deletions: pr.deletions, changedFiles: pr.changedFiles,
    head: pr.headRefName, base: pr.baseRefName,
    review: pr.reviewDecision, // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
    comments: pr.comments?.totalCount ?? 0,
    checks: pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || null, // SUCCESS | FAILURE | PENDING | ERROR | EXPECTED
  };
}

/** prs: [{ url, repo, number }] -> Map(url -> { data, error }) */
export async function prStates(prs, { force = false } = {}) {
  const now = Date.now();
  const valid = prs.filter(p => REPO_RE.test(p.repo || '') && Number.isInteger(p.number));
  const need = valid.filter(p => {
    const c = cache.get(p.url);
    return force || !c || now - c.at > ttl(c);
  });
  for (let i = 0; i < need.length; i += BATCH) {
    const chunk = need.slice(i, i + BATCH);
    const parts = chunk.map((p, j) => {
      const [owner, name] = p.repo.split('/');
      return `p${j}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${p.number}) { ${FIELDS} } }`;
    });
    const { json, error } = await gh(`query { ${parts.join('\n')} }`);
    if (error) { lastError = error; break; }
    lastError = null;
    const errs = new Map((json.errors || []).map(e => [e.path?.[0], e.message]));
    chunk.forEach((p, j) => {
      const node = json.data?.[`p${j}`]?.pullRequest;
      cache.set(p.url, { at: Date.now(), data: shape(node), error: node ? null : errs.get(`p${j}`) || 'not found' });
    });
  }
  const out = new Map();
  for (const p of valid) {
    const c = cache.get(p.url);
    out.set(p.url, c ? { data: c.data, error: c.error } : { data: null, error: lastError || 'not fetched' });
  }
  return { states: out, error: lastError };
}
