from app.utilities.shopify import (
    add_to_sale_channels, 
    adjust_quantity_to_variant, 
    get_available_quantities_at_location,
    get_product_variants_by_identifier, 
    get_store_locations,
    set_activate_quantity_on_location,
    detect_identifier_type,
    set_fixed_quantity_to_variant
)
from app.utilities.backups import create_backup
from app.utilities.logger import create_sync_logger
import pandas as pd


def _normalize_reference_value(value) -> str:
    """
    Normalize a reference value (barcode/sku) to a consistent string format.
    Handles NaN, None, float, and string values.
    """
    if pd.isna(value) or value is None:
        return "EMPTY_SKU"
    elif isinstance(value, float):
        return str(int(value)) if value == int(value) else str(value)
    else:
        return str(value)


def _normalize_location_id(value) -> str | None:
    """Normalize a location id cell to the numeric string Shopify expects."""
    if value is None or pd.isna(value):
        return None
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    text = str(value).strip()
    # pandas turns an int column into floats as soon as one cell is empty
    if text.endswith(".0") and text[:-2].isdigit():
        return text[:-2]
    return text or None


def _collect_location_ids(data_rows: list) -> list[str | None]:
    """Read the target location from every row, tolerating the supported column names."""
    return [
        _normalize_location_id(row.get("id sede") or row.get("location_id") or row.get("location"))
        for row in data_rows
    ]


def _extract_reference_from_row(row: dict, identifier_type: str) -> str:
    """Extract and normalize the reference value from a data row."""
    if identifier_type == "barcode":
        val = row.get("barcode")
    else:
        val = row.get("sku")
    return _normalize_reference_value(val)


def _build_variant_map(product_variants: list, identifier_type: str) -> tuple[dict, set]:
    """
    Build a mapping of variants by their reference (barcode or sku).
    Returns: (variant_map, found_refs)
    """
    variant_map = {}
    found_refs = set()
    
    for variant in product_variants:
        val = variant.get(identifier_type)
        if val:
            ref = _normalize_reference_value(val)
            variant_map[ref] = variant
            found_refs.add(ref)
    
    return variant_map, found_refs


def _detect_missing_and_duplicates(data_rows: list, found_refs: set, identifier_type: str) -> tuple[list, list]:
    """
    Detect missing and duplicate references in data rows.
    Returns: (missing_rows, duplicate_rows)
    """
    missing_rows = []
    duplicate_rows = []
    seen_refs = {}
    
    for i, row in enumerate(data_rows):
        row_ref = _extract_reference_from_row(row, identifier_type)
        
        # Check if missing (not found in Shopify)
        if row_ref not in found_refs and row_ref not in missing_rows:
            missing_rows.append(row_ref)
        
        # Check if duplicate (appears multiple times in file)
        if row_ref in seen_refs and row_ref not in duplicate_rows:
            duplicate_rows.append(row_ref)
        
        if row_ref not in seen_refs:
            seen_refs[row_ref] = i
    
    return missing_rows, duplicate_rows


def _normalize_sale_channel_ids(value) -> list[str]:
    """Normalize sale channel input (int/str/list/comma-separated) into IDs."""
    if value is None:
        return []
    try:
        if pd.isna(value):
            return []
    except Exception:
        pass
    if isinstance(value, (list, tuple, set)):
        items = []
        for v in value:
            items.extend(_normalize_sale_channel_ids(v))
    elif isinstance(value, int):
        items = [str(value)]
    elif isinstance(value, float):
        items = [str(int(value))] if value.is_integer() else [str(value)]
    else:
        text = str(value).strip()
        if not text:
            return []
        items = [p.strip() for p in text.replace(";", ",").split(",") if p.strip()]

    out = []
    seen = set()
    for item in items:
        if item.startswith("gid://"):
            item = item.rsplit("/", 1)[-1]
        if item.endswith(".0") and item[:-2].isdigit():
            item = item[:-2]
        if item and item not in seen:
            seen.add(item)
            out.append(item)
    return out


def get_product_variants_and_sync(
    data_rows,
    store_id: str = None,
    sync_mode: str = "adjust",
    log_store_name: str = None,
    source_file: str = None,
    default_location_id: str = None,
    default_sale_channels: list[str] | str | None = None,
) -> tuple:
    
    # Initialize logger for this sync operation
    logger = create_sync_logger(store_name=log_store_name or store_id or "unknown_store")
    logger.log_sync_start(total_rows=len(data_rows), sync_mode=sync_mode)
    
    print(f"DEBUG: Starting sync with {len(data_rows)} rows for store: {store_id}, mode: {sync_mode}")
    
    # Determine identifier type - prioritize explicit field presence
    use_barcode = "barcode" in data_rows[0] if data_rows else False
    if use_barcode:
        identifier_type = "barcode"
    else:
        # Auto-detect based on content if SKU field is present
        temp_references = [_extract_reference_from_row(row, "sku") for row in data_rows[:100]]  # Sample first 100
        identifier_type = detect_identifier_type(temp_references)
    
    # Extract all references from data rows using helper function
    prod_reference = [_extract_reference_from_row(row, identifier_type) for row in data_rows]

    print(f"DEBUG: Extracted {len(prod_reference)} references")
    print(f"DEBUG: Unique references: {len(set(prod_reference))}")
    logger.info(f"Using {identifier_type} for product search")

    default_location_id = _normalize_location_id(default_location_id)
    default_sale_channel_ids = _normalize_sale_channel_ids(default_sale_channels)

    # Fail loudly on mixed-location files instead of writing quantities to
    # locations the user never asked for (e.g. Nippon/Cortina instead of Napoli).
    row_location_ids = _collect_location_ids(data_rows)
    target_locations = sorted({loc for loc in row_location_ids if loc})
    if len(target_locations) > 1:
        raise ValueError(
            "The file contains more than one location "
            f"({', '.join(target_locations)}). Refusing to sync a mixed-location file."
        )
    if not target_locations and default_location_id:
        target_locations = [default_location_id]
    if target_locations:
        logger.info(f"Target location: {', '.join(target_locations)}")
    else:
        logger.warning("No location IDs found in the file or global settings; rows without a location will be skipped")
    if default_sale_channel_ids:
        logger.info(f"Global sale channels default: {', '.join(default_sale_channel_ids)}")

    product_variants = get_product_variants_by_identifier(prod_reference, identifier_type, store_id=store_id)
    
    print(f"DEBUG: Found {len(product_variants) if product_variants else 0} variants from Shopify")
    logger.info(f"Found {len(product_variants) if product_variants else 0} variants from Shopify")
    
    if not product_variants:
        print("DEBUG: No variants found, returning early")
        logger.error("No variants found in Shopify matching the provided references")
        return [], prod_reference, [], [], None
    
    # Build variant mapping and find all existing references using helper function
    variant_map, found_refs = _build_variant_map(product_variants, identifier_type)
    
    # Detect missing and duplicate rows using helper function
    missing_rows, duplicate_rows = _detect_missing_and_duplicates(data_rows, found_refs, identifier_type)
    
    print(f"DEBUG: prod_reference types: {[type(ref).__name__ for ref in prod_reference[:3]]}")
    print(f"DEBUG: found_refs types: {[type(ref).__name__ for ref in list(found_refs)[:3]]}")
    print(f"DEBUG: Missing rows: {len(missing_rows)}")
    print(f"DEBUG: Duplicate rows: {len(duplicate_rows)}")
    print(f"DEBUG: Missing unique SKUs: {len(set(prod_reference) - found_refs)}")
    print(f"DEBUG: Found references: {len(found_refs)}")
    
    # Log missing and duplicate items
    logger.log_missing_items(missing_rows)
    logger.log_duplicate_items(duplicate_rows)

    # Capture a durable snapshot of every affected quantity BEFORE any write.
    # This is the undo point used by the restore flow; it must be written even
    # if a later activation or mutation fails.
    backup_id = None
    before_stock = {}
    if not missing_rows and not duplicate_rows:
        planned_entries = []
        for i, row in enumerate(data_rows):
            row_ref = _extract_reference_from_row(row, identifier_type)
            location_id = row_location_ids[i] or default_location_id
            if row_ref not in variant_map or not location_id:
                continue
            variant = variant_map[row_ref]
            item_id = (variant.get("inventoryItem") or {}).get("id")
            if not item_id:
                continue
            loc_gid = f"gid://shopify/Location/{location_id}"
            planned_entries.append({
                "reference": row_ref,
                "inventory_item_id": item_id,
                "variant_id": variant.get("id"),
                "variant_name": variant.get("title"),
                "sku": variant.get("sku"),
                "barcode": variant.get("barcode"),
                "location_id": loc_gid,
                "requested_quantity": row.get("qta"),
                "sync_mode": sync_mode,
            })

        read_errors = set()
        for loc in sorted({e["location_id"] for e in planned_entries}):
            ids = [
                e["inventory_item_id"] for e in planned_entries
                if e["location_id"] == loc
            ]
            stock, error = get_available_quantities_at_location(
                ids, loc, store_id=store_id
            )
            before_stock[loc] = stock
            if error:
                read_errors.add(loc)
                logger.warning(f"Could not read pre-sync stock at {loc}; backup quantities unknown")

        if planned_entries:
            location_names = {}
            try:
                for loc_info in get_store_locations(store_id=store_id):
                    location_names[loc_info.get("id")] = loc_info.get("name")
            except Exception as exc:
                logger.warning(f"Could not resolve location names for backup: {exc}")

            primary_location = planned_entries[0]["location_id"]
            entries = []
            for entry in planned_entries:
                quantity = before_stock.get(entry["location_id"], {}).get(
                    entry["inventory_item_id"]
                )
                entries.append({
                    **entry,
                    "before_quantity": quantity,
                    "was_stocked": quantity is not None,
                    "stock_read_ok": entry["location_id"] not in read_errors,
                })

            try:
                backup_id = create_backup(
                    log_store_name or store_id or "unknown_store",
                    source_file=source_file or "(unknown file)",
                    sync_mode=sync_mode,
                    location={
                        "id": primary_location,
                        "name": location_names.get(primary_location),
                    },
                    items=entries,
                )
                logger.info(f"Pre-sync quantity backup saved: {backup_id}")
            except Exception as exc:
                logger.error(f"Could not save pre-sync quantity backup: {exc}")

    inventories = []
    result = None
    
    # Process each row and match with variants efficiently
    for i, row in enumerate(data_rows):
        print(f"DEBUG: Processing row {i+1}/{len(data_rows)} with data: {row["sku"] if "sku" in row else row.get("barcode", "N/A")}")
        
        # Extract reference using helper function
        row_ref = _extract_reference_from_row(row, identifier_type)
        
        if row_ref in variant_map:
            variant = variant_map[row_ref]
            publications = []
            
            inventory_item = variant["inventoryItem"]["id"]
            
            # Use the validated, normalized location id collected above, or global default.
            location_id = row_location_ids[i] or default_location_id
            if location_id:
                location_id_full = f"gid://shopify/Location/{location_id}"
            else:
                warning_msg = f"No location ID found for row {row_ref}"
                print(f"WARNING: {warning_msg}")
                logger.warning(warning_msg)
                continue
            
            delta_quantity = row.get("qta") if "qta" in row else row.get("quantity")
            
            # Get sale channel from row; fallback to global defaults when missing.
            row_sale_channel = row.get("canali di vendita") or row.get("canale di vendita") or row.get("sale_channel")
            sale_channel_list = _normalize_sale_channel_ids(row_sale_channel)
            if not sale_channel_list and default_sale_channel_ids:
                sale_channel_list = list(default_sale_channel_ids)
            if not sale_channel_list:
                warning_msg = f"No sale channel found for row {row_ref}"
                print(f"WARNING: {warning_msg}")
                logger.warning(warning_msg)
            
            for sale_channel_item in sale_channel_list:
                publications.append({
                    "publicationId": f"gid://shopify/Publication/{sale_channel_item}"
                })
                    
            # Only execute Shopify operations if no variants are missing
            if not missing_rows and not duplicate_rows:
                if publications:
                    add_to_sale_channels(
                        resource_id=variant["product"]["id"],
                        channels=publications,
                        store_id=store_id
                    )
                activation = set_activate_quantity_on_location(
                    inventoryItemId=inventory_item,
                    locationId=location_id_full,
                    store_id=store_id,
                )
                if isinstance(activation, dict) and activation.get("error"):
                    raise ValueError(
                        f"Cannot sync row {i + 1} ({row_ref}): {activation['error']}"
                    )

                # Build inventory update based on sync_mode
                if sync_mode == "adjust":
                    # Adjust: add/subtract from existing quantity
                    inventories.append({
                        "delta": delta_quantity,
                        "inventoryItemId": inventory_item,
                        "locationId": location_id_full,
                        "changeFromQuantity": None
                    })
                elif sync_mode == "replace":
                    # Replace: set to exact quantity from file
                    inventories.append({
                        "quantity": delta_quantity,
                        "inventoryItemId": inventory_item,
                        "locationId": location_id_full,
                        "changeFromQuantity": None
                    })
                elif sync_mode == "tabula_rasa":
                    # Tabula Rasa: set to 0 (will be handled separately)
                    inventories.append({
                        "quantity": 0,
                        "inventoryItemId": inventory_item,
                        "locationId": location_id_full,
                        "changeFromQuantity": None
                    })
        

    # Only adjust quantities if no variants are missing
    if not missing_rows and not duplicate_rows and inventories:
        print(f"DEBUG: Updating quantities for {len(inventories)} inventory items using mode: {sync_mode}")
        logger.info(f"Updating quantities for {len(inventories)} inventory items using mode: {sync_mode}")
        
        try:
            if sync_mode == "adjust":
                # Use delta-based adjustment
                logger.info("Executing adjust sync mode (delta-based)")
                # Do not reuse the backup snapshot here: it was taken before
                # activation, while verification must read the stock that the
                # adjustment will actually be applied to (after activation).
                result = adjust_quantity_to_variant(
                    inventories=inventories,
                    store_id=store_id,
                )
                if isinstance(result, dict) and result.get("error"):
                    logger.error(f"Inventory adjustment failed: {result['error']}")
                else:
                    logger.success(f"Successfully adjusted quantities for {len(inventories)} items")
            elif sync_mode == "replace":
                # Set to exact quantities
                logger.info("Executing replace sync mode (exact quantities)")
                # result = set_fixed_quantity_to_variant(inventories=inventories, store_id=store_id)
                result = {
                    "changes": [],
                    "createdAt": pd.Timestamp.now().isoformat(),
                    "reason": "correction",
                    "error": "The 'replace' sync mode is currently a placeholder and needs to be implemented with the actual GraphQL mutation to set fixed quantities in Shopify."
                }
                logger.warning("Replace mode is not yet implemented")
            elif sync_mode == "tabula_rasa":
                # First set all to 0, then set to file quantities
                logger.info("Executing tabula_rasa sync mode (reset and set)")
                # result = set_fixed_quantity_to_variant(inventories=inventories, store_id=store_id)
                # Now build new inventory with actual quantities and set them
                # new_inventories = []
                # for i, row in enumerate(data_rows):
                #     if identifier_type == "barcode":
                #         val = row.get("barcode")
                #     else:
                #         val = row.get("sku")
                    
                #     # Convert to string with proper handling
                #     if pd.isna(val) or val is None:
                #         row_ref = "EMPTY_SKU"
                #     elif isinstance(val, float):
                #         row_ref = str(int(val)) if val == int(val) else str(val)
                #     else:
                #         row_ref = str(val)
                    
                #     if row_ref in variant_map:
                #         variant = variant_map[row_ref]
                #         inventory_item = variant["inventoryItem"]["id"]
                #         row_location_id = row.get("id sede") or row.get("location_id") or row.get("location")
                #         if row_location_id:
                #             location_id_full = f"gid://shopify/Location/{row_location_id}"
                #             new_inventories.append({
                #                 "quantity": row["qta"],
                #                 "inventoryItemId": inventory_item,
                #                 "locationId": location_id_full
                #             })
                # if new_inventories:
                #     result = set_fixed_quantity_to_variant(inventories=new_inventories, store_id=store_id)

                result = {
                    "changes": [],
                    "createdAt": pd.Timestamp.now().isoformat(),
                    "reason": "correction",
                    "error": "The 'tabula_rasa' sync mode is currently a placeholder and needs to be implemented with the actual GraphQL mutation to set fixed quantities in Shopify. This mode should first set all quantities to 0, then set to the file quantities in a second step."
                }
                logger.warning("Tabula rasa mode is not yet implemented")
        except Exception as e:
            logger.log_exception(e, context="quantity adjustment")
            result = None
    else:
        if missing_rows:
            logger.error(f"Sync blocked: {len(missing_rows)} missing items found")
        if duplicate_rows:
            logger.error(f"Sync blocked: {len(duplicate_rows)} duplicate items found")
        if not inventories:
            logger.warning("No inventory items to update")
    
    # Parse and save changes to CSV
    if result:
        csv_path = logger.parse_and_save_changes(result, sync_mode)
        if csv_path:
            logger.success(f"Quantity changes saved to: {csv_path}")
    
    # Log summary
    changes_count = 0
    if result and "inventoryAdjustQuantities" in result:
        changes = result["inventoryAdjustQuantities"].get("inventoryAdjustmentGroup", {}).get("changes", [])
        changes_count = len(changes)
    elif result and "changes" in result:
        changes_count = len(result["changes"])
    
    logger.log_sync_summary(
        total_processed=len(data_rows),
        missing_count=len(missing_rows),
        duplicate_count=len(duplicate_rows),
        changes_count=changes_count
    )
        
    return result, missing_rows, duplicate_rows, found_refs, backup_id