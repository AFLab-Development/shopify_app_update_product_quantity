/*
 * Rendering for the result of an inventory sync.
 *
 * Kept in its own file (with no DOM dependencies) so it can be unit tested in
 * Node as well as used from the browser.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.SyncTable = api;
    }
})(typeof window !== "undefined" ? window : null, function () {
    "use strict";

    function escapeHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function buildSyncErrorBanner(data) {
        const error = (data && (data.error || (data.data && data.data.error))) || null;
        if (!error) return "";

        const details = data && data.data && data.data.details && data.data.details.errors;
        const messages = Array.isArray(details)
            ? details.map(e => (e && e.message) || JSON.stringify(e)).join("\n")
            : "";

        return `<div class="sync-error-banner">
            <strong>Sync failed:</strong> ${escapeHtml(error)}
            ${messages ? `<pre>${escapeHtml(messages)}</pre>` : ""}
        </div>`;
    }

    function buildMissingSyncList(data) {
        if (data && Array.isArray(data.missing_rows) && data.missing_rows.length > 0) {
            return `
            <div class="missing-sync">
                <h3>${data.missing_rows.length} SKUs not updated (not found in store):</h3> (${((data.missing_rows.length / (data.total_records || data.missing_rows.length)) * 100).toFixed(2)}% of total items)
                <button class="copy-all-btn" style="display: flex;justify-content: center;align-items: center;" onclick='copyMissingSKUs(${JSON.stringify(data.missing_rows)})'>
                    <svg width="50px" height="50px" viewBox="0 0 1024 1024" class="icon"  version="1.1" xmlns="http://www.w3.org/2000/svg"><path d="M589.3 260.9v30H371.4v-30H268.9v513h117.2v-304l109.7-99.1h202.1V260.9z" fill="#E1F0FF" /><path d="M516.1 371.1l-122.9 99.8v346.8h370.4V371.1z" fill="#E1F0FF" /><path d="M752.7 370.8h21.8v435.8h-21.8z" fill="#446EB1" /><path d="M495.8 370.8h277.3v21.8H495.8z" fill="#446EB1" /><path d="M495.8 370.8h21.8v124.3h-21.8z" fill="#446EB1" /><path d="M397.7 488.7l-15.4-15.4 113.5-102.5 15.4 15.4z" fill="#446EB1" /><path d="M382.3 473.3h135.3v21.8H382.3z" fill="#446EB1" /><path d="M382.3 479.7h21.8v348.6h-21.8zM404.1 806.6h370.4v21.8H404.1z" fill="#446EB1" /><path d="M447.7 545.1h261.5v21.8H447.7zM447.7 610.5h261.5v21.8H447.7zM447.7 675.8h261.5v21.8H447.7z" fill="#6D9EE8" /><path d="M251.6 763h130.7v21.8H251.6z" fill="#446EB1" /><path d="M251.6 240.1h21.8v544.7h-21.8zM687.3 240.1h21.8v130.7h-21.8zM273.4 240.1h108.9v21.8H273.4z" fill="#446EB1" /><path d="M578.4 240.1h130.7v21.8H578.4zM360.5 196.5h21.8v108.9h-21.8zM382.3 283.7h196.1v21.8H382.3zM534.8 196.5h65.4v21.8h-65.4z" fill="#446EB1" /><path d="M360.5 196.5h65.4v21.8h-65.4zM404.1 174.7h152.5v21.8H404.1zM578.4 196.5h21.8v108.9h-21.8z" fill="#446EB1" /></svg>
                    <span> Copy All</span>
                </button>
            </div>
            `;
        }
        return "";
    }

    function levelQuantityFor(change, verified) {
        const verifiedQuantity = verified && verified[`${(change.item || {}).id || ""}|${(change.location || {}).id || ""}`];
        if (verifiedQuantity !== undefined && verifiedQuantity !== null) {
            return verifiedQuantity;
        }
        const location = change.location || {};
        const nodes = (change.item && change.item.inventoryLevels && change.item.inventoryLevels.nodes) || [];
        const level = nodes.find(node => node.location && node.location.id === location.id);
        if (!level) {
            // The changed location can be missing from inventoryLevels (e.g. it was
            // just activated), so don't invent a quantity for it.
            return "—";
        }
        const available = (level.quantities || []).find(q => q.name === "available");
        return available ? available.quantity : "—";
    }

    /**
     * Build the results shown after a sync.
     *
     * Only `change.location` is displayed. Shopify returns *all* inventory
     * levels for the item in `item.inventoryLevels`, which made the old table
     * show untouched locations (Nippon Express, Cortina, ...) with their
     * existing quantities and no delta -- looking exactly like the sync had
     * written quantity to them.
     */
    function buildSyncTable(data) {
        let html = "";
        const missed = buildMissingSyncList(data);

        html += buildSyncErrorBanner(data);

        if (data && data.completed_filename) {
            html += `<div style="margin: 1rem 0; padding: 1rem; border-radius: 8px; background: rgba(var(--color-primary-rgb), 0.15); border: 1px solid var(--color-primary);"> <strong>DONE:</strong> source file renamed to <code>${escapeHtml(data.completed_filename)}</code></div>`;
        }

        if (
            !data ||
            !data.data ||
            !data.data.inventoryAdjustQuantities ||
            !data.data.inventoryAdjustQuantities.inventoryAdjustmentGroup ||
            !Array.isArray(data.data.inventoryAdjustQuantities.inventoryAdjustmentGroup.changes)
        ) {
            html += missed;
            html += "<pre>" + escapeHtml(JSON.stringify(data, null, 2)) + "</pre>";
            return html;
        }

        const changes = data.data.inventoryAdjustQuantities.inventoryAdjustmentGroup.changes;

        html += `<p class="sync-table-note">Only the location that was adjusted is shown. Other locations are unchanged.</p>`;

        if (changes.length === 0) {
            html += `<p>No quantity changes were applied.</p>`;
            html += missed;
            return html;
        }

        html += `<table class="sync-table">
            <caption>Inventory Adjustments</caption>
            <thead>
                <tr>
                    <th>#</th>
                    <th>Product handle</th>
                    <th>Variant</th>
                    <th>Location</th>
                    <th>Quantity</th>
                    <th>Delta (+ / -)</th>
                </tr>
            </thead>
            <tbody>
        `;
        changes.forEach((change, index) => {
            const variant = (change.item && change.item.variant) || {};
            const product = variant.product || {};
            const location = change.location || {};
            const productName = product.handle
                ? product.handle.replace(/-/g, " ")
                : "-";

            html += `<tr>
                <td>${index + 1}</td>
                <td>${escapeHtml(productName)}</td>
                <td>${escapeHtml(variant.displayName || "-")}</td>
                <td title="${escapeHtml(location.id || "")}">${escapeHtml(location.name || "Unknown location")}</td>
                <td>${escapeHtml(levelQuantityFor(change, data.final_quantities))}</td>
                <td>${escapeHtml(change.delta !== undefined && change.delta !== null ? change.delta : "-")}</td>
            </tr>`;
        });
        html += "</tbody></table>";
        html += missed;
        return html;
    }

    return { buildSyncTable, buildMissingSyncList, buildSyncErrorBanner, escapeHtml };
});
