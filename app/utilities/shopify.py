import os
import re
import shopify
import json
import asyncio
import toml
import time
import uuid
import urllib.error
from pathlib import Path
from datetime import datetime
from shopify.base import ShopifyConnection

"""
RESOURCE -> https://github.com/Shopify/shopify_python_api
"""

PROJECT_ROOT = Path(__file__).parent.parent.parent

# Shopify rate limits can trigger HTTP 429 (Too Many Requests) responses.
# We retry with exponential backoff (honoring the Retry-After header when present).
GRAPHQL_MAX_RETRIES = 5
GRAPHQL_RETRY_BASE_DELAY = 2  # seconds; doubles per attempt

# Every store falls back to this version when no API version is configured.
DEFAULT_API_VERSION = "2026-01"

# The @idempotent directive is available from 2026-01 and required from 2026-04.
IDEMPOTENT_MIN_API_VERSION = "2026-01"
_VERSION_FORMAT = re.compile(r"^(\d{4})-(\d{2})")


def _api_version_supports_idempotency(api_version: str | None) -> bool:
    """Return True when the given Admin API version accepts the @idempotent directive.

    ``unstable``/``latest`` and unknown values are treated as recent versions, so the
    directive is sent; if the store is actually on an older version the mutation is
    retried without it (see ``_is_idempotent_unsupported_error``).
    """
    if not api_version:
        return True

    version = str(api_version).strip().lower()
    if version in ("unstable", "latest"):
        return True

    match = _VERSION_FORMAT.match(version)
    if not match:
        return True

    normalized = f"{match.group(1)}-{match.group(2)}"
    return normalized >= IDEMPOTENT_MIN_API_VERSION


def _errors_to_text(errors) -> str:
    """Flatten a GraphQL/user errors payload into a lowercase string for matching."""
    if not errors:
        return ""
    if isinstance(errors, str):
        return errors.lower()
    try:
        return json.dumps(errors, default=str).lower()
    except (TypeError, ValueError):
        return str(errors).lower()


def _is_idempotent_required_error(errors) -> bool:
    """Shopify rejected the mutation because @idempotent was missing."""
    text = _errors_to_text(errors)
    return "idempotent" in text and "required" in text


def _is_idempotent_unsupported_error(errors) -> bool:
    """Shopify rejected the @idempotent directive (old API version)."""
    text = _errors_to_text(errors)
    if "idempotent" not in text:
        return False
    return any(
        marker in text
        for marker in ("unknown", "not defined", "not supported", "unsupported", "invalid")
    )


def _first_error_message(errors) -> str:
    """Extract a readable message from a GraphQL error payload."""
    if isinstance(errors, dict):
        return str(errors.get("message") or errors)
    if isinstance(errors, list) and errors:
        first = errors[0]
        if isinstance(first, dict):
            return str(first.get("message") or first)
        return str(first)
    return str(errors)


def _execute_graphql_with_retry(shopify_session, query: str, variables: dict, operation_name: str) -> str:
    """
        Execute a GraphQL query via the Shopify client, retrying on rate-limit (429) responses.
        :param shopify_session: The Shopify API client (shopify module).
        :param query: The graphql query string.
        :param variables: The variables for the GraphQL query.
        :param operation_name: The name of the GraphQL operation.
        :return: The raw GraphQL response body (JSON string).
    """
    attempt = 0
    while True:
        try:
            return shopify_session.GraphQL().execute(
                query=query,
                variables=variables,
                operation_name=operation_name
            )
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < GRAPHQL_MAX_RETRIES:
                delay = GRAPHQL_RETRY_BASE_DELAY * (2 ** attempt)
                try:
                    retry_after = int(e.headers.get("Retry-After") or delay)
                    if retry_after > 0:
                        delay = retry_after
                except (ValueError, TypeError, AttributeError):
                    pass
                print(f"DEBUG: Shopify rate limit exceeded (HTTP 429). Retrying in {delay}s (attempt {attempt + 1}/{GRAPHQL_MAX_RETRIES})")
                time.sleep(delay)
                attempt += 1
                continue
            raise


def get_store_credentials(store_id: str = None) -> dict:
    """
    Get store credentials from SQLite DB based on store_id.
    Falls back to environment variables if store_id is not provided.
    """
    if store_id:
        try:
            from app.database import get_store_credentials as db_get_credentials
            creds = asyncio.run(db_get_credentials(store_id))
            if creds:
                return {
                    "access_token": creds.get("ACCESS_TOKEN"),
                    "base_url": f"{creds.get('STORE_NAME')}.myshopify.com",
                    "api_version": creds.get("API_VERSION") or DEFAULT_API_VERSION
                }
        except Exception as e:
            print(f"DEBUG: DB not available, falling back to TOML: {e}")

    try:
        config = toml.load(PROJECT_ROOT / "config_stores.toml")
        if store_id:
            stores = config.get("stores", {})
            if store_id in stores:
                store_config = stores[store_id]
                return {
                    "access_token": store_config.get("ACCESS_TOKEN"),
                    "base_url": f"{store_config.get('STORE_NAME')}.myshopify.com",
                    "api_version": store_config.get("API_VERSION") or DEFAULT_API_VERSION
                }
    except Exception as e:
        print(f"DEBUG: TOML not available: {e}")

    access_token = os.environ.get("ACCESS_TOKEN")
    store_name = os.environ.get("STORE_NAME")
    if access_token and store_name:
        return {
            "access_token": access_token,
            "base_url": f"{store_name}.myshopify.com",
            "api_version": os.environ.get("API_VERSION") or DEFAULT_API_VERSION
        }
    
    return None

def shopify_connection(credentials: dict = None, store_id: str = None) -> tuple[shopify.Session | None, float]:
    """
        Connect to Shopify API using the provided credentials.
        :param credentials: dict: The credentials for the Shopify API.
        :param store_id: str: The store ID from config (e.g., 'murphy', 'refrigiwear')
        :return:
            - shopify session: The Shopify API client.
            - float: The time taken to establish the connection.
    """
    if credentials:    
        # Extract credentials from the dictionary
        access_token = credentials["access_token"] if "access_token" in credentials else None
        base_url = credentials["base_url"] if "base_url" in credentials else None
        api_version = credentials.get("api_version") or DEFAULT_API_VERSION
    else:
        # Get credentials from config or environment
        creds = get_store_credentials(store_id)
        if not creds:
            return None
        access_token = creds["access_token"]
        base_url = creds["base_url"]
        api_version = creds["api_version"]

    if not access_token or not base_url:
        return None

    try:
        # Initialize the Shopify session
        session = shopify.Session(base_url, api_version, access_token)
        shopify.ShopifyResource.activate_session(session)

        return shopify

    except KeyError as e:
        print(f"Error: {e}")
        return None

def shopify_query_graph(query: str=None, operation_name: str=None, variables: dict|None = None, store_id: str = None, credentials: dict|None = None) -> dict:
    """
        Execute a GraphQL query against the Shopify API.
        :param query: str: the graphql query if operation file is missing
        :param operation_name: str: The name of the GraphQL operation. Must match the name in the GraphQL file.
        :param variables: dict: The variables for the GraphQL query. Default is None.
        :param store_id: str: The store ID from config to use for the connection.
        :param credentials: dict: Optional pre-resolved credentials, so the caller and the
            connection use exactly the same store/API version.

        :return: dict: The response from the Shopify API.
    """
    if not query and not operation_name:
        return{"error": "Missing parameters"}
    
    shopify_session = shopify_connection(credentials=credentials, store_id=store_id)
    
    if shopify_session is None:
        print("ERROR: Failed to establish Shopify connection")
        print(f"DEBUG: store_id: {store_id}")
        return {"error": "Failed to establish Shopify connection. Check store configuration."}
    
    if query is None and operation_name:
        gql_query_path = Path(f"{operation_name}.graphql")
        if gql_query_path.exists():
            gql_query_doc = gql_query_path.read_text()
            response = _execute_graphql_with_retry(shopify_session, gql_query_doc, variables, operation_name)
        else:
            return {"error": f"GraphQL file '{operation_name}.graphql' not found."}
    elif query:
        response = _execute_graphql_with_retry(shopify_session, query, variables, operation_name)
    else:
        return {"error": "No query or operation_name provided."}

    res = json.loads(response)

    # Check if the request was successful
    if res.get("errors"):
        return {"errors": res["errors"]}

    for value in res["data"].values():
        if isinstance(value, dict) and "userErrors" in value and value["userErrors"]:
            return {"errors": value["userErrors"]}

    return res["data"]

def check_product_exists(shopify_session: ShopifyConnection, channel_reference: str, product_reference: str) -> tuple[bool, float]:
    """
        Check if product exists in Shopify.
        :param shopify_session: ShopifyConnection: The Shopify API client.
        :param channel_reference: RetrieveProductDb: The product id to check.
        :param product_reference: str: The product reference (SKU).
        :return: bool: True if the product exists, False otherwise.
    """
    start_time = datetime.now()

    # Logic to check if the product exists in Shopify
    exists = False  # Placeholder for actual existence check logic

    result = shopify_query_graph(
            shopify_session=shopify_session,
            operation_name="CheckProductExists",
            variables={
                "query": f"barcode:{product_reference} AND id:{channel_reference}"
            }
    )

    time_elapsed = (datetime.now() - start_time).total_seconds()
    if result.get("errors"):
        print(f"Error checking product existence: {result.get('errors')}")
        return exists, time_elapsed

    if not result.get("data") and result.get("data").get("products"):
        exists = False

    exists = True
    return exists, time_elapsed

def get_product_variants_by_sku(sku_list: list, store_id: str = None) -> list[dict]:
    gql_query="""#gql
        query GetProductVariantBySku($query: String!, $after: String) {
            productVariants(first: 250, query: $query, after: $after) {
                nodes {
                    id
                    title
                    sku
                    barcode
                    product{
                        id
                    }
                    inventoryItem {
                        id
                    }
                }
                pageInfo {
                    hasNextPage
                    endCursor
                }
            }
        }
    """
    # Shopify search queries have a complexity/length limit, so batch the input list
    QUERY_BATCH_SIZE = 100
    all_variants = []
    total_batches = (len(sku_list) + QUERY_BATCH_SIZE - 1) // QUERY_BATCH_SIZE

    for batch_idx in range(0, len(sku_list), QUERY_BATCH_SIZE):
        batch = sku_list[batch_idx:batch_idx + QUERY_BATCH_SIZE]
        batch_num = (batch_idx // QUERY_BATCH_SIZE) + 1
        print(f"DEBUG: SKU query batch {batch_num}/{total_batches} ({len(batch)} SKUs)")

        if len(batch) == 1:
            query_str = f'sku:"{batch[0].strip()}"'
        else:
            query_str = " OR ".join([f'sku:"{s.strip()}"' for s in batch])

        has_next_page = True
        cursor = None

        while has_next_page:
            gql_variables = {
                "query": query_str,
                "after": cursor
            }
            
            result = shopify_query_graph(
                    query=gql_query,
                    operation_name="GetProductVariantBySku",
                    variables=gql_variables,
                    store_id=store_id
            )
            
            if "error" in result:
                print(f"ERROR in get_product_variants_by_sku: {result['error']}")
                return None
            
            if "errors" in result:
                print(f"ERROR in get_product_variants_by_sku: {result['errors']}")
                return None
                
            if result and "productVariants" in result:
                variants = result["productVariants"]["nodes"]
                all_variants.extend(variants)
                
                page_info = result["productVariants"]["pageInfo"]
                has_next_page = page_info.get("hasNextPage", False)
                cursor = page_info.get("endCursor")
                
                print(f"DEBUG: Fetched {len(variants)} variants, total so far: {len(all_variants)}")
            else:
                break

    print(f"DEBUG: Completed SKU query with total {len(all_variants)} variants found")
    return all_variants

def detect_identifier_type(identifiers: list) -> str:
    """
    Detect whether a list of identifiers are SKUs or barcodes.
    
    :param identifiers: List of product identifiers
    :return: "barcode" if most valid identifiers are numeric, "sku" otherwise
    """
    if not identifiers:
        return "sku"  # Default to SKU if empty list
    
    # Filter out empty/invalid identifiers for detection
    valid_identifiers = [str(i) for i in identifiers if i and str(i) not in ["EMPTY_SKU", "nan", "None"]]
    
    if not valid_identifiers:
        return "sku"  # No valid identifiers, default to SKU
    
    # Count how many are purely numeric
    numeric_count = sum(1 for identifier in valid_identifiers if identifier.isdigit())
    
    # If more than 80% are numeric, treat as barcodes
    if numeric_count / len(valid_identifiers) > 0.8:
        return "barcode"
    else:
        return "sku"

def get_product_variants_by_identifier(identifier_list: list, identifier_type: str = "auto", store_id: str = None) -> list[dict]:
    """
    Get product variants by SKU or barcode with automatic detection or explicit type.
    
    :param identifier_list: List of SKUs or barcodes to search for
    :param identifier_type: Type of identifier - "sku", "barcode", or "auto" for automatic detection
    :param store_id: The store ID from config
    :return: List of product variant nodes
    """
    if not identifier_list:
        return []
    
    # Auto-detect identifier type if not specified
    if identifier_type == "auto":
        identifier_type = detect_identifier_type(identifier_list)
        print(f"DEBUG: Auto-detected identifier type: {identifier_type}")
    
    print(f"DEBUG: Searching for {len(identifier_list)} {identifier_type}s")
    
    # Use the appropriate function based on identifier type
    if identifier_type == "barcode":
        return get_product_variants_by_barcode(identifier_list, store_id=store_id)
    elif identifier_type == "sku":
        return get_product_variants_by_sku(identifier_list, store_id=store_id)
    else:
        raise ValueError(f"Invalid identifier_type: {identifier_type}. Must be 'sku', 'barcode', or 'auto'")

def get_product_variants_by_barcode(barcode_list: list, store_id: str = None) -> list[dict]:
    """ 
        Get product variants by barcode with pagination support.
        Shopify limits to 250 results per query, so we loop until we get all variants.
        :param barcode_list: List of barcodes to search for
        :param store_id: The store ID from config
        :return: List of product variant nodes
    """
    gql_query="""#gql
        query GetProductVariantByBarcode($query: String!, $after: String) {
            productVariants(first: 250, query: $query, after: $after) {
                nodes {
                    id
                    title
                    sku
                    barcode
                    product{
                        id
                    }
                    inventoryItem {
                        id
                    }
                }
                pageInfo {
                    hasNextPage
                    endCursor
                }
            }
        }
    """
    # Shopify search queries have a complexity/length limit, so batch the input list
    QUERY_BATCH_SIZE = 100
    all_variants = []
    total_batches = (len(barcode_list) + QUERY_BATCH_SIZE - 1) // QUERY_BATCH_SIZE

    for batch_idx in range(0, len(barcode_list), QUERY_BATCH_SIZE):
        batch = barcode_list[batch_idx:batch_idx + QUERY_BATCH_SIZE]
        batch_num = (batch_idx // QUERY_BATCH_SIZE) + 1
        print(f"DEBUG: Barcode query batch {batch_num}/{total_batches} ({len(batch)} barcodes)")

        if len(batch) == 1:
            query_str = f'barcode:"{batch[0].strip()}"'
        else:
            query_str = " OR ".join([f'barcode:"{b.strip()}"' for b in batch])

        has_next_page = True
        cursor = None

        while has_next_page:
            gql_variables = {
                "query": query_str,
                "after": cursor
            }
            
            result = shopify_query_graph(
                    query=gql_query,
                    operation_name="GetProductVariantByBarcode",
                    variables=gql_variables,
                    store_id=store_id
            )
            
            if "error" in result:
                print(f"ERROR in get_product_variants_by_barcode: {result['error']}")
                return None
            
            if "errors" in result:
                print(f"ERROR in get_product_variants_by_barcode: {result['errors']}")
                return None
                
            if result and "productVariants" in result:
                variants = result["productVariants"]["nodes"]
                all_variants.extend(variants)
                
                page_info = result["productVariants"]["pageInfo"]
                has_next_page = page_info.get("hasNextPage", False)
                cursor = page_info.get("endCursor")
                
                print(f"DEBUG: Fetched {len(variants)} variants, total so far: {len(all_variants)}")
            else:
                break
    print(f"DEBUG: Completed barcode query with total {len(all_variants)} variants found")
    return all_variants

def set_activate_quantity_on_location(inventoryItemId: str, locationId: str, store_id: str = None):
    """
        https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventoryActivate
    """    


    gql_query = """#gql
        mutation ActivateInventoryItem($inventoryItemId: ID!, $locationId: ID!, $available: Int) {
            inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId, available: $available) {
                inventoryLevel {
                    id
                    quantities(names: ["available", "on_hand"]) {
                        name
                        quantity
                    }
                    item {
                        id
                    }
                    location {
                        id
                    }
                }
            }
        }
    """
    
    gql_variables = {
       "inventoryItemId": inventoryItemId,
       "locationId": locationId,
    #    "available": 0  # Set to 0 to activate without changing quantity
    }
    
    result = shopify_query_graph(
            query=gql_query,
            operation_name="ActivateInventoryItem",
            variables=gql_variables,
            store_id=store_id
    )
    
    return result

def adjust_quantity_to_variant(inventories: list[dict], store_id: str = None):
    """
        inventories: [{
            "delta": 2, # quantità
            "inventoryItemId": "gid://shopify/InventoryItem/56119140876579",
            "locationId": "gid://shopify/Location/105539928355"
        }]
        
        Shopify limits to 250 inventory changes per mutation, so we batch them.
    """
    credentials = get_store_credentials(store_id)
    api_version = (credentials or {}).get("api_version") or DEFAULT_API_VERSION
    supports_idempotency = _api_version_supports_idempotency(api_version)

    gql_query="""#gql
        mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
            inventoryAdjustQuantities(input: $input) {
                inventoryAdjustmentGroup {
                    createdAt
                    reason
                    referenceDocumentUri
                    changes(quantityNames: ["available"]) {
                        name
                        delta
                        location{
                            id
                            name
                        }
                        item {
                           inventoryLevels(first: 50){
                               nodes{
                                   location {
                                       id
                                       name
                                   }
                                   quantities(names: ["available"]){
                                       name
                                       quantity
                                   }
                               }
                           }
                            variant {
                                availableForSale
                                displayName
                                product {
                                    id
                                    handle
                                }
                            }
                        }
                    }
                }
                userErrors {
                    field
                    message
                }
            }
        }
    """

    gql_query_without_idempotency = gql_query
    gql_query_with_idempotency = gql_query.replace(
        "$input: InventoryAdjustQuantitiesInput!",
        "$input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!",
    ).replace(
        "inventoryAdjustQuantities(input: $input) {",
        "inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {",
    )

    using_idempotency = supports_idempotency
    current_query = gql_query_with_idempotency if using_idempotency else gql_query_without_idempotency
    print(
        f"DEBUG: Shopify Admin API {api_version} - @idempotent "
        f"{'enabled' if using_idempotency else 'disabled'}"
    )
    
    # Batch inventories into chunks of 250 (Shopify's limit)
    BATCH_SIZE = 250
    all_results = []
    total_batches = (len(inventories) + BATCH_SIZE - 1) // BATCH_SIZE
    
    print(f"DEBUG: Adjusting {len(inventories)} inventories in {total_batches} batch(es)")
    
    for i in range(0, len(inventories), BATCH_SIZE):
        batch = inventories[i:i + BATCH_SIZE]
        batch_num = (i // BATCH_SIZE) + 1
        
        print(f"DEBUG: Processing batch {batch_num}/{total_batches} with {len(batch)} items")
        
        idempotency_key = str(uuid.uuid4())
        gql_variables = {
            "input": {
                "reason": "other",
                "name": "available",
                "changes": batch
            }
        }
        if using_idempotency:
            gql_variables["idempotencyKey"] = idempotency_key
        
        result = None
        # A wrong API version in the store config must not block a sync: if Shopify
        # says the directive is missing (or unknown) retry the same batch once with
        # the opposite shape, reusing the same idempotency key.
        for _attempt in range(2):
            result = shopify_query_graph(
                    query=current_query,
                    operation_name="inventoryAdjustQuantities",
                    variables=gql_variables,
                    store_id=store_id,
                    credentials=credentials,
            )

            errors = result.get("errors") if isinstance(result, dict) else None
            if not errors:
                break

            if not using_idempotency and _is_idempotent_required_error(errors):
                print("DEBUG: Shopify requires @idempotent - retrying batch with the directive")
                using_idempotency = True
                current_query = gql_query_with_idempotency
                gql_variables["idempotencyKey"] = idempotency_key
                continue

            if using_idempotency and _is_idempotent_unsupported_error(errors):
                print("DEBUG: Shopify rejected @idempotent - retrying batch without the directive")
                using_idempotency = False
                current_query = gql_query_without_idempotency
                gql_variables.pop("idempotencyKey", None)
                continue

            break
        
        # Check for errors in this batch
        if isinstance(result, dict) and result.get("error"):
            message = _first_error_message(result["error"])
            print(f"ERROR in batch {batch_num}: {result['error']}")
            return {
                "error": f"Failed at batch {batch_num}/{total_batches}: {message}",
                "details": result,
            }

        if result and "errors" in result:
            message = _first_error_message(result["errors"])
            print(f"ERROR in batch {batch_num}: {result['errors']}")
            return {
                "error": f"Failed at batch {batch_num}/{total_batches}: {message}",
                "details": result,
            }
        
        if result and "inventoryAdjustQuantities" in result and result["inventoryAdjustQuantities"].get("userErrors"):
            print(f"USER ERRORS in batch {batch_num}: {result['inventoryAdjustQuantities']['userErrors']}")
            return {"error": f"User errors in batch {batch_num}/{total_batches}", "details": result}
        
        all_results.append(result)
    
    # Return the combined results (or just the last one for simplicity)
    # You could merge all changes if needed
    print(f"DEBUG: Successfully processed all {total_batches} batch(es)")
    
    # Merge all results into one response
    if all_results:
        merged_result = {
            "inventoryAdjustQuantities": {
                "inventoryAdjustmentGroup": {
                    "changes": []
                }
            }
        }
        
        for result in all_results:
            if result and "inventoryAdjustQuantities" in result:
                changes = result["inventoryAdjustQuantities"].get("inventoryAdjustmentGroup", {}).get("changes", [])
                merged_result["inventoryAdjustQuantities"]["inventoryAdjustmentGroup"]["changes"].extend(changes)
        
        # Copy metadata from the last result
        if all_results[-1] and "inventoryAdjustQuantities" in all_results[-1]:
            last_group = all_results[-1]["inventoryAdjustQuantities"]["inventoryAdjustmentGroup"]
            merged_result["inventoryAdjustQuantities"]["inventoryAdjustmentGroup"].update({
                "createdAt": last_group.get("createdAt"),
                "reason": last_group.get("reason"),
                "referenceDocumentUri": last_group.get("referenceDocumentUri")
            })
        
        return merged_result
    
    return None

def set_fixed_quantity_to_variant(inventories: list[dict], store_id: str = None):
    """ 
        Set fixed quantities to variants in Shopify.
        PAYLOAD EXAMPLE:
        {
            "input": {
                "name": "available",
                "reason": "correction",
                "referenceDocumentUri": "logistics://some.warehouse/take/2023-01-23T13:14:15Z",
                "quantities": [
                    {
                        "inventoryItemId": "gid://shopify/InventoryItem/30322695",
                        "locationId": "gid://shopify/Location/124656943",
                        "quantity": 11,
                    }
                ]
            }
        }
    """
    gql_query="""#gql
        mutation InventorySet($input: InventorySetQuantitiesInput!) {
            inventorySetQuantities(input: $input) {
                inventoryAdjustmentGroup {
                    createdAt
                    reason
                    referenceDocumentUri
                    changes {
                        name
                        delta
                    }
                }
                userErrors {
                    field
                    message
                }
            }
        }
    """
    # Batch inventories into chunks of 250 (Shopify's limit)
    BATCH_SIZE = 250
    all_results = []
    total_batches = (len(inventories) + BATCH_SIZE - 1) // BATCH_SIZE
    
    for i in range(0, len(inventories), BATCH_SIZE):
        batch = inventories[i:i + BATCH_SIZE]
        batch_num = (i // BATCH_SIZE) + 1
        
        print(f"DEBUG: Processing batch {batch_num}/{total_batches} with {len(batch)} items")
        
        gql_variables = {
            "input": {
                "name": "available",
                "reason": "correction",
                "ignoreCompareQuantity": True,
                "quantities": batch
            }
        }
        
        result = shopify_query_graph(
                query=gql_query,
                operation_name="InventorySet",
                variables=gql_variables,
                store_id=store_id
        )
        
        # Check for errors in this batch
        if result and "errors" in result:
            print(f"ERROR in batch {batch_num}: {result['errors']}")
            return {"error": f"Failed at batch {batch_num}/{total_batches}", "details": result}
        
        if result and "inventorySetQuantities" in result and result["inventorySetQuantities"].get("userErrors"):
            print(f"USER ERRORS in batch {batch_num}: {result['inventorySetQuantities']['userErrors']}")
            return {"error": f"User errors in batch {batch_num}/{total_batches}", "details": result}
        
        all_results.append(result)
    
    # Return the combined results (or just the last one for simplicity)
    # You could merge all changes if needed
    print(f"DEBUG: Successfully processed all {total_batches} batch(es)")
    
    # Merge all results into one response
    if all_results:
        merged_result = {
                "changes": [],
                "createdAt": None,
                "reason": None,
                "referenceDocumentUri": None
            }
        
        for result in all_results:
            if result and "inventorySetQuantities" in result and result["inventorySetQuantities"].get("inventoryAdjustmentGroup") is not None:
                changes = result["inventorySetQuantities"].get("inventoryAdjustmentGroup", {}).get("changes", [])
                merged_result["changes"].extend(changes)
            else:
                print("DEBUG: No inventoryAdjustmentGroup found in result")
        
        # Copy metadata from the last result
        if all_results[-1] and "inventorySetQuantities" in all_results[-1]:
            last_group = all_results[-1]["inventorySetQuantities"]["inventoryAdjustmentGroup"]
            merged_result.update({
                "createdAt": last_group.get("createdAt"),
                "reason": last_group.get("reason"),
                "referenceDocumentUri": last_group.get("referenceDocumentUri")
            })
        
        return merged_result
    
    return None
    
def add_to_sale_channels(resource_id: object, channels: list[dict], store_id: str = None) -> dict | None:
    """
    Adds products to sale channels in Shopify.

    :param shopify: The Shopify session object.
    :param resource_id: The ID of the resource to be added to the sale channel.
    :param channels: List of dictionaries containing product IDs and sale channel IDs.
    :param store_id: The store ID from config

    :return: Response from the Shopify API or None if an error occurs.

    Example resource_input:
        {
         "resource_id": "gid://shopify/Product/9834861953315",
         "channels": [
               {
                   "publicationId": "gid://shopify/Publication/240302129443"
               },
               {
                   "publicationId": "gid://shopify/Publication/240302326051"
               }
           ]
        }
    """
    
    gql_query = """#gql
        mutation SetObjectToSaleChannel($resource_id: ID!, $channels: [PublicationInput!]!) {
            publishablePublish(id: $resource_id input: $channels) {
                publishable {
                    resourcePublications(first:10){
                        nodes{
                            isPublished
                        }
                    }
                }
                userErrors {
                field
                message
                }
            }
        }
    """
    res = shopify_query_graph(
        query=gql_query,
        operation_name="SetObjectToSaleChannel",
        variables={"resource_id": resource_id, "channels": channels},
        store_id=store_id
    )

    return res