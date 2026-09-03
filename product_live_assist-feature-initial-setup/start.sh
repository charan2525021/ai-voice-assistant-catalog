#!/usr/bin/env bash
# Aidan — start the whole stack with one command.
#
#   ./start.sh            local voice (Whisper + Kokoro); no API key needed for speech
#   ./start.sh --hosted   hosted STT/TTS instead (needs SARVAM_API_KEY)
#   ./start.sh --stop     stop anything left running and exit
#
# Three processes, separated because each has a different failure mode and
# restart cost:
#   :8091  TTS   Kokoro    loads a model once and stays warm
#   :8089  STT   Whisper   CPU/Metal bound; must not block the app's event loop
#   :8787  app   Node      agent, Brain, browser control and the web UI
set -uo pipefail
cd "$(dirname "$0")"

APP_PORT="${PORT:-8787}"
STT_PORT="${VOICE_PORT:-8089}"
TTS_PORT_="${TTS_PORT:-8091}"
PIDS=()

cleanup() {
  echo
  echo "stopping…"
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

stop_all() {
  local found=0 pid
  for port in "$APP_PORT" "$STT_PORT" "$TTS_PORT_"; do
    pid="$(lsof -ti ":$port" 2>/dev/null || true)"
    if [ -n "$pid" ]; then
      echo "  stopping :$port (pid $pid)"
      kill $pid 2>/dev/null || true
      found=1
    fi
  done
  [ "$found" = 0 ] && echo "  nothing running"
  sleep 1
}

if [ "${1:-}" = "--stop" ]; then
  echo "Aidan stopping…"; stop_all; trap - EXIT; exit 0
fi

# ---- refuse to start on top of something else --------------------------------
# A port held by a previous run used to be REPORTED AS SUCCESS, because the check
# was only "is this port busy?" — which is true either way. The service then died
# with EADDRINUSE while the banner claimed it was up. Check first, name the
# offender, and say exactly how to clear it.
busy=0
for port in "$APP_PORT" "$STT_PORT" "$TTS_PORT_"; do
  pid="$(lsof -ti ":$port" 2>/dev/null | head -1 || true)"
  if [ -n "$pid" ]; then
    echo "  ✗ port $port already in use by pid $pid: $(ps -o command= -p "$pid" 2>/dev/null | cut -c1-70)"
    busy=1
  fi
done
if [ "$busy" = 1 ]; then
  echo
  echo "Run './start.sh --stop' to clear them, then start again."
  trap - EXIT
  exit 1
fi

# ---- start, and verify OUR process is the one listening ----------------------
# "The port is open" is not the same as "the thing I launched is serving it".
# This also notices a child that dies during startup instead of hanging.
wait_for() { # pid, port, name
  local pid="$1" port="$2" name="$3"
  for _ in $(seq 1 90); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "  ✗ $name exited during startup — see the log above"
      return 1
    fi
    if lsof -ti ":$port" 2>/dev/null | grep -qx "$pid"; then
      echo "  ✓ $name on :$port"
      return 0
    fi
    sleep 1
  done
  echo "  ✗ $name did not listen on :$port within 90s"
  return 1
}

MODE="${1:-local}"
echo "Aidan starting (${MODE#--})…"

if [ "$MODE" != "--hosted" ]; then
  TTS_PORT="$TTS_PORT_" ./.venv/bin/python -m voice.tts_server &
  TTS_PID=$!; PIDS+=("$TTS_PID")
  # Kokoro loads its model before binding, so a cold first run takes a while.
  wait_for "$TTS_PID" "$TTS_PORT_" "TTS (kokoro)" || exit 1
  export TTS_PROVIDER=kokoro TTS_URL="http://127.0.0.1:$TTS_PORT_"
  export ASR_PROVIDER=whisper
else
  export TTS_PROVIDER=sarvam ASR_PROVIDER=sarvam
fi

VOICE_PORT="$STT_PORT" ./.venv/bin/python -m voice.server &
STT_PID=$!; PIDS+=("$STT_PID")
wait_for "$STT_PID" "$STT_PORT" "STT (${ASR_PROVIDER})" || exit 1

( cd server && PORT="$APP_PORT" npm start ) &
APP_PID=$!; PIDS+=("$APP_PID")
# npm spawns tsx as a child, so the listener is a descendant, not $APP_PID itself.
app_ok=0
for _ in $(seq 1 90); do
  if ! kill -0 "$APP_PID" 2>/dev/null; then echo "  ✗ app exited during startup"; exit 1; fi
  if lsof -ti ":$APP_PORT" >/dev/null 2>&1; then echo "  ✓ app on :$APP_PORT"; app_ok=1; break; fi
  sleep 1
done
[ "$app_ok" = 1 ] || { echo "  ✗ app did not listen on :$APP_PORT within 90s"; exit 1; }

echo
echo "  → http://localhost:$APP_PORT"
echo "  (ctrl-c stops everything)"
wait
