/*
 * Preflight ("Select & Check") report rendering.
 * Pure functions, also unit tested with node:test.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.CheckReport = api;
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

    function display(value, fallback) {
        return value === null || value === undefined || value === "" ? (fallback || "—") : value;
    }

    function currentStockText(row) {
        if (row.current_available === null || row.current_available === undefined) {
            return "—";
        }
        if (row.stock_status === "not_stocked") {
            return `${row.current_available} (not stocked)`;
        }
        return String(row.current_available);
    }

    function targetText(data) {
        const locations = (data.target && data.target.location_ids) || [];
        if (!locations.length) return "—";
        return locations.map(loc => (
            loc.name ? `${loc.name} (${loc.id})` : loc.id
        )).join(", ");
    }

    function warningsHtml(data) {
        const warnings = data.warnings || [];
        if (!warnings.length) return "";
        let html = `<div class="report-warnings">`;
        warnings.forEach(item => {
            const level = ["error", "warning", "info"].includes(item.level) ? item.level : "warning";
            const icon = level === "error" ? "❌" : (level === "info" ? "ℹ️" : "⚠️");
            html += `<div class="report-warning report-warning--${level}">${icon} ${escapeHtml(item.message)}</div>`;
        });
        html += `</div>`;
        return html;
    }

    function buildSummary(data, filename) {
        const summary = data.summary || {};
        if (!summary.rows) return "";

        const skipped = (summary.missing || 0) + (summary.duplicates || 0);
        const total = summary.total_quantity || 0;
        const totalText = total > 0 ? `+${total}` : String(total);

        return `
            <div class="check-report">
                <h3 class="check-report-title">Preflight report — ${escapeHtml(filename)}</h3>
                <div class="report-tiles">
                    <div class="report-tile"><span>Rows</span><strong>${escapeHtml(summary.rows)}</strong></div>
                    <div class="report-tile"><span>Matched in Shopify</span><strong>${escapeHtml(summary.matched || 0)}</strong></div>
                    <div class="report-tile"><span>Skipped</span><strong>${escapeHtml(skipped)}</strong></div>
                    <div class="report-tile"><span>Total quantity</span><strong>${escapeHtml(totalText)}</strong></div>
                </div>
                <div class="report-target"><strong>Target location:</strong> ${escapeHtml(targetText(data))}</div>
                ${warningsHtml(data)}
            </div>
        `;
    }

    function rowsTable(rows, caption) {
        if (!rows || !rows.length) return "";
        let html = `<table class="sync-table check-table">
            <caption>${escapeHtml(caption)}</caption>
            <thead><tr>
                <th>#</th>
                <th>SKU / barcode</th>
                <th>Qty</th>
                <th>Location</th>
                <th>Channel</th>
                <th>Matched product / variant</th>
                <th>Current @ target</th>
                <th>Change</th>
                <th>After (adjust)</th>
            </tr></thead>
            <tbody>`;
        rows.forEach(row => {
            const location = row.location_name
                ? `${row.location_name} (${row.location_id})`
                : row.location_id;
            const product = row.product_id || row.variant_title
                ? `${escapeHtml(row.product_id)}<br><small>${escapeHtml(row.variant_title)}</small>`
                : (row.matched ? "matched" : "NOT FOUND IN SHOPIFY");
            html += `<tr>
                <td>${escapeHtml(row.row)}</td>
                <td>${escapeHtml(row.reference)}</td>
                <td>${escapeHtml(row.quantity)}</td>
                <td>${escapeHtml(display(location))}</td>
                <td>${escapeHtml(display(row.sale_channel))}</td>
                <td>${product}</td>
                <td>${escapeHtml(currentStockText(row))}</td>
                <td>${escapeHtml(display(row.change))}</td>
                <td>${escapeHtml(display(row.projected_after_adjust))}</td>
            </tr>`;
        });
        html += `</tbody></table>`;
        return html;
    }

    function buildReport(data, filename) {
        let html = buildSummary(data, filename);
        const preview = data.preview || [];
        const rows = data.rows || [];

        if (preview.length) {
            html += `<div class="check-report-detail">`;
            html += `<p class="report-hint">Preview of the first ${preview.length} row(s). “Current” is stock at the target location right now (0 if the item is not stocked there yet); “Change” is the signed quantity from the file; “After” is Current + Change in Adjust mode. Replace mode sets the value to the file quantity instead.</p>`;
            html += rowsTable(preview, "File preview");
            html += `</div>`;
        }

        if (rows.length > preview.length) {
            html += `<details class="check-report-detail">
                <summary>View all ${rows.length} rows</summary>
                ${rowsTable(rows, "All rows")}
            </details>`;
        }
        return html;
    }

    function build(data, filename) {
        if (data && data.ready_to_sync) return buildReport(data, filename);
        return buildSummary(data, filename);
    }

    return { build, buildSummary, buildReport, rowsTable, targetText, escapeHtml, currentStockText };
});
