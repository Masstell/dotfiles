#!/usr/bin/env bash
# docker PATH shim (~/.local/bin/docker) — post docker-group removal.
# Read-only verbs route transparently through the root-owned allowlist wrapper
# (sudo -n docker-ro, the box's single NOPASSWD entry), so `docker ps` and
# `docker logs` just work for humans and agents alike. Mutating verbs get a
# clear refusal: the human runs those as `sudo docker ...`, which resolves the
# real binary via sudo's secure_path and never sees this shim.
#
# This shim is UX, not security — it grants nothing (privilege lives in
# /usr/local/sbin/docker-ro + sudoers) and editing it gains nothing.

RO_VERBS=" ps images stats top logs port events version info df inspect "

v="${1:-}"
case "$RO_VERBS" in
    *" $v "*)
        exec sudo -n /usr/local/sbin/docker-ro "$@"
        ;;
esac
if [ "$v" = "compose" ] && [ "${2:-}" = "ls" ]; then
    exec sudo -n /usr/local/sbin/docker-ro "$@"
fi

echo "docker (read-only shim): '${v:-<none>}' mutates state." >&2
echo "The human runs it directly:  sudo docker $*" >&2
echo "Read-only verbs (no sudo needed):${RO_VERBS}" >&2
exit 1
