#!/usr/bin/env bash
# dsh-multi-user — portable verifier (thin wrapper).
#
#   ./verify.sh                 # cheapest checks first
#   ./verify.sh --deep          # also spawn a real per-user instance end to end
#   ./verify.sh --user admin --password '...'
#
# Exit code = number of failed checks.
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${PROFILE:-web}"
GATEWAY_PORT="${GATEWAY_PORT:-3090}"

if [ -z "${DSH_HOME:-}" ]; then
  if command -v systemctl >/dev/null 2>&1; then
    DSH_HOME="$(systemctl show dsh-web.service -p Environment --value 2>/dev/null | tr ' ' '\n' | sed -n 's/^DSH_HOME=//p' | head -1)"
  fi
  DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
fi

command -v node >/dev/null 2>&1 || { echo "node is required on PATH" >&2; exit 1; }

# ── offline checks ───────────────────────────────────────────────────────────
# Neither needs the running service: one proves a user space inherits the host's
# application set, the other boots a throwaway gateway to drive the self-service
# password flow. Running them first means a broken build is caught before it can
# be blamed on the deployment.
FAILED=0
for helper in check_profile_sync.mjs check_password.mjs; do
  [ -f "$HERE/tools/$helper" ] || continue
  echo "── $helper ──"
  node "$HERE/tools/$helper" || FAILED=$((FAILED + 1))
done

set +e
node "$HERE/verify.mjs" \
  --dsh-home "$DSH_HOME" \
  --profile "$PROFILE" \
  --port "$GATEWAY_PORT" \
  "$@"
VERIFY_CODE=$?
set -e

exit $((VERIFY_CODE + FAILED))
