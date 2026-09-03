#!/usr/bin/env bash
set -euo pipefail

runtime_dir="$(cd "$(dirname "$0")/.." && pwd)"
env_file="$runtime_dir/.env"
if [[ ! -f "$env_file" ]]; then
  printf 'Missing environment file: %s\n' "$env_file" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

host_port="${BROCHURE_TEST_HOST_PORT:-8790}"
runtime_port="${PORT:-8787}"
run_dir="$(mktemp -d "${TMPDIR:-/tmp}/sable-niroggyan-live.XXXXXX")"
tunnel_log="$run_dir/cloudflared.log"
runtime_log="$run_dir/runtime.log"
host_log="$run_dir/host.log"
runtime_pid=""
host_pid=""
tunnel_pid=""

cleanup() {
  trap - EXIT INT TERM
  for process_id in "$host_pid" "$runtime_pid" "$tunnel_pid"; do
    if [[ -n "$process_id" ]] && kill -0 "$process_id" 2>/dev/null; then
      kill "$process_id" 2>/dev/null || true
      wait "$process_id" 2>/dev/null || true
    fi
  done
  printf '\nStopped the NirogGyan live-demo services. Logs remain at %s\n' "$run_dir"
}
trap cleanup EXIT INT TERM

cd "$runtime_dir"
for required in node npm cloudflared curl openssl; do
  command -v "$required" >/dev/null || { printf 'Missing required command: %s\n' "$required" >&2; exit 1; }
done

catalog_file="$runtime_dir/data/niroggyan-brochure-guided-demo-runtime.generated.json"
secrets_file="$runtime_dir/data/niroggyan-brochure-guided-demo-secrets.generated.json"
sdk_bundle="$runtime_dir/../product_live_assist/packages/web-sdk/dist/sable.min.js"
ui_bundle="$runtime_dir/../product_live_assist/packages/web-sdk-ui/dist/sable-ui.min.js"
for required_file in "$catalog_file" "$secrets_file" "$sdk_bundle" "$ui_bundle"; do
  [[ -f "$required_file" ]] || { printf 'Required guided-demo artifact is missing: %s\n' "$required_file" >&2; exit 1; }
done

printf 'Building the runtime and compiled live-test host...\n'
npm run build >/dev/null

printf 'Opening one temporary HTTPS tunnel...\n'
cloudflared tunnel --url "http://127.0.0.1:$host_port" --no-autoupdate >"$tunnel_log" 2>&1 &
tunnel_pid="$!"
public_url=""
for _ in {1..45}; do
  public_url="$(sed -n 's#.*\(https://[-a-z0-9]*\.trycloudflare\.com\).*#\1#p' "$tunnel_log" | tail -n 1)"
  [[ -n "$public_url" ]] && break
  kill -0 "$tunnel_pid" 2>/dev/null || { tail -n 30 "$tunnel_log" >&2; exit 1; }
  sleep 1
done
[[ -n "$public_url" ]] || { printf 'Cloudflare did not provide a public URL. See %s\n' "$tunnel_log" >&2; exit 1; }

token_secret="$(openssl rand -hex 32)"
broker_secret="$(openssl rand -hex 24)"

printf 'Starting the NirogGyan cloud runtime...\n'
PORT="$runtime_port" \
PUBLIC_API_URL="$public_url" \
RUNTIME_STORE=file \
RUNTIME_FILE="$catalog_file" \
TOKEN_SIGNING_SECRET="$token_secret" \
node dist/src/index.js >"$runtime_log" 2>&1 &
runtime_pid="$!"

for _ in {1..30}; do
  curl --silent --fail "http://127.0.0.1:$runtime_port/healthz" >/dev/null 2>&1 && break
  kill -0 "$runtime_pid" 2>/dev/null || { tail -n 40 "$runtime_log" >&2; exit 1; }
  sleep 1
done
curl --silent --fail "http://127.0.0.1:$runtime_port/healthz" >/dev/null

printf 'Starting the SDK, token, API, and WebSocket test gateway...\n'
BROCHURE_TEST_HOST_PORT="$host_port" \
BROCHURE_TEST_RUNTIME_DIR="$runtime_dir" \
BROCHURE_TEST_ASSET_URL="$public_url" \
BROCHURE_TEST_BROKER_SECRET="$broker_secret" \
PUBLIC_API_URL="$public_url" \
RUNTIME_INTERNAL_URL="http://127.0.0.1:$runtime_port" \
node dist/client-catalogs/niroggyan-brochure/live-test-host.js >"$host_log" 2>&1 &
host_pid="$!"

for _ in {1..30}; do
  curl --silent --fail "http://127.0.0.1:$host_port/healthz" >/dev/null 2>&1 && break
  kill -0 "$host_pid" 2>/dev/null || { tail -n 40 "$host_log" >&2; exit 1; }
  sleep 1
done
curl --silent --fail "http://127.0.0.1:$host_port/healthz" >/dev/null

printf 'Waiting for the temporary public hostname to become reachable...\n'
public_ready="false"
for _ in {1..45}; do
  if curl --silent --fail --connect-timeout 3 --max-time 8 "$public_url/healthz" >/dev/null 2>&1; then
    public_ready="true"
    break
  fi
  kill -0 "$tunnel_pid" 2>/dev/null || { tail -n 30 "$tunnel_log" >&2; exit 1; }
  sleep 2
done
[[ "$public_ready" == "true" ]] || { printf 'Temporary Cloudflare hostname did not become reachable. Retry the launcher. See %s\n' "$tunnel_log" >&2; exit 1; }

printf 'Verifying public token, bootstrap, signed catalog, and control WebSocket...\n'
BROCHURE_TEST_PUBLIC_URL="$public_url" \
BROCHURE_TEST_BROKER_SECRET="$broker_secret" \
node scripts/verify-niroggyan-live-gateway.mjs >/dev/null

manual_url="$public_url/injection.js?key=$broker_secret&voice=1"
automatic_url="$public_url/injection.js?key=$broker_secret&auto=lab&voice=0"
manual_snippet="(()=>{const s=document.createElement('script');s.src='$manual_url';document.head.appendChild(s)})()"
automatic_snippet="(()=>{const s=document.createElement('script');s.src='$automatic_url';document.head.appendChild(s)})()"

printf '\nNirogGyan guided-demo test is ready.\n'
printf 'Open https://www.brochure.niroggyan.com/ and paste ONE line into DevTools Console.\n\n'
printf 'AUTOMATED LAB DEMO (text-only, starts and answers intake automatically):\n%s\n\n' "$automatic_snippet"
printf 'MANUAL VOICE DEMO (paste, then click Start Demo to unlock browser audio):\n%s\n\n' "$manual_snippet"
printf 'Public test endpoint: %s\n' "$public_url"
printf 'Logs: %s\n' "$run_dir"
if command -v pbcopy >/dev/null; then
  printf '%s' "$automatic_snippet" | pbcopy
  printf 'The automated-demo line has also been copied to your clipboard.\n'
fi
printf 'Keep this command running. Press Ctrl-C after testing.\n'

wait "$host_pid"
