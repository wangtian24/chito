# Backlog: a local ticket DAG for Claude Code agents

A lightweight, Linear-like backlog in one SQLite file. Many Claude Code sessions and background agents use it as their shared source of truth for long-horizon work. It has:
- projects with a lifecycle;
- tickets with states and a dependency DAG;
- atomic claims with leases;
- two kinds of executor: a session that runs a DAG, and a background daemon that drains queues;
- a board in chito.

## 1. Pieces

| Piece | Where | Role |
|---|---|---|
| `bl` | `backlog/bin/bl` (stdlib Python, symlinked into `~/.local/bin`) | The CLI, the orchestrator and the daemon. **The only writer** of the database |
| Database | `~/.backlog/backlog.db` (`BL_HOME`, `BL_DB`), SQLite in WAL mode | projects, tickets, deps, events, settings, runs |
| Skills | `backlog/skills/{backlog,backlog-run,backlog-worker}` | `/backlog` (master triage), `/backlog-run` (execute), `backlog-worker` (the per-ticket contract) |
| Hooks | `~/.claude/settings.json` → `bl hook session-start / stop / beat` | Inject the ticket into worker sessions, block a worker from stopping before it reports, renew leases and ownership |
| Daemon | LaunchAgent `com.chito.backlog-daemon` → `bl daemon run` | Drains executing daemon projects |
| Board | chito `/backlog`, `/backlog/<PROJ>`, `/backlog/<PROJ>/<KEY>` | Swim lanes, in-flight tickets, dependency graph, ticket table, drawer, and controls (which call `bl`) |
| Local overlay | `~/.backlog/LOCAL.md` (not in the repo) | Machine-specific conventions the skills read: doc store, review policy per repo, notifications |

## 2. Data model

| Table | Holds |
|---|---|
| `projects` | `key`, name, repo, `doc_slug`, **`status`** (planning, executing, paused, done, archived), **`executor`** (session or daemon), **`owner`** and `owner_heartbeat`, **`evergreen`**, `next_seq`, `meta` |
| `tickets` | `key` (PROJ-12), title, body (the spec), state, priority 0–4, estimate, labels, assignee (null or `human`), `doc_slug`, parent, `locks`, attempts / max_attempts, `claimed_by`, `lease_until`, `result` (the summary for downstream tickets), `meta` (review, size, model, executor, …), timestamps |
| `deps` | `(ticket, blocker)` edges, checked for cycles on insert with a recursive CTE; edges may cross projects |
| `events` | Append-only log: created, state, comment, claim, spawn, dep, edit, project, run, daemon. Each records an actor and **the Claude Code session id that wrote it**, which chito uses to link tickets to sessions |
| `settings` | `(scope, key, JSON value)`; resolved `label:x`, then `project:X`, then `global` |
| `runs` | Orchestrator and daemon processes (`kind`), with pid and heartbeat |

## 3. Lifecycles

**Project**
```
planning ──start──► executing ──(all tickets final, not evergreen)──► done
   ▲  ◄────plan─────  │  ▲                                             │ new ticket
   │               pause resume                                       ▼
   │                  ▼  │                                        executing
   │                 paused
   └──────── archive (from any state) ──► archived
```
Only `executing` projects are claimable, so `planning` is a safe place to build and regroom the graph.

**Ticket**: `backlog → todo → in_progress → in_review → done`, plus `failed` (out of attempts; blocks its dependents) and `canceled` (unblocks them). "Blocked" is derived from the graph, never stored.

**Ready** = in `todo`, every blocker done or canceled, assignee not `human`, no needed lock held by a running ticket, the project `executing`, and the executor matching the claimer.

## 4. Claims, leases, ownership
- A claim is one `BEGIN IMMEDIATE` transaction:
  1. reap expired leases;
  2. check the caps: `global_max_parallel` (6, all executors), `daemon_max_parallel` and `daemon_max_runs_per_day` for the daemon, and `max_parallel` per project;
  3. take the first ready ticket by (priority, id);
  4. set `in_progress`, increment attempts, set the lease.

  In testing, 20 concurrent claimers got 20 different tickets.
- Leases are kept alive by the orchestrator or daemon for their children, by the PostToolUse hook for sessions, or by hand with `bl beat`. An expired lease sends the ticket back to `todo`, or to `failed` once it's out of attempts. Every `bl` call reaps, so no daemon is needed for correctness.
- A session-mode claim makes the claimer the project's `owner`. A session project with a stale owner heartbeat and no live run is **orphaned**: with `orphan_policy=wait` (the default) it waits for a person; with `daemon`, the daemon adopts it.

## 5. Execution modes

Each project runs in one of three modes. Its `executor` field holds the mode, and a ticket can override it.

| Mode | `executor` | Board marking | What happens |
|---|---|---|---|
| **SO**: session orchestrator | `session` | Orchestrated · SO | You start `/backlog-run PROJ` in a session; it orchestrates (inline, subagents or `bl run`) until done. **If that session goes away**, the project has ready tickets, no live owner, and no activity for `adopt_after_minutes` (10), the daemon **adopts** it with a DSO session (`orphan_policy=adopt`). |
| **DSO**: daemon session orchestrator | `auto` | Orchestrated · DSO | The daemon watches the project. Whenever tickets are ready and no orchestrator is alive, it starts an orchestrator session: `claude -p` with `bl orchestrate-prompt PROJ`, which claims tickets, runs one subagent per ticket in parallel, records results, adjusts downstream specs and keeps going until nothing is ready. When more tickets become ready later, it starts another. |
| **DQ**: daemon queue | `daemon` | Queue · DQ | The daemon starts one `claude -p` per ready ticket. No coordinating session. |

The goal: once a project is executing, it moves as far as it can without you. You add tasks and step in only for human touchpoints: tickets assigned to `human` (answers, decisions, deploys), PRs in review (`review=pr|ask`), failed tickets, and milestone showcases to view and accept.

### Usage limits
When a worker or orchestrator exits on a usage or rate limit (detected in its log: "usage limit reached|<epoch>", "resets 3pm", 429, …):
- its tickets go back to `todo` **without** using an attempt;
- `quota_until` is set to the reset time, or `quota_backoff_minutes` (30) when no reset time is given;
- every claim (daemon, orchestrators, sessions) waits until then;
- `bl status`, `bl daemon status` and the board show the pause;
- once the time passes, the daemon resumes **by itself**. It starts one probe worker first, and goes back to full capacity once that worker has run for 90 seconds or reported back. If the probe hits the limit again, the pause is set again with the new reset time. DSO orchestrator sessions also wait for the probe.

A lapsed lease (a session that closed, slept, or died on a limit) puts the ticket back without using an attempt. Attempts are used up only when a worker process exits without reporting, or when it reports `bl fail`.

`bl quota` shows the pause, `bl quota clear` (or **Retry now** on the board) retries immediately, and `bl quota set MIN` pauses by hand.

## 5b. Executors (details)
| | Daemon | Session |
|---|---|---|
| Fits | Queues of independent tickets; evergreen projects anyone adds to | DAGs that need judgment between steps |
| Started by | Nobody: `bl daemon` is always on (launchd) | `/backlog-run`: inline, subagents, or `bl run` |
| Claims | `executing` projects with executor `daemon` (plus tickets whose own executor is `daemon`, plus orphans if adopted) | `executing` session projects |
| Workers | `claude -p "$(bl prompt KEY)"` per ticket, in a git worktree (or `~/.backlog/work/<KEY>` when there's no repo) | Same `worker_cmd` (orchestrator), or the session itself or its subagents |

**Daemon loop** (`bl daemon run`, single instance through `flock`), every `poll_seconds`:
1. Reap leases and finalize projects that are finished.
2. Collect finished or timed-out workers. One that exited without reporting gets its ticket retried or failed.
3. Fill free slots round-robin across projects: the project with the fewest of the daemon's workers goes first, so one queue can't starve another.
4. Renew leases and heartbeat.

Switches: `bl daemon pause|resume` (or the button in chito), `bl daemon status`, `bl daemon install|uninstall`.

**Worker model**: `opus` by default; a ticket sets `model` (for example `sonnet` for simple, mechanical work).

**Worker prompt** (`bl prompt KEY`): the spec, the design docs to read, each upstream ticket's `result`, recent comments, the review policy, the size hint, and the worker protocol.

## 5b2. Human tickets get a briefing session
A ticket assigned to `human` (a review, a test, a go/no-go, an answer) never runs by itself. Once it's unblocked, the daemon starts a **briefing session**: a `claude -p` that gathers the context (the spec, what each upstream ticket delivered and its PR, the design doc), works out how you can see the work (it starts a local preview when the spec asks for one and that's safe), and writes a short briefing that ends with 1 to 3 questions. The board links that session as the place to answer.

The briefing must record a **handoff packet** (`bl handoff KEY --packet -`). Every field is required, otherwise the command refuses it: a summary, how to see it (the preview URL and the command), links, **everything done and new** (each item with its PR), **what to test** (each step with what good and bad look like), known gaps, and 1 to 3 questions ending with the decision. Recording it moves the handoff through its phases:
- **preparing**: AI-owned, while the packet is compiled;
- **awaiting**: you're notified (a macOS notification, or `notify_human_cmd`, plus `notify_cmd`);
- **discussing**: once you reply;
- **done**: on `bl resolve`.

chito shows the packet at the top of the ticket's panel: a preview button, the done list, a checklist of tests, gaps, the questions, and a reply box that sends your feedback into the handoff session.

You can also resume the session (**Answer in terminal** on the board, or `o` in chito) and reply there. The session interviews you if your answer is unclear. It turns problems you report into new tickets (`--blocks` the decision, so it comes back to you once they land), records your words with `bl comment`, and closes the ticket with `bl resolve KEY -m "<decision>"`. No briefing yet? The board falls back to the worker or orchestrator session. Turn this off with `bl config global brief_humans false`.

## 5c. Milestones and showcases
A project's roadmap is an ordered list of milestones (`bl milestone add PROJ "Title" [--trigger all|deploy|manual] [--gate KEY] [--showcase screenshot|demo|localhost|link|none] [--due DATE]`). Tickets join one with `--milestone PROJ-M1`.
- **Triggers:**
  - `all`: the milestone is reached when its tickets are final;
  - `deploy`: it's reached when the gate ticket (the deploy) is done;
  - `manual`: you reach it with `bl milestone reach`.
- **Showcase:** each milestone gets a showcase ticket that waits on the milestone's work, or on the deploy gate. Its worker produces the portfolio piece (screenshots, a demo, a localhost URL, a link) and records it with `bl milestone showcase M --file|--url|--note`. Files are copied to `~/.backlog/showcase/<M>/`.
- **Status:** planned → active → reached → showcased → **accepted**. You view the showcase and run `bl milestone accept M`, or `bl milestone reopen M --note "..."`. A showcased milestone counts as waiting on you.

## 5d. Cost and usage
chito computes per-ticket turns, tokens and nominal cost from the worker transcripts, including subagent transcripts. Only sessions dedicated to one ticket count toward that ticket. Shared sessions (planners, DSO orchestrators) count toward the project's "orchestration and shared" total. Prices are list prices per model (`lib/pricing.js`, which `prices` in `~/.config/chito/config.json` can override); on a subscription nothing is billed per token.

## 6. Review policy
Each ticket is roughly one PR. `review` is set per repo or project, and a ticket can override it:
- `self`: the worker tests its own change and merges it, then the ticket goes to done.
- `pr`: the ticket stops at `in_review` until `bl approve`.
- `ask` (the default): like `pr`, flagged as needing the user.

## 7. chito board
- `/backlog`:
  - an auto-refresh setting (off, or 1m to 1h) and Refresh;
  - a daemon bar (status, workers, runs today, in flight against the cap, pause and resume, plus a usage-limit banner with Retry now);
  - **In flight**: every running ticket with its executor (daemon, orchestrator or session), model, elapsed time, and a link to the worker's session;
  - swim lanes per project, with lifecycle and mode badges, who is executing (orchestrator pid and session, DSO session, or queue), the next milestone, progress, and Start / Pause / Resume. Lanes collapse to a compact row (counts and up to 3 running tickets); Collapse all / Expand all.
- `/backlog/<PROJ>`: project controls (lifecycle, mode SO / DSO / DQ, evergreen, archive), total nominal cost, the roadmap (milestone cards with showcases; clicking one filters the table), the dependency graph (columns ordered to reduce crossings), and a sortable ticket table. In dependency order it's a tree: each ticket hangs under its deepest blocker, with connector lines, and the other blockers show as chips. Columns: state, waits on / blocks, priority, tries, who ran it, milestone, PRs (live state), turns, tokens, cost, session.
- **Ticket drawer**: spec, result, metadata, usage, PRs, sessions and activity, plus Reopen / Approve / Cancel, priority, model, assignee and milestone. Clicking outside it closes it.

Every control posts to `/api/backlog/action`, which maps a fixed allowlist of actions to `bl` commands.

## 8. Safety
- Workers never deploy, spend money or push to main unless the ticket says so and isn't assigned to `human`.
- The daemon only touches `executing` daemon projects, respects the caps and the daily limit, and can be paused globally.
- Projects start in `planning`.
- chito binds to localhost, refuses non-local Host headers, and requires a custom header on POSTs.
