# cito

A fast local web UI for browsing your Claude Code sessions: a session list on the left, the conversation on the right, a permalink for every session and message, and one key to reopen a session in your terminal.

## Run

```bash
npm install
npm start            # http://localhost:8791
```

To keep it running at login (macOS LaunchAgent):

```bash
scripts/install-launchagent.sh     # CITO_NODE=/path/to/node CITO_PORT=8791 to override
```

## What it does

- Reads `~/.claude/projects/*/*.jsonl`. Metadata is cached by mtime in `~/.cache/cito/`, so only changed transcripts are re-parsed. A cold index of about 1,000 sessions (780 MB) takes about 1.3 s; after that it takes about 10 ms.
- Titles come from `/rename` (`custom-title`), then the AI title, then the first prompt.
- Search ranks title matches first, then project and first prompt. `p:myapp` filters by project. The query is kept in the URL (`/?q=...`).
- The chat view renders Markdown, collapsible tool calls (input and result loaded when expanded), thinking, images, compaction dividers, background-task notes and PR links.
- **Details** (`i`) shows start time, last turn time, duration, name, ID, directory, branch, prompt, reply and tool counts, models, tokens, top tools, PRs, CLI version and transcript path.
- **Open in terminal** (`o`) opens iTerm (or Terminal.app) with
  `cd <cwd> && claude --resume <id> --allow-dangerously-skip-permissions`.
- Permalinks: `http://localhost:8791/s/<session-id>`, plus `#<message-uuid>` for a single message (hover a message and click `#`).
- Headless agent sessions (cwd outside `$HOME`) are hidden by default; toggle them with `a`.

## Look

Nine themes, picked at the bottom of the sidebar and remembered per browser (`?theme=<name>` overrides). Each re-derives its tokens for dark mode. All but Almanac are sans-serif throughout.

| Theme | Feel |
| --- | --- |
| Slate (default) | slate and magenta, Hanken Grotesk |
| Console | graphite and amber, Host Grotesk |
| Ink | white paper and teal, Epilogue, pill controls |
| Mint | warm paper and green, Schibsted Grotesk and Instrument Sans |
| Cobalt | cool white and electric blue, Familjen Grotesk and Plex Sans |
| Midnight | deep blue and ice, Mona Sans |
| Violet | lavender and violet, Outfit and Onest |
| Rim | warm black and burnt orange, Geist |
| Almanac | serif reading pane, ruled index |

Palettes and type pairings start from [Hallmark](https://github.com/nutlope/hallmark) themes. System lines (work summaries, tool counts, notes) get their own cool tone in every theme.

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
| `?` | help |

## Config (env)

| Var | Default |
| --- | --- |
| `CITO_PORT` | `8791` |
| `CITO_HOST` | `127.0.0.1` |
| `CITO_PROJECTS_DIR` | `~/.claude/projects` |
| `CITO_TERMINAL` | `iterm` if installed, else `terminal` |
| `CITO_CLAUDE_FLAGS` | `--allow-dangerously-skip-permissions` |

## Security

cito binds to 127.0.0.1 and rejects requests whose `Host` is not localhost, which blocks DNS rebinding. The open-in-terminal endpoint requires a POST with a custom header, so other sites can't trigger it, and it accepts only a session ID; the command is built on the server from the transcript's own cwd.
