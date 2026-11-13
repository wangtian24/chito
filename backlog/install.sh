#!/usr/bin/env bash
# Install the backlog: symlink bl and the skills, register Claude Code hooks, and start the daemon.
# Idempotent. Options: --no-daemon, --no-hooks.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
BL_HOME="${BL_HOME:-$HOME/.backlog}"
DAEMON=1; HOOKS=1
for a in "$@"; do case "$a" in --no-daemon) DAEMON=0 ;; --no-hooks) HOOKS=0 ;; esac; done

# A python3 >= 3.11 with SQLite >= 3.35 (RETURNING, json_each). Override with BL_PYTHON=/path/to/python3.
pick_python() {
  for c in "${BL_PYTHON:-}" /opt/homebrew/bin/python3 /usr/local/bin/python3 "$(command -v python3 || true)" /usr/bin/python3; do
    [ -n "$c" ] && [ -x "$c" ] && "$c" -c 'import sys, sqlite3; sys.exit(0 if sys.version_info >= (3, 11) and sqlite3.sqlite_version_info >= (3, 35) else 1)' 2>/dev/null && { echo "$c"; return; }
  done
}
PY="$(pick_python)"
[ -n "$PY" ] || { echo "backlog: need python3 >= 3.11 with SQLite >= 3.35 (set BL_PYTHON)" >&2; exit 1; }

mkdir -p "$HOME/.local/bin" "$HOME/.claude/skills" "$BL_HOME"
# A wrapper rather than a symlink, so hooks and the daemon always use the python checked above.
rm -f "$HOME/.local/bin/bl"
printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$PY" "$DIR/bin/bl" > "$HOME/.local/bin/bl"
chmod +x "$HOME/.local/bin/bl"
for s in backlog backlog-run backlog-worker; do
  target="$HOME/.claude/skills/$s"
  # move a real (non-symlink) copy aside, outside the skills dir so it isn't loaded twice
  if [ -e "$target" ] && [ ! -L "$target" ]; then mkdir -p "$BL_HOME/skill-backups"; mv "$target" "$BL_HOME/skill-backups/$s.$(date +%s)"; fi
  ln -sfn "$DIR/skills/$s" "$target"
done
"$HOME/.local/bin/bl" init >/dev/null

if [ "$HOOKS" = 1 ]; then
  python3 - "$HOME/.local/bin/bl" <<'PY'
import json, os, sys
bl = sys.argv[1]
p = os.path.expanduser("~/.claude/settings.json")
d = json.load(open(p)) if os.path.exists(p) else {}
h = d.setdefault("hooks", {})
for ev, sub in (("SessionStart", "session-start"), ("Stop", "stop"), ("PostToolUse", "beat")):
    groups = [g for g in h.get(ev, []) if not any(" hook " in x.get("command", "") and x.get("command", "").split()[0].endswith("/bl") for x in g.get("hooks", []))]
    groups.append({"hooks": [{"type": "command", "command": f"{bl} hook {sub}", "timeout": 5}]})
    h[ev] = groups
json.dump(d, open(p, "w"), indent=2)
print("hooks registered in", p)
PY
fi

if [ "$DAEMON" = 1 ] && [ "$(uname)" = Darwin ]; then "$PY" "$DIR/bin/bl" daemon install; fi
echo "bl -> $PY $DIR/bin/bl (wrapper in ~/.local/bin/bl); data in $BL_HOME"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "note: add ~/.local/bin to PATH so \`bl\` resolves (Claude Code sessions need it too)";; esac
