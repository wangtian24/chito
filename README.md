# chito

A fast local web UI for browsing your Claude Code sessions: a session list on the left, the conversation on the right, a permalink for every session and message, and one key to reopen a session in your terminal.

## Run

```bash
npm install
npm start            # http://localhost:8791
```

To keep it running at login (macOS LaunchAgent):

```bash
scripts/install-launchagent.sh     # CHITO_NODE=/path/to/node CHITO_PORT=8791 to override
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

**Backlog** (`B`) is the board for a local ticket DAG that many Claude Code sessions and background agents share: projects with a planning → executing lifecycle, tickets with dependencies, and a daemon that drains queue-style projects by starting `claude -p` workers. The overview shows the daemon (with pause/resume), every ticket **in flight** with who is running it (daemon, orchestrator or session) and a link to its session, and a swim lane per project. A project page shows the dependency graph and a sortable ticket table; a ticket drawer shows the spec, result, sessions and activity. Controls (start, pause, executor, evergreen, reopen, approve, cancel, priority, model) run `bl` on the server from a fixed allowlist. The CLI, the skills and the design live in [`backlog/`](backlog/README.md); install with `backlog/install.sh`.

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

`~/.config/chito/config.json` can also set `blPath` and `artiBase`.
| `CHITO_CLAUDE_FLAGS` | `--allow-dangerously-skip-permissions` |

## Security

chito binds to 127.0.0.1 and rejects requests whose `Host` is not localhost, which blocks DNS rebinding. The open-in-terminal endpoint requires a POST with a custom header, so other sites can't trigger it, and it accepts only a session ID; the command is built on the server from the transcript's own cwd.

## License

MIT. See [LICENSE](LICENSE).
