import asyncio
from datetime import datetime
import os
import json
import traceback
import unicodedata
from fastapi import APIRouter, Body, File, Path, Request, UploadFile, HTTPException, Form, Query
from fastapi.responses import JSONResponse, StreamingResponse, PlainTextResponse, FileResponse
import pandas as pd

from app.routes.api.v1.add_locations.main import (
    get_product_variants_and_sync,
    _normalize_location_id,
    _normalize_reference_value,
)
from app.utilities.shopify import (
    detect_identifier_type,
    get_available_quantities_at_location,
    get_product_variants_by_identifier,
    get_sale_channels,
    get_store_locations,
    set_quantities_to_values,
)
from app.utilities.backups import (
    backups_dir,
    create_backup,
    list_backups,
    load_backup,
    validate_backup_id,
)

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../../"))
DONE_SUFFIX = "__DONE__"

LOCATION_COLUMNS = ("id sede", "location_id", "location")
SALE_CHANNEL_COLUMNS = ("canali di vendita", "canale di vendita", "sale_channel")

# Normalize text: remove accents for column name matching
def normalize_text(text):
    return unicodedata.normalize('NFKD', text).encode('ASCII', 'ignore').decode('utf-8')


def _get_stores_config(request: Request = None) -> dict:
    if request and hasattr(request.app.state, "stores"):
        return request.app.state.stores
    return {}


def get_store_config_sync(request: Request, store_id: str):
    stores = _get_stores_config(request)
    return stores.get(store_id)


def _is_done_file(filename: str) -> bool:
    return DONE_SUFFIX.lower() in filename.lower()


def _build_done_filename(filename: str, counter: int | None = None) -> str:
    stem, ext = os.path.splitext(filename)
    if counter is None:
        return f"{stem}{DONE_SUFFIX}{ext}"
    return f"{stem}{DONE_SUFFIX}{counter}{ext}"


def _mark_file_as_done(resources_dir: str, filename: str) -> str:
    """Rename a resource file by adding a DONE suffix to prevent re-sync."""
    if _is_done_file(filename):
        return filename

    source_path = os.path.join(resources_dir, filename)
    if not os.path.isfile(source_path):
        raise FileNotFoundError(f"Source file not found: {filename}")

    done_filename = _build_done_filename(filename)
    done_path = os.path.join(resources_dir, done_filename)

    counter = 1
    while os.path.exists(done_path):
        done_filename = _build_done_filename(filename, counter=counter)
        done_path = os.path.join(resources_dir, done_filename)
        counter += 1

    os.rename(source_path, done_path)
    return done_filename


def _safe_store_file_path(base_dir: str, filename: str) -> tuple[str, str]:
    """Return a safe filename and absolute file path within the given base directory."""
    safe_filename = os.path.basename(filename)
    if safe_filename != filename:
        raise HTTPException(status_code=400, detail="Invalid filename")

    abs_base_dir = os.path.abspath(base_dir)
    abs_file_path = os.path.abspath(os.path.join(abs_base_dir, safe_filename))

    if not abs_file_path.startswith(abs_base_dir + os.sep):
        raise HTTPException(status_code=400, detail="Invalid file path")

    return safe_filename, abs_file_path


def _apply_requested_column_value(df, candidate_columns, column_to_add, value):
    """Apply a UI-supplied value to a file column and report what happened.

    An explicitly supplied value always wins. If the file already has one of
    the candidate columns it is overwritten; the old behaviour silently
    ignored the input, which could leave a wrong location in the file.
    """
    if not value:
        return df, "unchanged", []

    existing = next((col for col in candidate_columns if col in df.columns), None)
    if existing is None:
        df[column_to_add] = value
        return df, "added", []

    previous_values = [str(v).strip() for v in df[existing].dropna().unique()]
    df[existing] = value
    return df, "overwritten", previous_values



def _is_blank(value) -> bool:
    if value is None:
        return True
    try:
        return bool(pd.isna(value))
    except (TypeError, ValueError):
        return False


def _quantity_number(value):
    """Return an int/float for a quantity cell, or None when unusable."""
    if _is_blank(value) or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number:  # NaN
        return None
    return int(number) if number.is_integer() else number


def _check_payload(filename, columns, has_location, has_sale_channel, ready, detail, **extra):
    payload = {
        "filename": filename,
        "columns": list(columns),
        "total_skus": 0,
        "has_location": has_location,
        "has_sale_channel": has_sale_channel,
        "missing_fields": [],
        "missing_rows": [],
        "duplicate_rows": [],
        "ready_to_sync": ready,
        "detail": detail,
        "identifier_type": None,
        "summary": {},
        "target": {},
        "warnings": [],
        "rows": [],
        "preview": [],
    }
    payload.update(extra)
    return payload


def get_current_store_name(request: Request = None):
    """Get current store name from cookie, header, or environment variable"""
    store_id = None
    
    if request:
        store_id = request.headers.get("X-Selected-Store")
    
    if not store_id:
        env_store = os.getenv("STORE_NAME")
        if env_store:
            return env_store.split("-")[1] if "-" in env_store else env_store
    
    if store_id:
        stores = _get_stores_config(request)
        if store_id in stores:
            store_name = stores[store_id].get("store_name", "")
            return store_name.split("-")[1] if "-" in store_name else store_name
    
    return None


def get_current_store_id(request: Request = None):
    """Get current store id from header or environment mapping."""
    store_id = None

    if request:
        store_id = request.headers.get("X-Selected-Store")

    if store_id:
        return store_id

    env_store = os.getenv("STORE_NAME")
    if env_store:
        stores = _get_stores_config(request)
        for sid, sconfig in stores.items():
            if sconfig.get("store_name") == env_store:
                return sid

    return None

def get_store_config(request: Request = None):
    """Get the full store configuration"""
    store_id = None
    
    if request:
        store_id = request.headers.get("X-Selected-Store")
    
    if not store_id:
        env_store = os.getenv("STORE_NAME")
        if env_store:
            stores = _get_stores_config(request)
            for sid, sconfig in stores.items():
                if sconfig.get("store_name") == env_store:
                    return sconfig
    
    if store_id:
        stores = _get_stores_config(request)
        return stores.get(store_id)
    
    return None


def _get_store_log_dirs(request: Request) -> list[str]:
    """Build candidate log directories for a store (name and id folders)."""
    store_name = get_current_store_name(request)
    if not store_name:
        raise HTTPException(status_code=400, detail="No store selected. Please select a store.")

    store_id = get_current_store_id(request)

    candidates = [
        os.path.join(PROJECT_ROOT, "logs", store_name),
    ]
    if store_id:
        candidates.append(os.path.join(PROJECT_ROOT, "logs", store_id))

    unique_dirs = []
    seen = set()
    for candidate in candidates:
        abs_candidate = os.path.abspath(candidate)
        if abs_candidate in seen:
            continue
        seen.add(abs_candidate)
        unique_dirs.append(abs_candidate)

    return unique_dirs


def _resolve_store_log_file(request: Request, filename: str) -> tuple[str, str]:
    """Resolve a log filename from candidate store log directories."""
    safe_filename = os.path.basename(filename)
    if safe_filename != filename:
        raise HTTPException(status_code=400, detail="Invalid filename")

    log_dirs = _get_store_log_dirs(request)

    for logs_dir in log_dirs:
        _, candidate_path = _safe_store_file_path(logs_dir, safe_filename)
        if os.path.isfile(candidate_path):
            return safe_filename, candidate_path

    _, fallback_path = _safe_store_file_path(log_dirs[0], safe_filename)
    return safe_filename, fallback_path

router = APIRouter(
    prefix="/v1",
)

@router.get("/")
def health_check(request: Request):

    # check all the endpoints and return them in a list
    endpoints = []
    for route in request.app.routes:
        if route.path.startswith("/api/v1"):
            endpoints.append({
                "path": route.path,
                "name": route.name,
                "methods": route.methods,
            })

    return {
        "status": "ok",
        "message": "Service is running",
        "endpoints": endpoints,
    }

@router.get("/resources")
async def list_resources(request: Request):
    store_name = get_current_store_name(request)
    if not store_name:
        raise HTTPException(status_code=400, detail="No store selected. Please select a store.")
    resources_dir = os.path.join(PROJECT_ROOT, "resources", store_name)
    try:
        files = os.listdir(resources_dir)
        files = [f for f in files if not f.startswith('.')]
        files = sorted(files, key=lambda f: (_is_done_file(f), f.lower()))
    except FileNotFoundError:
        files = []
    return JSONResponse(files)


@router.get("/logs")
async def list_store_logs(request: Request):
    log_files = []
    seen_filenames = set()

    for logs_dir in _get_store_log_dirs(request):
        try:
            filenames = [f for f in os.listdir(logs_dir) if not f.startswith('.')]
        except FileNotFoundError:
            continue
        except PermissionError:
            raise HTTPException(
                status_code=500,
                detail="Cannot read logs directory. Check permissions for mounted logs volume.",
            )

        for filename in filenames:
            if filename in seen_filenames:
                continue

            file_path = os.path.join(logs_dir, filename)
            if not os.path.isfile(file_path):
                continue

            stat = os.stat(file_path)
            log_files.append({
                "filename": filename,
                "size_bytes": stat.st_size,
                "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
                "type": os.path.splitext(filename)[1].lstrip(".").lower() or "file",
                "source_store_dir": os.path.basename(logs_dir),
                "_mtime": stat.st_mtime,
            })
            seen_filenames.add(filename)

    log_files.sort(key=lambda item: item["_mtime"], reverse=True)
    for item in log_files:
        item.pop("_mtime", None)

    return JSONResponse(log_files)


@router.get("/logs/content/{filename}")
async def get_store_log_content(
    request: Request,
    filename: str = Path(..., description="The name of the log file"),
    lines: int = Query(300, ge=20, le=2000, description="Number of lines to return from the end of the file"),
):
    _, file_path = _resolve_store_log_file(request, filename)
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="Log file not found")

    with open(file_path, "r", encoding="utf-8", errors="replace") as file_obj:
        content_lines = file_obj.readlines()

    preview = "".join(content_lines[-lines:])
    return PlainTextResponse(preview)


@router.get("/logs/download/{filename}")
async def download_store_log(
    request: Request,
    filename: str = Path(..., description="The name of the log file to download"),
):
    safe_filename, file_path = _resolve_store_log_file(request, filename)
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="Log file not found")

    media_type = "text/csv" if safe_filename.lower().endswith(".csv") else "text/plain"
    return FileResponse(file_path, media_type=media_type, filename=safe_filename)


@router.delete("/logs/{filename}")
async def delete_store_log(
    request: Request,
    filename: str = Path(..., description="The name of the log file to delete"),
):
    safe_filename, file_path = _resolve_store_log_file(request, filename)
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="Log file not found")

    try:
        os.remove(file_path)
        return {"detail": f"Log file '{safe_filename}' deleted successfully."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error deleting log file: {e}")


@router.delete("/resources/{filename}")
async def delete_resource(
    request: Request,
    filename: str = Path(..., description="The name of the file to delete")
):
    """
    Delete a resource file from the store's resources directory. This is a permanent action and cannot be undone.
    """
    store_name = get_current_store_name(request)
    if not store_name:
        raise HTTPException(status_code=400, detail="No store selected. Please select a store.")
    resources_dir = os.path.join(PROJECT_ROOT, "resources", store_name)
    file_path = os.path.join(resources_dir, filename)

    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="File not found")

    try:
        os.remove(file_path)
        return {"detail": f"File '{filename}' deleted successfully."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error deleting file: {e}")

@router.get("/resources/{filename}")
async def download_resource(
    request: Request,
    filename: str = Path(..., description="The name of the file to download"),
    download: bool = Query(False, description="If true, force download")
):
    store_name = get_current_store_name(request)
    if not store_name:
        raise HTTPException(status_code=400, detail="No store selected. Please select a store.")
    resources_dir = os.path.join(PROJECT_ROOT, "resources", store_name)
    file_path = os.path.join(resources_dir, filename)

    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="File not found")

    media_type = "application/octet-stream"
    return FileResponse(
        file_path,
        media_type=media_type,
        filename=filename if download else None
    )

@router.get("/check/{filename}")
async def check_file_structure(
    request: Request,
    filename: str = Path(..., description="The name of the file to check")
):
    """Validate a file and return a detailed preflight report."""
    store_name = get_current_store_name(request)
    if not store_name:
        raise HTTPException(status_code=400, detail="No store selected. Please select a store.")

    store_id = request.headers.get("X-Selected-Store")
    if not store_id:
        raise HTTPException(status_code=400, detail="No store selected. Please select a store.")

    resources_dir = os.path.join(PROJECT_ROOT, "resources", store_name)
    file_path = os.path.join(resources_dir, filename)

    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="File not found")

    try:
        if filename.lower().endswith('.csv'):
            df = pd.read_csv(file_path)
        elif filename.lower().endswith(('.xls', '.xlsx')):
            df = pd.read_excel(file_path)
        else:
            raise HTTPException(status_code=400, detail="Unsupported file type")

        df.columns = [normalize_text(col) for col in df.columns.str.lower()]

        has_location_in_file = any(col in LOCATION_COLUMNS for col in df.columns)
        has_sale_channel_in_file = any(col in SALE_CHANNEL_COLUMNS for col in df.columns)
        has_quantity_in_file = any(col in ('qta', 'quantity', 'qty') for col in df.columns)
        has_product_ref_in_file = any(col in ('sku', 'barcode') for col in df.columns)

        missing_fields = []
        if not has_location_in_file:
            missing_fields.append("location_id")
        if not has_sale_channel_in_file:
            missing_fields.append("sale_channel")
        if not has_quantity_in_file:
            missing_fields.append("quantity")
        if not has_product_ref_in_file:
            missing_fields.append("sku/barcode")

        if missing_fields:
            return _check_payload(
                filename, df.columns, has_location_in_file, has_sale_channel_in_file,
                False, f"File is missing required fields: {', '.join(missing_fields)}",
                missing_fields=missing_fields,
            )

        location_col = next((c for c in LOCATION_COLUMNS if c in df.columns), None)
        channel_col = next((c for c in SALE_CHANNEL_COLUMNS if c in df.columns), None)
        quantity_col = next((c for c in ('qta', 'quantity', 'qty') if c in df.columns), None)
        reference_col = 'barcode' if 'barcode' in df.columns else 'sku'

        data_records = df.to_dict(orient="records")
        prod_reference = [
            _normalize_reference_value(row.get(reference_col)) for row in data_records
        ]
        identifier_type = detect_identifier_type(prod_reference)
        product_variants = get_product_variants_by_identifier(
            prod_reference, identifier_type, store_id=store_id
        )
        if not product_variants:
            return _check_payload(
                filename, df.columns, has_location_in_file, has_sale_channel_in_file,
                False, "No matching product variants found in Shopify.",
                total_skus=len(data_records),
                identifier_type=identifier_type,
                missing_rows=prod_reference,
            )

        variant_map = {}
        variant_match_counts = {}
        for variant in product_variants:
            ref = _normalize_reference_value(variant.get(identifier_type))
            if ref == "EMPTY_SKU":
                continue
            variant_match_counts[ref] = variant_match_counts.get(ref, 0) + 1
            variant_map.setdefault(ref, variant)

        # Names are resolved once per check so the report can say
        # "115117195591 -> RefrigiWear Store Napoli" instead of a bare id.
        # Shopify returns GIDs, files hold bare numeric ids: index both forms.
        def _name_index(nodes):
            index = {}
            for node in nodes or []:
                gid = node.get("id") or ""
                name = node.get("name") or ""
                index[gid] = name
                index[gid.rsplit("/", 1)[-1]] = name
            return index

        locations = get_store_locations(store_id=store_id)
        location_names = _name_index(locations)
        channels = get_sale_channels(store_id=store_id)
        channel_names = _name_index(channels)

        missing_rows = []
        duplicate_rows = []
        seen_refs = {}
        rows_detail = []
        matched_item_ids = []
        location_ids = []
        channel_ids = []

        for index, row in enumerate(data_records):
            ref = prod_reference[index]
            quantity_raw = row.get(quantity_col)
            quantity_number = _quantity_number(quantity_raw)
            quantity_display = "" if _is_blank(quantity_raw) else str(quantity_raw)

            location_id = _normalize_location_id(row.get(location_col))
            channel_raw = row.get(channel_col)
            channel_value = "" if _is_blank(channel_raw) else str(channel_raw).strip()
            channels_in_row = [c.strip() for c in channel_value.split(",") if c.strip()]

            variant = variant_map.get(ref)
            inventory_item_id = ""
            variant_info = variant.get("inventoryItem") or {} if variant else {}
            if variant_info.get("id"):
                inventory_item_id = variant_info["id"]
                matched_item_ids.append(inventory_item_id)
            if location_id:
                location_ids.append(location_id)
            channel_ids.extend(channels_in_row)

            product = (variant or {}).get("product") or {}
            product_gid = product.get("id") or ""
            rows_detail.append({
                "row": index + 1,
                "reference": ref,
                "quantity": quantity_display,
                "quantity_number": quantity_number,
                "location_id": location_id,
                "location_name": location_names.get(location_id, ""),
                "sale_channel": channel_value,
                "matched": variant is not None,
                "product_id": product_gid.rsplit("/", 1)[-1] if product_gid else "",
                "variant_title": (variant or {}).get("title", ""),
                "inventory_item_id": inventory_item_id,
                "current_available": None,
                "projected_after_adjust": None,
            })

            if variant is None and ref not in missing_rows:
                missing_rows.append(ref)
            if ref in seen_refs and ref not in duplicate_rows:
                duplicate_rows.append(ref)
            if ref not in seen_refs:
                seen_refs[ref] = index

        unique_location_ids = sorted(set(location_ids))
        unique_channel_ids = sorted(set(channel_ids))
        target_location_id = unique_location_ids[0] if len(unique_location_ids) == 1 else None
        stock = {}
        stock_error = False
        if target_location_id and matched_item_ids:
            # inventoryLevel expects the Shopify global id, not the bare number.
            stock_gid = (
                target_location_id
                if target_location_id.startswith("gid://")
                else f"gid://shopify/Location/{target_location_id}"
            )
            stock, stock_error = get_available_quantities_at_location(
                matched_item_ids, stock_gid, store_id=store_id
            )
        for detail in rows_detail:
            item_id = detail["inventory_item_id"]
            quantity = detail["quantity_number"]
            if stock_error:
                # The query failed: do not invent a current quantity.
                current = None
                detail["stock_status"] = "unavailable"
            elif item_id and item_id in stock:
                raw_current = stock[item_id]
                # No inventory level at the target yet means the sync will
                # activate it at 0 and then apply the delta.
                current = 0 if raw_current is None else raw_current
                detail["stock_status"] = "not_stocked" if raw_current is None else "ok"
            else:
                current = 0
                detail["stock_status"] = "not_stocked" if item_id else "unavailable"

            detail["current_available"] = current
            if quantity is None:
                detail["change"] = "—"
            else:
                qty_text = str(int(quantity)) if float(quantity).is_integer() else str(quantity)
                detail["change"] = f"+{qty_text}" if quantity > 0 else qty_text
            detail["projected_after_adjust"] = (
                current + quantity if current is not None and quantity is not None else None
            )

        warnings = []

        def warn(message, level="warning"):
            warnings.append({"level": level, "message": message})

        if unique_location_ids:
            known_locations = [lid for lid in unique_location_ids if lid in location_names]
            if locations:
                for lid in unique_location_ids:
                    if lid not in location_names:
                        warn(f"Location {lid} was not found in this store.")
            if len(unique_location_ids) > 1:
                warn(
                    "The file targets "
                    f"{len(unique_location_ids)} different locations: "
                    f"{', '.join(unique_location_ids)}. Sync will be refused.",
                    "error",
                )
            elif len(known_locations) == 1:
                warn(
                    f"Target location: {location_names[known_locations[0]]} "
                    f"({known_locations[0]}).",
                    "info",
                )
        else:
            warn("No location ID was found in the file.", "error")

        if locations and channel_ids:
            for cid in unique_channel_ids:
                if cid not in channel_names:
                    warn(f"Sale channel {cid} was not found in this store.")

        for ref, count in sorted(variant_match_counts.items()):
            if count > 1:
                warn(f"'{ref}' matches {count} Shopify variants; the first one will be used.")

        zero_rows = sum(1 for d in rows_detail if d["quantity_number"] == 0)
        negative_rows = sum(1 for d in rows_detail if (d["quantity_number"] or 0) < 0)
        invalid_rows = sum(1 for d in rows_detail if d["quantity_number"] is None)
        if zero_rows:
            warn(f"{zero_rows} row(s) have a quantity of 0.")
        if negative_rows:
            warn(f"{negative_rows} row(s) have a negative quantity (stock will be subtracted).")
        if invalid_rows:
            warn(f"{invalid_rows} row(s) have a missing or non-numeric quantity.")

        if stock_error:
            warn("Current stock could not be read from Shopify; 'Before/After' is unavailable.")

        quantities = [d["quantity_number"] for d in rows_detail if d["quantity_number"] is not None]
        total_quantity = float(sum(quantities)) if quantities else 0.0
        summary = {
            "rows": len(rows_detail),
            "unique_references": len(set(prod_reference)),
            "identifier_type": identifier_type,
            "matched": sum(1 for d in rows_detail if d["matched"]),
            "missing": len(missing_rows),
            "duplicates": len(duplicate_rows),
            "total_quantity": int(total_quantity) if total_quantity.is_integer() else round(total_quantity, 2),
            "zero_quantity_rows": zero_rows,
            "negative_quantity_rows": negative_rows,
            "invalid_quantity_rows": invalid_rows,
        }
        target = {
            "location_column": location_col,
            "location_ids": [
                {"id": lid, "name": location_names.get(lid, ""), "known": lid in location_names}
                for lid in unique_location_ids
            ],
            "single_location": len(unique_location_ids) == 1,
            "sale_channel_column": channel_col,
            "sale_channels": [
                {"id": cid, "name": channel_names.get(cid, ""), "known": cid in channel_names}
                for cid in unique_channel_ids
            ],
        }

        ready_to_sync = not missing_rows and not duplicate_rows
        return _check_payload(
            filename, df.columns, has_location_in_file, has_sale_channel_in_file,
            ready_to_sync,
            "File is ready to sync!" if ready_to_sync
            else f"File has {len(missing_rows)} missing SKUs and {len(duplicate_rows)} duplicate SKUs.",
            total_skus=len(data_records),
            identifier_type=identifier_type,
            missing_rows=missing_rows,
            duplicate_rows=duplicate_rows,
            summary=summary,
            target=target,
            warnings=warnings,
            rows=rows_detail,
            preview=rows_detail[:20],
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error checking file: {e}")


@router.post("/update-file/{filename}")
async def update_file_with_data(
    request: Request,
    filename: str = Path(..., description="The name of the file to update"),
    location_id: str = Form(None, description="The location ID to add to the file"),
    sale_channel: str = Form(None, description="The sale channel to add to the file")
):
    """Add missing location_id and sale_channel columns to the file"""
    store_name = get_current_store_name(request)
    if not store_name:
        raise HTTPException(status_code=400, detail="No store selected. Please select a store.")
    resources_dir = os.path.join(PROJECT_ROOT, "resources", store_name)
    file_path = os.path.join(resources_dir, filename)

    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="File not found")

    try:
        # Read the file
        if filename.lower().endswith('.csv'):
            df = pd.read_csv(file_path)
        elif filename.lower().endswith(('.xls', '.xlsx')):
            df = pd.read_excel(file_path)
        else:
            raise HTTPException(status_code=400, detail="Unsupported file type")
        
        # Convert all column names to lowercase and normalize (remove accents)
        df.columns = [normalize_text(col) for col in df.columns.str.lower()]
        
        # Apply UI-supplied values. An explicit value overwrites an existing
        # column instead of being silently ignored.
        location_action = "unchanged"
        previous_locations = []
        if location_id:
            df, location_action, previous_locations = _apply_requested_column_value(
                df, LOCATION_COLUMNS, "id sede", location_id
            )
        location_column = next((c for c in LOCATION_COLUMNS if c in df.columns), None)

        sale_channel_action = "unchanged"
        previous_sale_channels = []
        if sale_channel:
            df, sale_channel_action, previous_sale_channels = _apply_requested_column_value(
                df, SALE_CHANNEL_COLUMNS, "canale di vendita", sale_channel
            )
        sale_channel_column = next((c for c in SALE_CHANNEL_COLUMNS if c in df.columns), None)

        # Save the updated file
        if filename.lower().endswith('.csv'):
            df.to_csv(file_path, index=False)
        elif filename.lower().endswith(('.xls', '.xlsx')):
            df.to_excel(file_path, index=False, engine='openpyxl')
        
        return {
            "detail": f"File '{filename}' updated successfully",
            "added_columns": {
                "location_id": location_id if location_action in ("added", "overwritten") else None,
                "sale_channel": sale_channel if sale_channel_action in ("added", "overwritten") else None,
            },
            "location_column": {
                "name": location_column,
                "action": location_action,
                "previous_values": previous_locations,
            },
            "sale_channel_column": {
                "name": sale_channel_column,
                "action": sale_channel_action,
                "previous_values": previous_sale_channels,
            },
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error updating file: {e}")


@router.post("/sync/{filename}")
async def sync_file(
    request: Request,
    filename: str = Path(..., description="The name of the file to sync"),
    sync_mode: str = Form("adjust", description="Sync mode: tabula_rasa, adjust, or replace")
):
    store_name = get_current_store_name(request)
    if not store_name:
        raise HTTPException(status_code=400, detail="No store selected. Please select a store.")
    
    # Get store_id from header
    store_id = request.headers.get("X-Selected-Store")
    if not store_id:
        raise HTTPException(status_code=400, detail="No store selected. Please select a store.")
    
    resources_dir = os.path.join(PROJECT_ROOT, "resources", store_name)

    # if _is_done_file(filename):
    #     raise HTTPException(
    #         status_code=400,
    #         detail="This file is already marked as DONE and cannot be synced again.",
    #     )

    file_path = os.path.join(resources_dir, filename)

    if not os.path.isfile(file_path):
        raise HTTPException(status_code=404, detail="File not found")

    async def event_generator():
        try:
            # Use pandas to read the file based on extension
            if filename.lower().endswith('.csv'):
                df = pd.read_csv(file_path)
            elif filename.lower().endswith(('.xls', '.xlsx')):
                df = pd.read_excel(file_path)
            else:
                yield f"data: {json.dumps({'type': 'error', 'error': 'Unsupported file type'})}\n\n"
                return
            
            # Transform all column headers to lowercase
            df.columns = df.columns.str.lower()
            
            # Normalize column names: remove accents
            df.columns = [normalize_text(col) for col in df.columns]
            
            print(f"DEBUG: DataFrame columns: {df.columns.tolist()}")
            print(f"DEBUG: DataFrame shape: {df.shape}")
            print(f"DEBUG: First row: {df.iloc[0].to_dict() if len(df) > 0 else 'Empty DataFrame'}")
            print(f"DEBUG: Sync mode: {sync_mode}")
            
            # Pass data to the sync function with store_id and sync_mode
            data_records = df.to_dict(orient="records")
            total_records = len(data_records)
            
            yield f"data: {json.dumps({'type': 'start', 'total': total_records, 'mode': sync_mode})}\n\n"
            await asyncio.sleep(0.01)
            
            print(f"DEBUG: Calling get_product_variants_and_sync with {len(data_records)} records, store_id: {store_id}, mode: {sync_mode}")
            
            # Yield progress messages
            yield f"data: {json.dumps({'type': 'status', 'message': f'📦 Loading {total_records} items from file...'})}\n\n"
            await asyncio.sleep(0.1)
            
            yield f"data: {json.dumps({'type': 'status', 'message': '🔍 Searching Shopify catalog...'})}\n\n"
            await asyncio.sleep(0.1)
            
            # Call sync synchronously (in a thread to avoid blocking)
            import concurrent.futures
            import time
            with concurrent.futures.ThreadPoolExecutor() as executor:
                future = executor.submit(
                    get_product_variants_and_sync,
                    data_records,
                    store_id,
                    sync_mode,
                    store_name,
                    filename,
                )
                
                # Show progress while waiting
                start_time = time.time()
                while not future.done():
                    elapsed = int(time.time() - start_time)
                    if elapsed > 0 and elapsed % 3 == 0:
                        yield f"data: {json.dumps({'type': 'status', 'message': f'⚙️ Processing products... ({elapsed}s elapsed)'})}\n\n"
                    await asyncio.sleep(0.5)
                
                # Wait for completion
                sync_result, missing_rows, duplicate_rows, found_refs, backup_id = future.result()
            
            print(f"DEBUG: Sync completed. Result: {type(sync_result)}, Missing: {len(missing_rows)}, Found: {len(found_refs)}")

            completed_filename = None
            has_sync_error = isinstance(sync_result, dict) and bool(sync_result.get("error"))
            sync_error_message = sync_result.get("error") if has_sync_error else None
            sync_success = bool(sync_result) and not missing_rows and not duplicate_rows and not has_sync_error

            if sync_success:
                try:
                    completed_filename = _mark_file_as_done(resources_dir, filename)
                    if completed_filename != filename:
                        yield f"data: {json.dumps({'type': 'status', 'message': f'🏁 File marked as DONE: {completed_filename}'})}\n\n"
                        await asyncio.sleep(0.1)
                except Exception as rename_error:
                    print(f"ERROR: Could not mark file as DONE: {rename_error}")
            
            # Show completion progress
            if sync_result:
                yield f"data: {json.dumps({'type': 'status', 'message': f'✅ Matched {len(found_refs)} products in Shopify'})}\n\n"
                await asyncio.sleep(0.1)
                
                mode_messages = {
                    'adjust': '📊 Adjusting inventory quantities...',
                    'replace': '🔄 Replacing inventory quantities...',
                    'tabula_rasa': '🗑️ Resetting inventory to zero, then applying new quantities...'
                }
                yield f"data: {json.dumps({'type': 'status', 'message': mode_messages.get(sync_mode, '📝 Updating inventory...')})}\n\n"
                await asyncio.sleep(0.1)
                
                yield f"data: {json.dumps({'type': 'status', 'message': '💾 Saving changes to Shopify...'})}\n\n"
                await asyncio.sleep(0.1)
            
            # Send final result
            if sync_success:
                final_detail = f"File '{completed_filename or filename}' syncing completed. Marked as DONE."
            elif has_sync_error:
                final_detail = f"Sync failed for '{filename}': {sync_error_message}"
            elif missing_rows or duplicate_rows:
                final_detail = f"Matching variants found missing in '{filename}'"
            else:
                final_detail = f"File '{filename}' sync completed with warnings."

            result_data = {
                'type': 'complete',
                'success': sync_success,
                'status': 'success' if sync_success else ('failed' if has_sync_error else 'warning'),
                'error': sync_error_message,
                'detail': final_detail,
                'total_records': total_records,
                'sync_mode': sync_mode,
                'data': sync_result,
                'missing_rows': missing_rows,
                'duplicate_rows': duplicate_rows,
                'found_refs': list(found_refs) if found_refs else [],
                'completed_filename': completed_filename,
                'backup_id': backup_id,
            }
            yield f"data: {json.dumps(result_data)}\n\n"
            
        except Exception as e:
            print(f"ERROR: Exception in sync_file: {str(e)}")
            print(f"ERROR: Exception type: {type(e)}")
            import traceback
            print(f"ERROR: Traceback: {traceback.format_exc()}")
            yield f"data: {json.dumps({'type': 'error', 'error': str(e)})}\n\n"
    
    return StreamingResponse(event_generator(), media_type="text/event-stream")


async def sync_with_progress(data_rows, store_id, sync_mode, event_generator_callback=None):
    """Wrapper around get_product_variants_and_sync that provides progress updates"""
    # This is a temporary solution - ideally we'd refactor get_product_variants_and_sync to be async
    # For now, we'll just call it synchronously
    return get_product_variants_and_sync(data_rows, store_id=store_id, sync_mode=sync_mode)
    

def _get_store_backup_context(request: Request) -> tuple[str, str]:
    """Resolve the filesystem store folder and the Shopify store id."""
    store_name = get_current_store_name(request)
    store_id = get_current_store_id(request)
    if not store_name or not store_id:
        raise HTTPException(status_code=400, detail="No store selected. Please select a store.")
    try:
        backups_dir(store_name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return store_name, store_id


def _backup_with_current_quantities(backup: dict, store_id: str) -> dict:
    """Enrich a snapshot with the live quantity and the delta needed to restore."""
    enriched = dict(backup)
    entries = [dict(entry) for entry in (backup.get("items") or [])]
    loc_groups: dict[str, set] = {}
    for entry in entries:
        loc = entry.get("location_id")
        item = entry.get("inventory_item_id")
        if loc and item:
            loc_groups.setdefault(loc, set()).add(item)

    current = {}
    read_error = False
    for loc, item_ids in loc_groups.items():
        stock, error = get_available_quantities_at_location(
            sorted(item_ids), loc, store_id=store_id
        )
        current[loc] = stock
        read_error = read_error or error

    for entry in entries:
        loc = entry.get("location_id")
        item = entry.get("inventory_item_id")
        live = current.get(loc, {}).get(item)
        entry["current_quantity"] = live
        target = entry.get("before_quantity")
        target_value = 0 if target is None else target
        entry["target_quantity"] = target_value
        entry["delta_to_restore"] = target_value - (0 if live is None else live)
        entry["current_unstocked"] = live is None

    enriched["items"] = entries
    enriched["current_read_ok"] = not read_error
    return enriched


def _restore_error(status_code: int, message: str, details=None, **extra) -> JSONResponse:
    """Build a restore error visible in both the UI and the server console.

    The UI historically read FastAPI's ``detail`` key while restore errors use
    ``error``. Emitting both, plus a console line, prevents silent failures.
    """
    print(f"RESTORE ERROR ({status_code}): {message}")
    if details is not None:
        print(f"RESTORE ERROR DETAILS: {details}")
    content = {
        "success": False,
        "error": message,
        "detail": message,
    }
    if details is not None:
        content["details"] = details
    content.update(extra)
    return JSONResponse(status_code=status_code, content=content)


@router.get("/backups")
async def list_quantity_backups(request: Request):
    store_name, _ = _get_store_backup_context(request)
    return {"backups": list_backups(store_name)}


@router.get("/backups/{backup_id}")
async def get_quantity_backup(backup_id: str, request: Request):
    store_name, store_id = _get_store_backup_context(request)
    try:
        validate_backup_id(backup_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    backup = load_backup(store_name, backup_id)
    if not backup:
        raise HTTPException(status_code=404, detail="Backup not found")
    return _backup_with_current_quantities(backup, store_id)


@router.post("/backups/{backup_id}/restore")
async def restore_quantity_backup(
    backup_id: str, request: Request, payload: dict | None = Body(default=None)
):
    store_name, store_id = _get_store_backup_context(request)
    try:
        validate_backup_id(backup_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    backup = load_backup(store_name, backup_id)
    if not backup:
        raise HTTPException(status_code=404, detail="Backup not found")

    body = payload or {}
    requested_refs = body.get("references")
    if requested_refs is not None and not isinstance(requested_refs, list):
        raise HTTPException(status_code=400, detail="references must be a list")

    entries = list(backup.get("items") or [])
    if requested_refs is not None:
        wanted = set(requested_refs)
        entries = [e for e in entries if e.get("reference") in wanted]
    if not entries:
        raise HTTPException(status_code=400, detail="No matching items in this backup")

    enriched = _backup_with_current_quantities(backup, store_id)
    selected = [
        e for e in enriched["items"]
        if requested_refs is None or e.get("reference") in set(requested_refs)
    ]
    if not enriched.get("current_read_ok"):
        return _restore_error(
            400, "Cannot restore: Shopify stock could not be read. Try again."
        )

    # Snapshot the pre-restore state so this restore is itself undoable.
    undo_items = [
        {
            "reference": e.get("reference"),
            "inventory_item_id": e.get("inventory_item_id"),
            "location_id": e.get("location_id"),
            "variant_name": e.get("variant_name"),
            "before_quantity": e.get("current_quantity"),
            "was_stocked": not e.get("current_unstocked", False),
            "stock_read_ok": True,
        }
        for e in selected
    ]
    try:
        new_backup_id = create_backup(
            store_name,
            source_file=f"restore of {backup_id}",
            sync_mode="restore",
            location=backup.get("location"),
            items=undo_items,
        )
    except Exception as exc:
        print(f"RESTORE ERROR: could not create restore backup\n{traceback.format_exc()}")
        return _restore_error(
            500, f"Could not create restore backup: {exc}"
        )

    targets = [
        {
            "inventoryItemId": e.get("inventory_item_id"),
            "locationId": e.get("location_id"),
            "quantity": e.get("target_quantity"),
        }
        for e in selected
        if e.get("inventory_item_id") and e.get("location_id")
    ]
    result = set_quantities_to_values(targets, store_id=store_id)
    if isinstance(result, dict) and result.get("error"):
        return _restore_error(
            400,
            result["error"],
            details=result.get("details"),
            restore_backup_id=new_backup_id,
        )

    return {
        "success": True,
        "restored_count": len(targets),
        "unchanged": (result or {}).get("unchanged", []),
        "final_quantities": (result or {}).get("final_quantities", {}),
        "restore_backup_id": new_backup_id,
    }


@router.post("/uploadFile")
async def upload_file(request: Request, file: UploadFile = File(...)):
    store_name = get_current_store_name(request)
    if not store_name:
        raise HTTPException(status_code=400, detail="No store selected. Please select a store.")
    resources_dir = os.path.join(PROJECT_ROOT, "resources", store_name)
    
    if file and file.filename:
        # Ensure resources directory exists at project root
        os.makedirs(resources_dir, exist_ok=True)

        # Create new filename with date
        date_str = datetime.now().strftime("%d-%m-%Y_%H-%M-%S")
        filename, ext = os.path.splitext(file.filename)
        new_filename = f"{filename}_{date_str}{ext}".lower()
        file_path = os.path.join(resources_dir, new_filename)

        # Save file
        with open(file_path, "wb") as buffer:
            buffer.write(await file.read())

        return {"type": "categories", "filename": new_filename}

    raise HTTPException(status_code=400, detail="No file uploaded")