#!/usr/bin/env bash
# Install chito and the backlog tools in one go. Idempotent: safe to re-run after `git pull`.
#
#   scripts/install.sh                 # everything
#   scripts/install.sh --no-backlog    # chito only
#   scripts/install.sh --no-daemon     # backlog CLI, skills and hooks, but no background daemon
#   scripts/install.sh --no-launchagent  # don't start chito at login (run `npm start` yourself)
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKLOG=1; DAEMON=1; AGENT=1
for a in "$@"; do case "$a" in
  --no-backlog) BACKLOG=0 ;; --no-daemon) DAEMON=0 ;; --no-launchagent) AGENT=0 ;;
  *) echo "unknown option $a" >&2; exit 2 ;;
esac; done

say() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }

# ---- prerequisites
NODE="${CHITO_NODE:-$(command -v node || true)}"
[ -n "$NODE" ] || { echo "node not found (need Node 22.5+; set CHITO_NODE=/path/to/node)" >&2; exit 1; }
NV="$("$NODE" -p 'process.versions.node')"
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=5)?0:1)' \
  || warn "Node $NV: the Backlog view needs Node 22.5+ (node:sqlite). Sessions and Artifacts still work."
command -v claude >/dev/null || warn "claude CLI not on PATH: chito can browse transcripts, but backlog workers can't start."
command -v gh >/dev/null || warn "gh not found: the Artifacts view shows PRs without live GitHub state (brew install gh; gh auth login)."

# ---- chito
say "chito: installing npm dependencies"
(cd "$DIR" && npm install --silent --no-audit --no-fund)
if [ "$AGENT" = 1 ] && [ "$(uname)" = Darwin ]; then
  say "chito: starting at login (LaunchAgent com.chito.server)"
  CHITO_NODE="$NODE" "$DIR/scripts/install-launchagent.sh"
else
  say "chito: run it with  npm start  (http://localhost:${CHITO_PORT:-8791})"
fi

# ---- backlog
if [ "$BACKLOG" = 1 ]; then
  say "backlog: CLI, skills, hooks$( [ "$DAEMON" = 1 ] && echo ', daemon')"
  if [ "$DAEMON" = 1 ]; then "$DIR/backlog/install.sh"; else "$DIR/backlog/install.sh" --no-daemon; fi
fi

say "done"
echo "  chito:   http://localhost:${CHITO_PORT:-8791}   (Backlog tab: /backlog)"
[ "$BACKLOG" = 1 ] && echo "  backlog: bl status   ·   /backlog in any Claude Code session   ·   data in ${BL_HOME:-$HOME/.backlog}"
exit 0
