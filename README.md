# Shopify Product Quantity Manager

A FastAPI web app for bulk-updating product inventory quantities and locations in Shopify stores via Excel/CSV file upload.

## What it does

- Upload an Excel file containing SKUs or barcodes with quantity and location data
- The app matches each row against Shopify product variants (via SKU or barcode, auto-detected)
- Supports two sync modes:
  - **Adjust** — adds/subtracts quantity relative to current stock
  - **Fixed** — sets an absolute quantity value
- Optionally activates inventory tracking at a specific Shopify location and adds products to sale channels
- Outputs a detailed CSV log of every change made, including missing and duplicate SKUs

## Requirements

- Python 3.12+
- Docker & Docker Compose (for containerised deployment)

## Local Development

```bash
# Create and activate virtual environment
python -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Run the development server
uvicorn app.main:app --reload --port 9999
```

Open `http://localhost:9999` in your browser.

## Configuration

Store credentials are **never written by hand**. `config_stores.toml` is auto-generated from `.env.*` files by running:

```bash
python generate_config.py
```

Create one `.env` file per store, named `.env.<store_id>` (e.g. `.env.mystore`):

```env
STORE_NAME=my-store-handle
API_VERSION=2026-01
ACCESS_TOKEN=shpat_...
```

`generate_config.py` scans all `.env.*` files in the project root and produces `config_stores.toml`. Neither the `.env.*` files nor `config_stores.toml` are committed to the repository.

## Docker

Build and run:

```bash
docker compose up --build -d
```

App will be available at `http://localhost:9999`.

To run without Compose:

```bash
docker build -t shopify-quantity-manager .
docker run -p 9999:9999 -v $(pwd)/resources:/app/resources shopify-quantity-manager
```

For development with auto-reload:

```bash
docker-compose -f docker-compose.yml -f docker-compose.dev.yml up
```

### Troubleshooting

**Port already in use:**
```bash
docker-compose down
```

**Permission issues with volumes:**
```bash
sudo chown -R $USER:$USER resources/ logs/
```

**View logs:**
```bash
docker-compose logs -f app
```

**Check health status:**
```bash
docker-compose ps
```

## Project Structure

```
app/
  main.py                        # FastAPI app entry point
  routes/api/v1/add_locations/   # Core sync logic
  utilities/
    shopify.py                   # Shopify API client helpers
    logger.py                    # CSV change logger
  views/
    templates/                   # Jinja2 HTML templates
    static/                      # CSS and JS
.env.<store_id>                  # Per-store credentials (not in repo, one file per store)
generate_config.py               # Generates config_stores.toml from .env.* files
config_stores.toml               # Auto-generated, not in repo
requirements.txt
Dockerfile
docker-compose.yml
```

## Logs

Each sync run produces a CSV file under `logs/<store_name>/` recording every quantity change, missing SKU, and duplicate entry.


## Troubleshooting: Shopify 401 Unauthorized during sync

### Root cause
This app has two credential sources:
- **SQLite DB** (`data/sync_app.db`) - used when `get_store_credentials()` can call the async DB function. In a ThreadPoolExecutor thread (like the sync endpoint uses), there's no running event loop so `asyncio.run()` succeeds and reads from DB.
- **TOML fallback** (`config_stores.toml`) - used when called from async context where `asyncio.run()` fails, or when DB lookup fails.

The DB can get out of sync with `config_stores.toml` (e.g., if tokens were updated in TOML after initial migration). Also tokens in the DB are encrypted with `ENCRYPTION_KEY`.

### Symptoms
- Logs show: `DEBUG: DB not available, falling back to TOML: asyncio.run() cannot be called from a running event loop` (main thread)
- But sync runs in thread pool and gets different credentials from DB
- Shopify returns `401: Invalid API key or access token`

### How to fix

#### Local development
1. Check DB contents:
```bash
ENCRYPTION_KEY=your_key_here .venv/bin/python << 'PY'
from app.database.db import get_db
from app.database.crypto import decrypt_token
import asyncio

async def main():
    conn = await get_db()
    try:
        cur = await conn.execute("SELECT store_id, store_name, api_version, access_token_encrypted FROM stores")
        for row in await cur.fetchall():
            token = decrypt_token(row[3])
            print(f"{row[0]}: {row[1]} | {row[2]} | {token[:10]}...")
    finally:
        await conn.close()

asyncio.run(main())
PY
```

2. Update tokens in DB to match `config_stores.toml`:
```bash
ENCRYPTION_KEY=your_key_here .venv/bin/python << 'PY'
from app.database.stores import update_store
import asyncio

async def main():
    await update_store('refrigiwear', access_token='shpat_...', api_version='2026-01')
    await update_store('murphy', access_token='shpat_...', api_version='2026-01')
    await update_store('sviluppo', access_token='shpat_...', api_version='2026-01')
    print("Updated")
    
asyncio.run(main())
PY
```

#### Docker deployment
1. Copy updated DB to container or update from inside
2. Ensure `ENCRYPTION_KEY` is set in container environment (add to `.env` and docker-compose)
3. Restart container: `docker compose restart app`

#### Production server (SSH)
Same as above, but exec into the running container and update the DB there with the correct `ENCRYPTION_KEY`.

## Troubleshooting: `The @idempotent directive is required for this mutation`

### Root cause
Shopify accepts the `@idempotent` directive on `inventoryAdjustQuantities` from Admin API `2026-01` and **requires** it from `2026-04`. The app adds the directive automatically, but an old deployment (stale Docker image / uvicorn process started before the fix) can still send the mutation without it.

### How to fix
1. Rebuild/redeploy from current `main` so `app/utilities/shopify.py` includes the directive:
```bash
docker compose up --build -d
```
2. Check the store's API version in the DB (`SELECT store_id, api_version FROM stores`) and in `config_stores.toml`. It must be `2026-01` or newer.
3. Re-run the file in `adjust` mode. The rejected mutation applied no quantity changes, so a retry is safe.

The mutation now also self-heals: if Shopify reports the directive as required (or unknown), the batch is retried once with the correct query shape, reusing the same idempotency key.
