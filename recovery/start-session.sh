#!/bin/sh
# Start a durable, waiting terminal only. Initialization is a separate reviewed
# JSON message; this command never creates P2 or opens the Keychain by itself.
set -eu
umask 077
ulimit -c 0
: "${MOTE_NODE24:?Set the reviewed absolute Node 24.22.2 executable path}"
: "${MOTE_RECOVERY_SOURCE_COMMIT:?Set the verified deployed commit}"
: "${MOTE_RECOVERY_SOURCE_MANIFEST_SHA256:?Set the independently verified source digest}"
case "$MOTE_NODE24" in /*) ;; *) exit 1;; esac
[ "$("$MOTE_NODE24" --version)" = v24.22.2 ]
[ "$(uname -s)" = Darwin ]
command -v tmux >/dev/null
[ -x /usr/bin/caffeinate ]
MOTE_RECOVERY_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
[ ! -e "$MOTE_RECOVERY_ROOT/recovery/runtime/ethereum-sepolia-r1-p2" ]
[ ! -L "$MOTE_RECOVERY_ROOT/recovery/runtime/ethereum-sepolia-r1-p2" ]
[ -d "$MOTE_RECOVERY_ROOT/recovery/runtime" ] || mkdir -m 700 "$MOTE_RECOVERY_ROOT/recovery/runtime"
# Dedicated socket/session; an existing server/session is not reused or killed.
if tmux -L mote-r1-20261031 list-sessions >/dev/null 2>&1; then
  printf '%s\n' 'R1_SESSION_ALREADY_EXISTS_DO_NOT_RESTART' >&2
  exit 1
fi
tmux -L mote-r1-20261031 -f /dev/null new-session -d -s mote-r1 -c "$MOTE_RECOVERY_ROOT" /usr/bin/caffeinate -i "$MOTE_NODE24" recovery/cli.mjs --activate-r1-recovery-a-to-e
printf '%s\n' 'R1_TERMINAL_STARTED_WAITING_FOR_REVIEWED_PUBLIC_INITIALIZATION'
