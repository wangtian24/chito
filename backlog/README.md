# Backlog

A local ticket DAG that Claude Code sessions and background agents share as their source of truth. `bl` is the CLI, orchestrator and daemon; chito's `/projects` page is the board. See [docs/design.md](docs/design.md).

Install everything (chito + backlog) with `scripts/install.sh` at the repo root, or only the backlog with:

```bash
backlog/install.sh            # bl wrapper in ~/.local/bin, skill symlinks, hooks, daemon (macOS launchd); --no-daemon / --no-hooks
bl project add Q "Chores" --executor daemon --evergreen --review self   # modes: session (SO), auto (DSO), daemon (DQ)
bl add Q "Rename the old screenshots" --model sonnet
bl project start Q            # the daemon picks it up
bl status                     # or open http://localhost:8791/projects
```

| Path | What |
|---|---|
| `bin/bl` | CLI, `bl run` orchestrator, `bl daemon` (stdlib Python 3.11+, SQLite 3.35+) |
| `skills/backlog` | `/backlog`: master triage for anything backlog |
| `skills/backlog-run` | `/backlog-run`: execute a session project (inline, subagents, or orchestrator) |
| `skills/backlog-worker` | The contract for one worker on one ticket |
| `docs/design.md` | Data model, lifecycles, executors, daemon, board |
| `install.sh` | Idempotent installer |

Data lives in `~/.backlog` (`BL_HOME`): `backlog.db`, `logs/`, `work/`. Put machine-specific conventions (where design docs go, per-repo review policy, how to notify) in `~/.backlog/LOCAL.md`; the skills read it first.

Workers default to Claude. In Chito, choose a harness and model together from one dropdown. The CLI accepts both settings in one command, for example `bl config PROJ harness codex model gpt-6.1-sol`. Pi needs a `provider/model` name, such as `together/moonshotai/Kimi-K3.1-Pro`; Codex can use its CLI default with an empty project model. A ticket can override both via `bl set KEY harness=pi model=together/moonshotai/Kimi-K3.1-Pro`. Changes affect new workers. Auto projects using Pi or Codex use a daemon-started `bl run` coordinator; Claude keeps its orchestrator sessions. Saved Pi credentials work for the daemon; environment keys can be stored in `~/.backlog/credentials.env` (`chmod 600`).

Testing: point `BL_HOME` and `BL_DB` at a scratch directory, and set `worker_cmd` to a fake worker script.
