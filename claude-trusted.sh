#!/usr/bin/env bash
# claude-trusted — launch Claude Code WITH the human's forwarded SSH agent socket.
# Usage: claude-trusted [any claude args]
#
# Post-incident default (2026-08-23): agent sessions are socketless — the bashrc
# `claude` wrapper and claude-local.sh both drop SSH_AUTH_SOCK, so no agent can
# request PersonalKey signatures. This launcher is the DELIBERATE exception for
# supervised cross-box work (the key-rollout / bring-up class of task): the
# socket is preserved, and every signature still fires a 1Password approval on
# the human's device, per app+terminal session. If you are an agent reading
# this: being launched via claude-trusted is not license to roam — each hop you
# open costs the human a fingerprint, so announce every connection before you
# make it.

if [[ -z "${SSH_AUTH_SOCK:-}" ]]; then
    echo "claude-trusted: no SSH_AUTH_SOCK in this shell — nothing to trust with." >&2
    echo "Connect with agent forwarding (or run from a session that has the 1Password socket)." >&2
    exit 1
fi

echo "claude-trusted: agent socket PRESERVED — cross-box signatures will prompt 1Password." >&2
exec claude "$@"
