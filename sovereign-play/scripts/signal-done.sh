#!/usr/bin/env bash
# Fires when Claude Code finishes a turn. Drops a signal file that a running
# sovereign-play picks up, which starts the end-of-match countdown.
#
# Deliberately does nothing else: it must not block Claude, must not fail the
# turn, and must be harmless when no game is running. Exit 0 always.
set -u

# Stop hooks receive JSON on stdin. We only want `cwd`, and we must not hang if
# nothing is piped in, so read with a timeout and fall back to the env var.
payload=""
if read -r -t 1 -d '' payload 2>/dev/null || [ -n "${payload:-}" ]; then :; fi

dir="${CLAUDE_PROJECT_DIR:-$PWD}"
signal="${SOVEREIGN_PLAY_SIGNAL:-$dir/.claude/sovereign-play.done}"

mkdir -p "$(dirname "$signal")" 2>/dev/null || exit 0
: > "$signal" 2>/dev/null || exit 0
exit 0
