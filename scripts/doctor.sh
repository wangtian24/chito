#!/usr/bin/env bash
# Check that this machine can run chito and the backlog, or that an install worked.
# Each line is PASS, WARN or FAIL with the fix. Exit 1 if anything FAILs. Read-only: changes nothing.
#
#   scripts/doctor.sh --pre   # before installing: prerequisites only
#   scripts/doctor.sh         # after scripts/install.sh: prerequisites + the install itself
set -uo pipefail
PRE=0; [ "${1:-}" = "--pre" ] && PRE=1
PORT="${CHITO_PORT:-8791}"
FAILS=0
pass() { printf '\033[32mPASS\033[0m  %s\n' "$*"; }
warn() { printf '\033[33mWARN\033[0m  %s\n' "$*"; }
fail() { printf '\033[31mFAIL\033[0m  %s\n' "$*"; FAILS=$((FAILS+1)); }

echo "== prerequisites"
[ "$(uname)" = Darwin ] && pass "macOS" || warn "not macOS: chito runs, but the LaunchAgents and Open in terminal are macOS-only (use npm start)"
NODE="${CHITO_NODE:-$(command -v node || true)}"
if [ -z "$NODE" ]; then fail "node not found. Fix: brew install node@22, then CHITO_NODE=\$(brew --prefix node@22)/bin/node"
elif "$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=5)?0:1)'; then pass "node $("$NODE" -v)"
else warn "node $("$NODE" -v): the Projects views need 22.5+ (node:sqlite). Fix: brew install node@22 and pass CHITO_NODE"; fi
PY="${BL_PYTHON:-$(command -v python3 || true)}"
if [ -z "$PY" ]; then fail "python3 not found (needed for bl). Fix: brew install python"
elif "$PY" -c 'import sys,sqlite3; v=tuple(map(int,sqlite3.sqlite_version.split("."))); sys.exit(0 if sys.version_info>=(3,11) and v>=(3,35) else 1)'; then
  pass "python3 $("$PY" -c 'import sys,sqlite3;print("%d.%d"%sys.version_info[:2], "sqlite", sqlite3.sqlite_version)')"
else fail "python3 at $PY is older than 3.11 or its SQLite is older than 3.35. Fix: brew install python, then BL_PYTHON=\$(brew --prefix)/bin/python3"; fi
command -v git >/dev/null && pass "git" || fail "git not found. Fix: xcode-select --install"
command -v claude >/dev/null && pass "claude CLI" || warn "claude CLI not on PATH: chito can still browse transcripts; backlog workers need it (https://claude.com/claude-code)"
if command -v gh >/dev/null; then gh auth status >/dev/null 2>&1 && pass "gh (signed in)" || warn "gh not signed in: run gh auth login for live PR state"
else warn "gh not found (optional): brew install gh; gh auth login for live PR state in Artifacts"; fi

if [ "$PRE" = 0 ]; then
  echo "== install"
  if curl -s -m 3 "localhost:$PORT/api/backlog" | grep -q '"available":true'; then pass "chito serving http://localhost:$PORT (backlog database found)"
  elif curl -s -m 3 -o /dev/null "localhost:$PORT/"; then warn "chito is up on :$PORT but sees no backlog database: run scripts/install.sh without --no-backlog"
  else fail "chito not answering on :$PORT. Fix: scripts/install.sh (or npm start); logs in ~/Library/Logs/chito"; fi
  if command -v bl >/dev/null; then pass "bl on PATH ($(command -v bl))"
  elif [ -x "$HOME/.local/bin/bl" ]; then fail "bl is in ~/.local/bin but that is not on PATH. Fix: add  export PATH=\"\$HOME/.local/bin:\$PATH\"  to your shell profile (Claude Code sessions need it too)"
  else fail "bl not installed. Fix: scripts/install.sh"; fi
  BL="$(command -v bl || echo "$HOME/.local/bin/bl")"
  if [ -x "$BL" ]; then
    st="$("$BL" status 2>/dev/null | head -1)"
    case "$st" in *"daemon: running"*) pass "backlog daemon running";; *) warn "backlog daemon not running ($st). Fix: bl daemon install (or scripts/install.sh)";; esac
  fi
  for s in backlog backlog-run backlog-worker; do
    [ -e "$HOME/.claude/skills/$s/SKILL.md" ] && pass "skill $s" || fail "skill $s missing in ~/.claude/skills. Fix: scripts/install.sh"
  done
  if grep -q 'bl hook session-start' "$HOME/.claude/settings.json" 2>/dev/null; then pass "Claude Code hooks registered"
  else fail "bl hooks missing from ~/.claude/settings.json. Fix: scripts/install.sh"; fi
fi
echo
[ "$FAILS" = 0 ] && echo "doctor: all required checks passed" || echo "doctor: $FAILS check(s) failed; fix them and run scripts/doctor.sh again"
exit $([ "$FAILS" = 0 ] && echo 0 || echo 1)
