# chito

A fast local web UI for your Claude Code sessions: a session list on the left, the conversation on the right, a permalink for every session and message, and one key to reopen a session in your terminal. It also ships **backlog**, a local ticket DAG plus a background daemon that lets many Claude Code sessions and agents work through long-horizon projects together, with a board in chito.

## Install

```bash
git clone https://github.com/wangtian24/chito && cd chito
scripts/install.sh       # chito + backlog CLI, skills, hooks and daemon
```

That's everything on macOS. The script is idempotent; re-run it after `git pull`. Options:
- `--no-backlog`: chito only.
- `--no-daemon`: backlog without the background daemon.
- `--no-launchagent`: don't start chito at login; run `npm start` yourself.

Requirements:
- **Node 22.5+.** The Backlog view uses `node:sqlite`; Sessions and Artifacts work on Node 20.
- **python3 3.11+ with SQLite 3.35+**, for `bl`.
- **The `claude` CLI**, for backlog workers.
- **`gh`** (optional), for live PR state.

Just chito, by hand:

```bash
npm install
npm start                          # http://localhost:8791
scripts/install-launchagent.sh     # start at login; CHITO_NODE=/path/to/node CHITO_PORT=8791 to override
```

## What it does

- Reads `~/.claude/projects/*/*.jsonl`. Metadata is cached by mtime in `~/.cache/chito/`, so only changed transcripts are re-parsed. A cold index of about 1,000 sessions (780 MB) takes about 1.3 s; after that it takes about 10 ms.
- Titles come from `/rename` (`custom-title`), then the AI title, then the first prompt.
- Search ranks title matches first, then project and first prompt. `p:myapp` filters by project. The query is kept in the URL (`/?q=...`).
- The chat view renders Markdown, collapsible tool calls (input and result loaded when expanded), thinking, images, compaction dividers, background-task notes and PR links.
- **Details** (`i`) shows start time, last turn time, duration, name, ID, directory, branch, prompt, reply and tool counts, models, tokens, top tools, PRs, CLI version and transcript path.
- **Open in terminal** (`o`) opens iTerm (or Terminal.app) with
  `cd <cwd> && claude --resume <id> --allow-dangerously-skip-permissions`.
- Permalinks: `http://localhost:8791/s/<session-id>`, plus `#<message-uuid>` for a single message (hover a message and click `#`).
- Headless agent sessions (cwd outside `$HOME`) are hidden by default; toggle them with `a`.

## Look

Settings (`,` or the gear) has four tabs: Appearance, Conversation, Keyboard and About. Appearance offers six sans-serif presets, three light (Slate, the default; Ink; Sage) and three dark (Console, Midnight, Plum). Your choice is remembered per browser, and `?theme=<name>` overrides it. Palettes and type pairings start from [Hallmark](https://github.com/nutlope/hallmark) themes.

## Artifacts: pull requests

**Artifacts** (above the session list, or `P`) collects every PR opened in any session. Live state comes from GitHub through your local `gh` CLI (`gh auth login` once); no app or token setup. Each row shows the state (open, draft, merged, closed), repo, number, title, author, branch, diff size, checks, review and the sessions it came from. Open PRs stay until you dismiss them. Merged ones stay for 24 hours. Dismissed PRs move to their own tab and can be restored. Search matches title, number or repo; long lists page in 15s. State is cached: open PRs refresh every minute, merged ones far less often.

## Backlog: tickets, DAGs and a daemon for agents

A long-horizon task becomes a **project**: tickets, each roughly one PR, with dependencies between them, all in one SQLite file (`~/.backlog/backlog.db`). Claude Code sessions and background agents share that file as the source of truth. They claim ready tickets atomically, work them, and report back with `bl done` / `bl fail`, so the next agent sees what was delivered. You add tasks and step in only where a human is needed: reviews, answers, deploys, failed tickets and milestone demos.

**Pieces** (all in [`backlog/`](backlog/README.md); design in [`backlog/docs/design.md`](backlog/docs/design.md)):
- **`bl`**: the CLI, and the only writer of the database. It covers tickets, dependencies, claims with leases, the `bl run` orchestrator and the `bl daemon`.
- **Skills:**
  - `/backlog`: the entry point for anything backlog (plan, add, status, triage, groom, configure).
  - `/backlog-run`: run a project.
  - `backlog-worker`: the contract every worker follows.
- **Hooks:** they put the ticket back into a worker's context after compaction, stop a worker from ending before it reports, and keep its claims alive.
- **The daemon:** a LaunchAgent that moves projects forward without anyone watching.

**Three ways a project runs** (its mode):

| Mode | What happens |
|---|---|
| **SO**: session orchestrator | You start `/backlog-run PROJ` in a session; it runs the DAG until done. If that session dies, the daemon adopts the project. |
| **DSO**: daemon session orchestrator | The daemon starts an orchestrator session whenever tickets are ready, and another when more arrive. |
| **DQ**: daemon queue | One `claude -p` per ready ticket. Nothing coordinates them; meant for independent tasks. |

**Other features:**
- **Lifecycle:** projects start in `planning`, and nothing runs until `bl project start`.
- **Milestones:** each has a showcase (screenshots, a demo, localhost, a link) that you accept.
- **Usage limits:** they pause every claim until the reset; the daemon resumes on its own, with one probe worker first.
- **Caps:** at most 6 tickets in flight across everything; adjustable.
- **Per-ticket usage:** turns, tokens and nominal cost, read from the transcripts.

**The board** (`B`, `/backlog`):
- the daemon's status, with pause and resume, and a usage-limit banner;
- every ticket in flight, with who runs it and a link to its session;
- a swim lane per project, collapsible to one compact row;
- per project: the roadmap with showcases, a dependency graph (click to expand), and a tree table of tickets with PRs and cost;
- a side panel per ticket, with its spec, result, sessions and activity.

Controls (start, pause, mode, evergreen, reopen, approve, cancel, priority, model, milestone) run `bl` on the server from a fixed allowlist.

**Quick start**, from any Claude Code session:

```text
/backlog plan <the thing you want built> for <repo>     # writes tickets + deps, shows the graph, project stays in planning
/backlog start it in DSO                                # the daemon takes it from here
```

or by hand:

```bash
bl project add Q "Chores" --executor daemon --evergreen --review self   # DQ: a standing queue
bl add Q "Rename the old screenshots" --model sonnet
bl project start Q
bl status
```

Machine-specific conventions go in `~/.backlog/LOCAL.md`, which the skills read first: where design docs live, which repos may self-merge (`review self`) and which need PR review, and how to notify you.

## Setting it up with an AI agent

If you're an AI agent asked to install chito and the backlog on this machine, do the following, in order, and check each result.

1. **Check prerequisites.**
   - `node -v`: needs 22.5+. If it's older, install `node@22` (Homebrew: `brew install node@22`) and pass `CHITO_NODE=$(brew --prefix node@22)/bin/node`.
   - `python3 -c 'import sys,sqlite3;print(sys.version_info[:2], sqlite3.sqlite_version)'`: needs 3.11+ and SQLite 3.35+. Otherwise install a newer python3 and pass `BL_PYTHON=/path/to/python3`.
   - `command -v claude`: the backlog workers need it.
   - `command -v gh`: optional.
2. **Install.** From the repo root, run `scripts/install.sh`. This:
   - runs `npm install` and installs the `com.chito.server` LaunchAgent;
   - writes `~/.local/bin/bl`, a wrapper that pins the checked python;
   - symlinks `~/.claude/skills/{backlog,backlog-run,backlog-worker}` to the repo;
   - merges three hooks into `~/.claude/settings.json` (SessionStart, Stop, PostToolUse → `bl hook …`), leaving any other hooks alone;
   - creates `~/.backlog/backlog.db`;
   - installs the `com.chito.backlog-daemon` LaunchAgent.

   It only touches those paths. An existing non-symlink skill with the same name is moved to `~/.backlog/skill-backups/`.
3. **Make sure `~/.local/bin` is on PATH** for both the shell and Claude Code. Without it, `bl` won't resolve in sessions.
4. **Verify.**
   - `bl status`: the first line should read `daemon: running`.
   - `curl -s localhost:8791/api/backlog | head -c 80`: should contain `"available":true`.
   - Open http://localhost:8791/backlog.
   - In a new Claude Code session, `/backlog` should load.
5. **Smoke test (optional; spends a few cents).** Create a DQ project with a tiny ticket, and archive it afterwards:

   ```bash
   bl project add SMOKE "Smoke" --executor daemon --review self
   bl add SMOKE "Create hello.txt containing hi" --model sonnet
   bl project start SMOKE
   # wait about 30 s
   bl ls SMOKE --all
   bl project archive SMOKE
   ```

   The ticket should be `done`, with its output in `~/.backlog/work/SMOKE-1/`.
6. **Personalize.** Ask the user where design docs should go and which repos may self-merge, then write those answers to `~/.backlog/LOCAL.md`. Set review policies with `bl config PROJ review self|pr|ask`.

**Updating:** `git pull && scripts/install.sh`. Then restart with:

```bash
launchctl kickstart -k gui/$(id -u)/com.chito.server
launchctl kickstart -k gui/$(id -u)/com.chito.backlog-daemon
```

**Removing:**
- `bl daemon uninstall`
- `launchctl bootout gui/$(id -u)/com.chito.server`
- delete `~/.local/bin/bl` and the three skill symlinks
- remove the `bl hook` entries from `~/.claude/settings.json`

The data in `~/.backlog` stays until you delete it.

## Sessions list

Sessions from the last 48 hours show first; scroll to the bottom (or click the divider) for older ones. Search always covers everything. **Pin** a session with the pin button in the header (`f`) or by dragging it into the Pinned area at the top; drag to reorder, or drag out to unpin. Pins are stored per browser.

## Work and answers

Each turn's final run of text is the answer; everything before it (interim notes, thinking, tool calls) is work. With work hidden (`w`, on by default), a turn shows one line, such as *Worked 6m: 5 notes, 15 tool calls*, followed by the answer. Click the line to open one turn. A turn still in flight keeps its work visible until the answer lands.

## Keys

| Key | Action |
| --- | --- |
| `/`, `⌘K` | search (`↑↓` + `↵` inside the search box) |
| `j` `k`, `↵` | move through the list, open |
| `o` | reopen in terminal, or focus its iTerm window/tab/pane if already running |
| `r` | write a message (typed into the live session, or resumes it in a new window) |
| `↑` `↓` `PgUp` `PgDn` | scroll conversation |
| `c` / `y` | copy resume command / permalink |
| `i` | details panel |
| `w` | hide or show the work (notes, thinking, tools) before each turn's answer |
| `t` | cycle tool calls: hidden → counts → detailed |
| `n` `p` | next / previous prompt |
| `g` `G`, `space` | top / bottom, page |
| `a` | show / hide agent sessions |
| `[` | collapse sidebar |
| `P` | Artifacts (pull requests) or back to sessions |
| `B` | Backlog or back to sessions |
| `f` | Pin or unpin this session |
| `,` | settings |
| `?` | keyboard shortcuts |

## Config (env)

| Var | Default |
| --- | --- |
| `CHITO_PORT` | `8791` |
| `CHITO_HOST` | `127.0.0.1` |
| `CHITO_PROJECTS_DIR` | `~/.claude/projects` |
| `CHITO_TERMINAL` | `iterm` if installed, else `terminal` |
| `CHITO_BACKLOG_DB` | `$BL_DB`, else `~/.backlog/backlog.db` |
| `CHITO_BL` | `bl` (path to the backlog CLI used by the board's controls) |
| `CHITO_ARTI_BASE` | unset (base URL used to link `doc_slug` design docs) |

| `CHITO_CLAUDE_FLAGS` | `--allow-dangerously-skip-permissions` |

`~/.config/chito/config.json` can also set `blPath`, `artiBase` and `prices` (per-model $/M tokens for the nominal cost figures).

Backlog settings live in its database: `bl config global` lists them, and `bl config PROJ key value` changes one. The ones you're most likely to touch:
- `global_max_parallel` (6)
- `daemon_max_parallel` (6)
- `max_parallel` (3 per project)
- `model` (opus)
- `review` (ask)
- `orphan_policy` (adopt)
- `quota_backoff_minutes` (30)

## Security

chito binds to 127.0.0.1 and rejects requests whose `Host` is not localhost, which blocks DNS rebinding. The open-in-terminal endpoint requires a POST with a custom header, so other sites can't trigger it, and it accepts only a session ID; the command is built on the server from the transcript's own cwd. The backlog controls use the same POST-plus-header rule and map a fixed allowlist of actions to `bl` arguments (keys are validated; nothing goes through a shell). Showcase files are served only from `~/.backlog/showcase/`.

Backlog workers run `claude -p` with `--permission-mode bypassPermissions` in a git worktree per ticket. The `backlog-worker` skill forbids deploys, spending and pushing to main unless a ticket says so, but treat the daemon like any unattended agent. Keep `review pr` on repos where that matters, and pause it with `bl daemon pause`.

## License

MIT. See [LICENSE](LICENSE).
