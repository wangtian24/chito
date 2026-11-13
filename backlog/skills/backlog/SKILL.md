---
name: backlog
description: Master entry point for everything about the local backlog (SQLite at ~/.backlog/backlog.db, CLI `bl`, board in chito at /backlog) — projects with a planning/executing lifecycle, Linear-like tickets, a dependency DAG, a background daemon, and the shared source of truth that many Claude Code sessions and agents coordinate through on long-horizon work. Use for ANY backlog-related ask: /backlog with or without arguments, "add a ticket", "put this in the backlog / queue", "break X into tickets", "plan this project", "start / pause the project", "what's next", "status", "what's running", "what's stuck / waiting on me", "triage", "groom the backlog", "show the graph/board", "run/execute/drain the backlog", "stop the run", "pause the daemon", "retry/cancel/approve KEY", "change parallelism / review policy / model", "export the board", or questions about how the backlog works. Routes execution to backlog-run and per-ticket work to backlog-worker.
---

# /backlog: the master skill for anything backlog

Work out which kind of request this is, then act. `bl` is the only thing that writes to the database; use `--json` when you need to parse output. Board: chito at `/backlog` (swim lanes, in-flight tickets, project pages, a ticket drawer, and controls). Design: `backlog/docs/design.md` in the chito repo.

**Local conventions first:** if `~/.backlog/LOCAL.md` exists, read it before acting. It holds this machine's rules: where design docs live, review policies per repo, how to notify, and which memory skills to use. Where it disagrees with this skill, follow it.

## Model
- **Project lifecycle**: `planning` (the default for new projects; nothing runs) → `executing` → `done` (set automatically when every ticket is final, unless the project is evergreen), plus `paused` and `archived`. Adding a ticket to a done project sets it back to executing. Commands: `bl project start|pause|resume|plan|archive KEY`.
- **Mode** (the project's `executor` field; a ticket can override it):
  - **SO** (`session`, the default): you start `/backlog-run`. If that session dies or stalls with ready tickets, the daemon adopts the project with an orchestrator session after 10 quiet minutes.
  - **DSO** (`auto`): the daemon starts an orchestrator session whenever tickets are ready, and another when more arrive. Hands-off for DAG work.
  - **DQ** (`daemon`): a queue. The daemon runs one `claude -p` per ready ticket with no coordinator; for independent tickets.
  SO and DSO are "orchestrated"; DQ is "queue".
- **Milestones**: an ordered roadmap per project. Each milestone is reached when its tickets are done (`all`), at a deploy ticket (`deploy`), or by hand. A showcase ticket then produces screenshots, a demo, a localhost URL or a link, and you accept it (`bl milestone …`).
- **Usage limits**: a worker that hits a quota puts its ticket back without using an attempt, and every claim pauses until the reset (`bl quota`, `bl quota clear`).
- **Human tickets** (`--assignee human`): once unblocked, the daemon prepares a **briefing session** with the context, how to see the work, and 1 to 3 questions. The user answers by resuming that session. The briefing records a **handoff packet** with `bl handoff KEY --packet -`: a summary, a Markdown body shaped to the ticket (a review, a decision or an errand only the human can do read differently), optional links and a tickable checklist, and 1 to 3 asks, each a pick-one with options or a free answer. That notifies the user and shows the packet in chito. If you're preparing a human ticket yourself, record one too. When the user answers: run `bl handoff KEY --phase discussing`, interview them, file fixes with `bl add … --blocks KEY`, record the decision with `bl comment`, and close with `bl resolve KEY -m "…"` (no claim needed). Write human tickets as questions with a clear decision ("go / no-go to merge X, after checking Y").
- **Evergreen**: the project never moves to done, so it stays a standing queue (`--evergreen`, or `bl project set KEY evergreen=1`).
- **Ticket states**: `backlog` (captured, not scheduled) → `todo` → `in_progress` → `in_review` → `done`, plus `canceled` and `failed`. Done and canceled unblock dependents; failed does not.
  - **Ready** means: the ticket is in todo, every blocker is done or canceled, it isn't assigned to `human`, and no lock it needs is held.
- **Caps**: at most `global_max_parallel` (6) tickets in flight across everything. The daemon may use up to `daemon_max_parallel` of those, and each project up to `max_parallel`.
- **Model**: workers run `opus` unless the ticket sets `model` (`--model sonnet` for simple work, or any model alias).

## 0. Triage the request

| The user says / wants | Intent | Go to |
|---|---|---|
| `/backlog` with no argument, "status", "where are we", "what's running" | **Status** | §1 |
| "what's stuck", "waiting on me", "triage", "anything failed?" | **Triage** | §2 |
| "add / file a ticket", "queue this", an idea worth tracking | **Capture** | §3 |
| "plan X", "break X into tickets", a big multi-step goal | **Plan** | §4 |
| "start / pause / resume / archive the project", "make it evergreen", "let the daemon run it", SO / DSO / DQ | **Lifecycle** | §5 |
| "add a milestone", "roadmap", "showcase", "demo", "accept M1" | **Milestones** | §5b |
| "groom", "reprioritize", "split / merge tickets", "fix the deps" | **Groom** | §6 |
| "run", "execute", "drain", "keep going until done", "stop the run" | **Run** | load **backlog-run** |
| "work on KEY", "do the next ticket yourself" | **Work one** | `bl claim PROJ KEY`, then load **backlog-worker** |
| "retry / cancel / approve / reopen KEY", priority, model | **Edit** | §7 |
| parallelism, review policy, model defaults, daemon on or off | **Configure** | §8 |
| "show the graph / board", "export" | **View** | §9 |
| "how does the backlog work", a bug in `bl` | **Explain / fix** | §10 |

If a request could mean two things, choose the less destructive: show rather than change, plan rather than run. Ask only when what you'd do depends on the answer, and at most once.
If no project is named, use the one the session is clearly about (the cwd's repo matching `projects.repo`, or the topic). Otherwise, if exactly one project is executing, use it. Otherwise show `bl status` and ask which.

## 1. Status
Run `bl status`. Its first line is the daemon: running or paused, how many workers, runs today, tickets in flight against the cap. Then one line per project with its state, executor, and whether it's evergreen or orphaned. Give the conclusion first, in at most about 6 lines:
- what's running, and who is running it (`bl daemon status` lists every in-flight ticket with its claimant)
- **what's waiting on the user**: failed tickets, in_review tickets, unblocked `human` tickets, and orphaned projects
- what's ready next
- progress
Point to chito `/backlog` for the visual board.

## 2. Triage
Go through the problem tickets one at a time, each with a one-line verdict and an action:
- **failed**: read `bl show KEY` (the last `FAIL:` comment and the result). Then either `bl reopen KEY`, fix the spec (`bl set KEY body=…`) and reopen, split the ticket, or `bl cancel KEY` (which unblocks its dependents).
- **in_review**: find the PR. If it's merged, run `bl approve KEY`. If it's open, drive it with your PR-review flow. If the review policy is `ask`, ask once whether this repo should be `self` or `pr`.
- **Stale leases**: `bl next PROJ` reaps them. **Orphaned projects**: offer `/backlog-run PROJ` to resume, or `bl config global orphan_policy daemon` so the daemon adopts orphans.
- **human tickets**: list exactly what the user must do.
- **Hazards in the graph**: todo tickets that depend on failed or backlog tickets; tickets with no body; a project still in `planning` that the user thinks is running.
Act straight away on the obvious ones (approve a merged PR, reap a stale lease). Propose the rest.

## 3. Capture
`bl add PROJ "Title" -b "Goal… Done when…" [--after …] [--state backlog] [--model sonnet] [--size s|m|l|xl]`. Mention it in one line ("Filed Q-12"). Don't ask first.
- For a **daemon** project, that's all: if the project is executing, the daemon picks the ticket up within seconds.
- If the project doesn't exist, create it with `bl project add KEY "Name" [--repo PATH] [--executor daemon|session] [--evergreen]`. Choose the executor (§5), ask the review policy once (§8), and remember the project starts in `planning`.

## 4. Plan (break work into a DAG)
1. Recall any history of the project. If the work is big, write or refresh a design doc first (where docs go is in LOCAL.md) and set `bl project set KEY doc_slug=…`. The ticket body holds *what* and *done-when*; the doc holds *why* and *how*.
2. One deliverable per ticket, about one PR's worth. The body has:
   - **Goal**: one or two lines
   - **Done when**: checks someone can verify
   - **Touches**: the files or areas involved
   - **Notes**: anything the worker needs to know
3. Add edges only for real dependencies (`--after`). Use `--lock NAME` for things that must not run at the same time. Give a size hint with `--size`. Use `--model sonnet` only for genuinely simple, mechanical tickets.
4. Anything only the user can do (deploys, spending money, signing in, decisions) gets `--assignee human`.
4b. **Deploy at milestones, not per ticket or per project.** Tickets merge to main and stop there; the repo's own cadence (scheduled deploys) ships merged work. Add a deploy ticket only as the gate of a milestone that has to be live (trigger `deploy`), one per milestone, assigned to `human` unless the user said otherwise. Never a "deploy X and write the recap" ticket at the end of every small project.
4c. Guidance the user gives for a whole project ("deploy only at milestones", "always add tests") goes in its standing instructions, `bl instructions PROJ --set "…"` (or the box on the chito project page). Every orchestrator run and worker prompt gets them, and a running orchestrator re-reads them each round.
5. Show `bl graph PROJ` and `bl run PROJ --dry-run`. The project stays in **planning**. End with "Start it?". Starting means `bl project start PROJ`, and then `/backlog-run` for session projects, or nothing more for daemon projects.

## 5. Lifecycle and executor
- `bl project start KEY` (planning → executing), `pause` (running work finishes, nothing new is claimed), `resume`, `plan` (back to planning to edit the graph), `archive`.
- **Choosing the mode**:
  - **DQ** (`daemon`) when the tickets are independent and self-contained: a queue of chores, batch processing, or standing work anyone can add to. Consider `--evergreen` too.
  - **DSO** (`auto`) for DAG work that should run without anyone starting it.
  - **SO** (`session`) when you want to watch and steer from a session (it is still adopted if the session dies).
  - A single independent ticket inside an orchestrated project can go to the queue with `bl set KEY executor=daemon`.
- Switching mode: `bl project set KEY executor=session|auto|daemon`, or the SO / DSO / DQ toggle in chito. Pause first if a session is mid-run.

## 5b. Milestones
- `bl milestone add PROJ "Title" [--trigger all|deploy|manual] [--gate DEPLOY_KEY] [--showcase screenshot|demo|localhost|link|none] [--due YYYY-MM-DD]`, then `bl add … --milestone PROJ-M1` or `bl set KEY milestone=PROJ-M1`.
- Plan milestones up front when the work has natural checkpoints. For example: "core works, shown as screenshots", then "live in prod" (trigger `deploy`, gated on the deploy ticket, shown as a link), then "polish".
- The showcase ticket is created for you. It waits on the milestone's work or the deploy gate, and its worker records the showcase with `bl milestone showcase M --file|--url|--note`.
- `bl milestone ls PROJ`, `bl milestone show M`. When a milestone is showcased, tell the user and point at chito's roadmap. They answer with `bl milestone accept M` or `bl milestone reopen M --note "…"`.
- Every one of these is also a button in chito (`/backlog`, and each project page).

## 6. Groom
- Reprioritize with `bl set KEY priority=N` (0 is urgent, 4 is none). Promote with `bl move KEY todo`, demote with `bl move KEY backlog`.
- To split: add the new tickets, move the dependency edges onto them (`bl dep add|rm`), then cancel the original. To merge: copy the content into one ticket and cancel the other.
- Fix the edges and check with `bl graph`. Fill in thin specs. For anything bigger than a couple of edits, show a before/after summary. Use `bl project plan KEY` first if workers might grab tickets while you're regrooming.

## 7. Edit a ticket
`bl reopen | cancel | approve KEY`, `bl move KEY STATE --reason …`, `bl set KEY field=value …` (title, body, priority, assignee, labels, locks, doc_slug, review, size, model, executor, meta.x), `bl comment KEY "…"`, `bl dep add|rm KEY BLOCKER`. Never change a ticket another agent holds (in_progress, `claimed_by` someone else) unless the user says so.

## 8. Configure
`bl config PROJ` shows the effective settings, and `bl config PROJ key value` sets one (`bl config global …` for global). Settings resolve from `label:x`, then `project:X`, then `global`.
- **Review policy** (`review`), roughly one PR per ticket:
  - `self`: the worker tests its own change and merges it, then the ticket goes to done.
  - `pr`: the worker stops at `in_review`; after the merge, run `bl approve`.
  - `ask` (the default): like `pr`, and flagged as needing the user.
  Set it per repo, and ask when you're unsure. A ticket can override it with `bl set KEY review=pr`.
- **Caps**: `global_max_parallel` (6), `daemon_max_parallel` (6), `max_parallel` (3 per project), `daemon_max_runs_per_day` (60).
- **Daemon**: `bl daemon status | pause | resume | install | uninstall`. Settings: `orphan_policy` (`adopt`, `daemon` or `wait`), `adopt_after_minutes` (10), `orchestrate_min_ready` (1), `orchestrator_model` (opus).
- **Usage limits**: `bl quota` (status), `bl quota clear`, `bl quota set MIN`; `quota_backoff_minutes` (30).
- **Other settings**: `model` (opus), `max_attempts` 2, `lease_minutes` 30, `worker_timeout_minutes` 120, `worktree` true, `on_stuck`, `notify_cmd` (a shell command using `$BL_MSG`), `worker_cmd`, `doc_hint`.

## 9. View
`bl graph PROJ [--mermaid]`, `bl ls PROJ --all`, `bl show KEY`, `bl log PROJ`, `bl daemon status`. The board is chito `/backlog`. For a shareable snapshot, run `bl export PROJ` (markdown plus mermaid) and publish it wherever LOCAL.md says.

## 10. Explain or fix
Hooks: `bl hook session-start | stop | beat` (installed by `backlog/install.sh`). When fixing `bl`, test against a scratch database (`BL_HOME=/tmp/x BL_DB=/tmp/x/t.db`), never the real one. Update `backlog/docs/design.md` if the behavior changes.

## Always
Give the conclusion first and keep it short. The backlog grants no new permissions: deploys, spending money and pushing to main stay with the user, unless a ticket says otherwise explicitly and isn't assigned to `human`.
