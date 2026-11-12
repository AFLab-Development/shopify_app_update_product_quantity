#!/usr/bin/env python3
"""
Update the Shopify access token for a store in the local SQLite DB.

The running app reads store credentials from the SQLite DB first
(app.database.stores.get_store_credentials), falling back to config_stores.toml
and environment variables. Tokens stored in the DB are Fernet-encrypted with
the ENCRYPTION_KEY.

The startup migration only imports stores that are NOT yet in the DB, so a
regenerated Shopify access token must be pushed into the DB explicitly
(e.g. after Shopify rotates the token) or the old one keeps being used.

Usage:
    .venv/bin/python scripts/update_store_token.py <store_id> <access_token> [api_version]

Examples:
    .venv/bin/python scripts/update_store_token.py refrigiwear "YOUR_SHOPIFY_ACCESS_TOKEN" "2026-01"
    .venv/bin/python scripts/update_store_token.py murphy "YOUR_SHOPIFY_ACCESS_TOKEN" "2026-01"
"""

import asyncio
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))


async def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2

    store_id = sys.argv[1]
    access_token = sys.argv[2]
    api_version = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None

    if not access_token:
        print("ERROR: access_token is required")
        return 2

    from app.database import update_store

    updated = await update_store(
        store_id,
        access_token=access_token,
        api_version=api_version,
    )

    if not updated:
        print(f"ERROR: Could not update store '{store_id}'. Store may not exist.")
        return 1

    print(f"OK: Access token updated for store '{store_id}'")
    if api_version:
        print(f"OK: API version set to '{api_version}'")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
