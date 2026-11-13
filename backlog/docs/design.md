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

## 5. Executors
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

## 6. Review policy
Each ticket is roughly one PR. `review` is set per repo or project, and a ticket can override it:
- `self`: the worker tests its own change and merges it, then the ticket goes to done.
- `pr`: the ticket stops at `in_review` until `bl approve`.
- `ask` (the default): like `pr`, flagged as needing the user.

## 7. chito board
- `/backlog`:
  - a daemon bar (status, workers, runs today, in flight against the cap, pause and resume);
  - **In flight**: every running ticket with its executor (daemon, orchestrator or session), model, elapsed time, and a link to the worker's session;
  - swim lanes per project, with lifecycle and executor badges, progress, and Start / Pause / Resume.
- `/backlog/<PROJ>`: project controls (lifecycle, executor, evergreen, archive), the dependency graph, and a sortable ticket table in topological order showing waits-on / blocks chips, tries, agent and sessions.
- **Ticket drawer**: spec, result, metadata, sessions and activity, plus Reopen / Approve / Cancel, priority, model and assignee.

Every control posts to `/api/backlog/action`, which maps a fixed allowlist of actions to `bl` commands.

## 8. Safety
- Workers never deploy, spend money or push to main unless the ticket says so and isn't assigned to `human`.
- The daemon only touches `executing` daemon projects, respects the caps and the daily limit, and can be paused globally.
- Projects start in `planning`.
- chito binds to localhost, refuses non-local Host headers, and requires a custom header on POSTs.
