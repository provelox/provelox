/**
 * Stops what an exec started: every process of the container that carries this exec's marker in its environment (the
 * shell and the tool it started). Docker cannot signal an exec, and the process id it reports is the host's, not the
 * container's, so the process is found by the marker instead. The marker is a random id we made; it reaches the script
 * as an argument, never as part of its text.
 */
export const EXEC_KILL_SCRIPT = `pids=
for p in /proc/[0-9]*; do
  pid=\${p#/proc/}
  [ "$pid" = "$$" ] && continue
  if tr '\\0' '\\n' < "$p/environ" 2>/dev/null | grep -qx "PVX_EXEC=$1"; then pids="$pids $pid"; fi
done
[ -n "$pids" ] || exit 0
kill -TERM $pids 2>/dev/null
sleep 1
kill -KILL $pids 2>/dev/null
true`;
