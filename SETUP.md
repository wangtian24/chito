# Setting up chito (for AI agents)

You are an AI agent and a person asked you to install chito, maybe with a link to this file. Follow these steps in
order. Each one says how to tell that it worked. Everything here is idempotent, so it is safe to run again.
Stop and ask the person only where a step says **Ask**.

chito is a local web UI for Claude Code, Codex and Pi sessions, plus **backlog** (`bl`), a ticket DAG with a
background daemon that runs agent workers. It runs on this Mac only: it reads transcripts from disk and serves
http://localhost:8791. Nothing is sent anywhere.

## 1. Get the code

```bash
git clone https://github.com/wangtian24/chito ~/chito 2>/dev/null || git -C ~/chito pull --ff-only
cd ~/chito
```

If the person already has a checkout somewhere else, use that one instead of cloning a second copy.

## 2. Check the machine

```bash
scripts/doctor.sh --pre
```

Each line is `PASS`, `WARN` or `FAIL`, and every `FAIL` and `WARN` names its fix. Fix each `FAIL`, then run the
check again until it passes.

- **Node 22.5+.** If it's older: `brew install node@22`, then pass `CHITO_NODE=$(brew --prefix node@22)/bin/node`
  to the install command below.
- **python3 3.11+ with SQLite 3.35+**, for `bl`. If it's older: `brew install python`, then pass
  `BL_PYTHON=$(brew --prefix)/bin/python3`.
- `WARN`s are optional. Without the `claude` CLI, chito still browses transcripts but backlog workers can't start.
  Without `gh` (signed in), PRs show without live GitHub state.

**Ask** before installing Homebrew packages if the person hasn't said you may.

## 3. Install

**Ask** which of these they want, unless they already said. Default to everything.

```bash
scripts/install.sh                    # chito, backlog CLI, skills, hooks, daemon (recommended)
scripts/install.sh --no-backlog       # chito only: browse sessions and PRs
scripts/install.sh --no-daemon        # backlog without the background daemon
scripts/install.sh --no-launchagent   # don't start chito at login (run npm start yourself)
```

The full install touches only these paths:

- `npm install` in the checkout, and a LaunchAgent `com.chito.server` that starts chito at login.
- `~/.local/bin/bl`: a wrapper that pins the python checked above.
- `~/.claude/skills/{backlog,backlog-run,backlog-worker}`: symlinks into the checkout. An existing skill with the
  same name that is not a symlink is moved to `~/.backlog/skill-backups/`.
- `~/.claude/settings.json`: adds the `bl hook` entries (SessionStart, Stop, PostToolUse, PreToolUse on Bash) and
  leaves every other setting and hook alone.
- `~/.backlog/`: the database, logs and worktrees, plus a LaunchAgent `com.chito.backlog-daemon`.

Make sure `~/.local/bin` is on PATH, both in the shell profile and for Claude Code. Otherwise `bl` won't resolve
inside sessions.

## 4. Verify

```bash
scripts/doctor.sh
```

Everything should be `PASS`. Then open http://localhost:8791 (it lands on Projects; Sessions shows the transcripts).
In a new Claude Code session, `/backlog` should load the backlog skill.

## 5. Smoke test (optional; spends a few cents)

**Ask** first: this runs a real Claude worker.

```bash
bl project add SMOKE "Smoke" --executor daemon --review self
bl add SMOKE "Create hello.txt containing hi" --model sonnet
bl project start SMOKE
sleep 45; bl ls SMOKE --all      # SMOKE-1 should be done
bl project archive SMOKE
```

## 6. Personalize

**Ask** these questions, then write the answers to `~/.backlog/LOCAL.md`. Every backlog session reads that file.

- Where should design docs and reports go (a folder, a docs tool, a wiki)?
- Which repos may agents merge on their own after testing (`bl config project:KEY review self`), and which need a
  human to merge (`review pr`)?
- How many workers may run at once on this machine? The default is 6: `bl config global global_max_parallel N`.

Tell the person the URL (http://localhost:8791) and that `/backlog` in Claude Code is where to start.

## Updating and removing

- **Update:** `git -C ~/chito pull && ~/chito/scripts/install.sh`. The daemon reloads itself when `bl` changes, and
  it keeps running workers. Restart chito with `launchctl kickstart -k gui/$(id -u)/com.chito.server`.
- **Remove:**
  1. `bl daemon uninstall`
  2. `launchctl bootout gui/$(id -u)/com.chito.server`
  3. Delete `~/.local/bin/bl` and the three skill symlinks.
  4. Remove the `bl hook` entries from `~/.claude/settings.json`.

  `~/.backlog` holds the person's tickets. Leave it unless they ask you to delete it.
