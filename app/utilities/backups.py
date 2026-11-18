"""Durable, inspectable snapshots of Shopify inventory quantities.

A snapshot is written before every sync so a mistaken test run can be undone.
Files live under ``logs/<store>/backups/``; that directory is bind-mounted in
docker-compose (``./logs:/app/logs``), so backups survive container rebuilds.
The SQLite database is deliberately *not* used here because ``data/`` is not
mounted and would be lost on rebuild.
"""

import json
import os
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).parent.parent.parent
DEFAULT_BACKUP_DIR = PROJECT_ROOT / "logs"

BACKUP_DIR_NAME = "backups"
# Microseconds are part of the id so lexical order always matches creation
# order, even for several backups within the same second.
BACKUP_ID_PATTERN = re.compile(r"^\d{8}_\d{6}_\d{6}_[0-9a-f]{6}$")
STORE_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+$")
MAX_BACKUPS = 30


def _safe_store_name(store_name: str) -> str:
    if not store_name or not STORE_NAME_PATTERN.fullmatch(store_name) or ".." in store_name:
        raise ValueError(f"Invalid store name: {store_name!r}")
    return store_name


def backups_dir(store_name: str, base_log_dir: str | Path | None = None) -> Path:
    root = Path(base_log_dir) if base_log_dir else DEFAULT_BACKUP_DIR
    return root / _safe_store_name(store_name) / BACKUP_DIR_NAME


def validate_backup_id(backup_id: str) -> str:
    if not backup_id or not BACKUP_ID_PATTERN.fullmatch(backup_id):
        raise ValueError(f"Invalid backup id: {backup_id!r}")
    return backup_id


def _backup_path(directory: Path, backup_id: str) -> Path:
    return directory / f"{validate_backup_id(backup_id)}.json"


def create_backup(
    store_name: str,
    *,
    source_file: str,
    sync_mode: str,
    location: dict | None,
    items: list[dict[str, Any]],
    base_log_dir: str | Path | None = None,
    keep: int = MAX_BACKUPS,
) -> str:
    """Atomically write a new snapshot and return its id."""
    directory = backups_dir(store_name, base_log_dir)
    directory.mkdir(parents=True, exist_ok=True)

    now = datetime.now()
    backup_id = f"{now.strftime('%Y%m%d_%H%M%S_%f')}_{uuid.uuid4().hex[:6]}"
    payload = {
        "version": 1,
        "id": backup_id,
        "store": store_name,
        "created_at": now.isoformat(timespec="seconds"),
        "source_file": source_file,
        "sync_mode": sync_mode,
        "location": location or {},
        "items": list(items),
    }

    target = _backup_path(directory, backup_id)
    temp = target.with_suffix(".json.tmp")
    temp.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False, default=str),
        encoding="utf-8",
    )
    os.replace(temp, target)

    prune_backups(store_name, base_log_dir=base_log_dir, keep=keep)
    return backup_id


def list_backups(
    store_name: str, base_log_dir: str | Path | None = None
) -> list[dict[str, Any]]:
    """Return backup summaries, newest first."""
    directory = backups_dir(store_name, base_log_dir)
    if not directory.is_dir():
        return []

    summaries = []
    for path in sorted(directory.glob("*.json"), reverse=True):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        summaries.append(
            {
                "id": data.get("id") or path.stem,
                "created_at": data.get("created_at"),
                "source_file": data.get("source_file"),
                "sync_mode": data.get("sync_mode"),
                "location": data.get("location") or {},
                "item_count": len(data.get("items") or []),
            }
        )
    return summaries


def load_backup(
    store_name: str, backup_id: str, base_log_dir: str | Path | None = None
) -> dict[str, Any] | None:
    path = _backup_path(backups_dir(store_name, base_log_dir), backup_id)
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def prune_backups(
    store_name: str, base_log_dir: str | Path | None = None, keep: int = MAX_BACKUPS
) -> int:
    """Delete the oldest backups beyond ``keep``. Returns the number removed."""
    if keep < 1:
        return 0
    directory = backups_dir(store_name, base_log_dir)
    if not directory.is_dir():
        return 0
    files = sorted(directory.glob("*.json"), reverse=True)
    removed = 0
    for path in files[keep:]:
        try:
            path.unlink()
            removed += 1
        except OSError:
            continue
    return removed
