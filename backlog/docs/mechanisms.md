# Backlog mechanisms: one page

Everything that decides when work runs, how agents coordinate, and how merges stay safe. Each entry says what it
does, how to drive it, and when it applies. **Repo** means it ships in `bl`. **Local** means a helper script on one
machine (`~/.backlog/bin`), recorded here so it isn't forgotten. The detail is in [design.md](design.md).

## Running work

| Mechanism | What it does | Drive it | Applies |
|---|---|---|---|
| **Simple mode** (repo) | The daemon runs one `claude -p` worker per ready ticket, with no orchestrator session. This is the recommended mode. | `bl project set P executor=daemon`. Switching to Simple stops any running orchestrator. | All projects |
| **Caps** (repo) | At most `global_max_parallel` tickets in flight, `daemon_max_parallel` of them from the daemon, plus an optional per-project `max_parallel`. | `bl config global …` | Always |
| **Pause stops now** (repo) | Pausing (or `plan`, `archive`) kills the project's orchestrators, workers and their dev servers, and puts their tickets back to todo without using an attempt. chito asks first. | `bl project pause P` (`--soft` lets running work finish) | All projects |
| **Resume, don't restart** (repo) | A re-claimed ticket resumes its previous Claude session (`claude --resume`) in the same worktree, so it keeps everything it knew. | Automatic | Claude harness |
| **Daemon self-reload** (repo) | When `bl` changes on disk, the daemon re-executes in place and adopts its running workers. Nothing is stopped or drained. | Automatic on merge | Always |
| **Usage-limit pause** (repo) | A worker that hits a quota hands its ticket back without using an attempt. Claims pause until the reset, then resume with one probe worker. | `bl quota`, `bl quota clear` | Always |

## Coordination

| Mechanism | What it does | Drive it | Applies |
|---|---|---|---|
| **Worker system prompt** (repo) | Teaches every worker the `bl` commands for seeing the project and coordinating. | Automatic | All workers |
| **Project area** (repo) | Memory (facts and decisions), messages (shown for 7 days) and what each running ticket is touching. It is in every worker prompt, and in chito on the project page. | `bl area`, `bl memo`, `bl say`, `bl touching`, `bl forget` | All projects |
| **Standing instructions** (repo) | Rules for how to work in one project. Every prompt includes them. | `bl instructions P --set …` | Per project |
| **Human tickets and handoffs** (repo) | A briefing session prepares a handoff packet (TL;DR, pictures, asks); the human answers by resuming it. | `--assignee human`, `bl handoff`, `bl resolve` | Human steps |
| **Milestones and showcases** (repo) | A showcase ticket produces screenshots, a demo or a link; the human accepts or reopens it. | `bl milestone …` | Per project |

## Merging safely (self-merge only)

These apply where agents merge their own PRs (review `self`). Where a human merges (`pr` or `ask`), the worker stops
at `in_review` and none of this is involved.

| Mechanism | What it does | Drive it | Applies |
|---|---|---|---|
| **Merge order guard** (repo) | The PreToolUse hook denies `gh pr merge`, and `bl done` refuses, while any of the ticket's blockers is unfinished. | Automatic (`bl hook pre-tool`) | Self-merge |
| **Speculation, stacked branches** (repo) | A worker runs `bl stage` once its PR is open and before its final tests. Tickets waiting on it then start on its branch instead of on main. They merge in order after it lands. Never for deploys, showcases or tickets with `meta.speculate=false`. | `bl config project:P speculate true`, `bl stage KEY --branch B --pr URL` | Serial chains, opt-in |
| **Parking, a merge queue** (repo) | A worker whose PR is ready but can't merge yet (blockers unfinished, or main red) parks the ticket. Its slot frees and it stays out of the queue. Once what it waits for has happened, the daemon resumes the same session to rebase, re-test and merge. A staged branch stays staged while parked. | `bl park KEY --pr URL [--until blockers\|main\|both]` | Self-merge |
| **Main health** (repo + local) | A job tests main after merges. A regression (a suite that passed before, failing twice) sets `bl main red` and files an MC-OPS fix ticket. Workers then see a "MAIN IS RED" banner, and the hook plus a `pre-rebase` git hook block merging into and rebasing onto main, except for the fix ticket. | `bl main [status\|wait\|red\|green]`; local `~/.backlog/bin/main-health.sh` (launchd `com.backlog.main-health`) | Self-merge repos |
| **Scoped tests** (instructions) | Before merging, workers run health, lint, their touched unit files, their e2e suites and smoke. The full suite runs on main (main health) and at deploy. | Standing instructions and the repo's CLAUDE.md | mapcouch |

## Machine capacity (local)

| Mechanism | What it does | Where |
|---|---|---|
| **Test gate** | A `node` wrapper that, inside a backlog worker, limits concurrent unit runs (`unit.max`, `unit.conc` processes each) and e2e suites (`e2e.max`, each with its own port range) across the machine. Plain node everywhere else. | `~/.local/bin/node` → `~/.backlog/bin/node-gate`; limits in `~/.backlog/slots/` |
| **Capacity watchdog** | Adjusts the worker cap (4–20) and e2e slots from CPU, memory and swap. Under pressure it soft-pauses lower-priority projects first and resumes them after 10 calm minutes. Reopens failed tickets once, and returns stale `in_review` tickets to todo. It never kills a running worker. | `~/.backlog/bin/watchdog.sh`, log `~/.backlog/logs/watchdog.log` |
| **Speculation monitor** | Stages a running ticket when its branch is pushed, if its worker didn't. Logs the overlap report. Uses git only, never the GitHub API. | `~/.backlog/bin/spec-monitor.sh`, `spec-report.py` |

## Watching it

- **chito**: Projects (Overview, Projects, Tickets, Factory), a ticket's side panel, and the project page (project
  area, roadmap, graph, tickets).
- `bl status`, `bl daemon status`, `bl main`, `bl area P`, `bl log P`.
