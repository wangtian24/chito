---
name: backlog-run
description: Execute an orchestrated (SO) backlog project's tickets in dependency (topological) order until every ticket is done — inline in this session, via subagents, or via the `bl run` orchestrator that spawns parallel `claude -p` workers. Use when the user types /backlog-run, says "run the backlog", "execute PROJ", "work through the tickets", "drain the backlog", "keep going until it's all done", "resume the orphaned project", or "stop the run". (Daemon-executed projects need no run: the background daemon drains them.)
---

# /backlog-run: work through a session project's DAG

Argument: `<PROJ> [N]` (N is the parallelism), or `stop <PROJ>`. Read `~/.backlog/LOCAL.md` first if it exists.

## 1. Look before running
Run `bl status`, `bl run PROJ --dry-run` and `bl config PROJ`.
- **Mode DQ (`daemon`) or DSO (`auto`)**: don't run it here; the daemon drives it. If the user wants this session to take over, run `bl project pause PROJ`, `bl project set PROJ executor=session`, then `bl project resume PROJ`.
- **SO project the daemon adopted** (owner `orchs:…`): a DSO session is already running it, so leave it alone unless the user asks.
- **Project is `planning`**: show the waves, confirm once, then `bl project start PROJ`.
- **Review policy is `ask`** and you don't know the repo's rules: ask once, then `bl config PROJ review self|pr`.
- `worktree=true` gives each ticket its own git worktree (`<repo>-wt/<KEY>` on branch `bl/<key>`).

## 2. Pick a mode based on size (all three use the same claim protocol)
| Work | Mode | How |
|---|---|---|
| A few small tickets | **Inline**: this session does them one after another | loop `bl claim PROJ --json`, do the work (backlog-worker rules), `bl done/fail`; stop on exit code 3 |
| Medium | **Subagents** from this session | `bl claim PROJ KEY` for each ready ticket (up to N), dispatch an Agent with `bl prompt KEY` as its brief, in the background. When one returns, check it ran `bl done`, or run it from its report, then claim the next |
| Large or long-running, or the user is away | **Orchestrator** | `bl run PROJ --parallel N` in the background; one `claude -p` per ticket |

Claiming enforces the global in-flight cap (6, shared with the daemon) and the project's `max_parallel`. A session claim makes this session the project's **owner**, kept alive by the PostToolUse hook, or by the orchestrator's heartbeat. When the owner goes silent, the project shows as orphaned.

## 3. The orchestrator
- `bl run PROJ [--parallel N] [--until done|forever]`. It reaps expired leases, claims ready tickets, and starts `worker_cmd` with `BL_TICKET`, `BL_AGENT` and `BL_MODEL` (the ticket's `model`, or `opus`). It renews its children's leases, retries crashes up to `max_attempts`, and picks up tickets added mid-run.
- It exits 0 when everything is final, and the project moves to `done` unless it's evergreen. When stuck, it reports once and keeps waiting (`on_stuck=wait`), or exits 2.
- Watch its output with Monitor (filter `→|waiting|exited|timed out`) and report only real events, one line each. Don't poll.
- Worker logs: `~/.backlog/logs/<KEY>.<attempt>.log`. In chito, every in-flight ticket links to its worker session.

## 3b. Usage limits
If claims return "paused for usage limit until …", stop claiming. Tell the user the reset time; the daemon resumes the project after it. `bl quota clear` retries now.

## 4. When it gets stuck
List each blocker with what's needed. The options are `bl reopen KEY`, `bl cancel KEY`, fixing the spec, or `bl approve KEY` after a merge. Running a project grants no new permissions: `human` tickets stay with the user.

## 5. Stop
`/backlog-run stop PROJ`: find the PID with `sqlite3 ~/.backlog/backlog.db "select pid from runs where project='PROJ' and status='running'"`. Check that it is `bl run` with `ps -p PID -o command`, then `kill PID`. Its workers stop and their tickets go back to todo. Pausing (`bl project pause PROJ`, or the button in chito) is gentler: running work finishes and nothing new starts.
