# Backlog

A local ticket DAG that Claude Code sessions and background agents share as their source of truth. `bl` is the CLI, orchestrator and daemon; chito's `/backlog` page is the board. See [docs/design.md](docs/design.md).

```bash
backlog/install.sh            # symlinks bl + skills, adds hooks, installs the daemon (macOS launchd)
bl project add Q "Chores" --executor daemon --evergreen --review self
bl add Q "Rename the old screenshots" --model sonnet
bl project start Q            # the daemon picks it up
bl status                     # or open http://localhost:8791/backlog
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

Testing: point `BL_HOME` and `BL_DB` at a scratch directory, and set `worker_cmd` to a fake worker script.
