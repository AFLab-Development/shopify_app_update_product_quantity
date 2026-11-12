#!/bin/bash
# Update the Shopify access token for a store in the local SQLite DB.
#
# The app reads store credentials from the SQLite DB first (tokens are
# Fernet-encrypted there with ENCRYPTION_KEY), falling back to config_stores.toml
# and environment variables. The startup migration only imports stores that are
# NOT yet in the DB, so after regenerating a Shopify access token you must push
# the new token into the DB explicitly (or delete the stale row).
#
# Usage:
#   ./scripts/update_shopify_token.sh <store_id> <access_token> [api_version]
#
# Examples:
#   ./scripts/update_shopify_token.sh refrigiwear "YOUR_SHOPIFY_ACCESS_TOKEN" "2026-01"
#   ./scripts/update_shopify_token.sh murphy "YOUR_SHOPIFY_ACCESS_TOKEN" "2026-01"

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE_ID="${1:?Usage: ./scripts/update_shopify_token.sh <store_id> <access_token> [api_version]}"
ACCESS_TOKEN="${2:?ERROR: <access_token> is required}"
API_VERSION="${3:-}"

if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a
  source "$PROJECT_ROOT/.env"
  set +a
fi

if [ -z "${ENCRYPTION_KEY:-}" ]; then
  echo "ERROR: ENCRYPTION_KEY is not set. Ensure it is present in $PROJECT_ROOT/.env"
  exit 1
fi

cd "$PROJECT_ROOT"
.venv/bin/python scripts/update_store_token.py "$STORE_ID" "$ACCESS_TOKEN" "$API_VERSION"
