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

    function buildSummary(data, filename, options = {}) {
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
                ${options.showWarnings === false ? "" : warningsHtml(data)}
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

    function buildReport(data, filename, options = {}) {
        let html = buildSummary(data, filename, options);
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

    const SEVERITIES = ["blocking", "warning", "info"];

    function normalizeIssue(issue, index) {
        const items = Array.isArray(issue && issue.items)
            ? issue.items.map(item => String(item))
            : [];
        const severity = SEVERITIES.includes(issue && issue.severity)
            ? issue.severity
            : "warning";
        return {
            code: String((issue && issue.code) || `issue_${index}`),
            severity,
            title: String((issue && (issue.title || issue.message)) || "Preflight issue"),
            explanation: String((issue && issue.explanation) || ""),
            fix: String((issue && issue.fix) || ""),
            items,
            count: items.length || Number(issue && issue.count) || 1,
        };
    }

    function legacyIssues(data) {
        const issues = [];
        const missingFields = data.missing_fields || [];
        if (missingFields.length) {
            issues.push({
                code: "missing_columns", severity: "blocking",
                title: "Required columns are missing",
                explanation: "The file doesn't contain: " + missingFields.join(", ") + ".",
                fix: "Add these columns or choose the global defaults above, then check again.",
                items: missingFields,
            });
        }
        if ((data.missing_rows || []).length) {
            issues.push({
                code: "missing_skus", severity: "blocking",
                title: `${data.missing_rows.length} SKU(s) not found in Shopify`,
                explanation: "These products don't exist in the selected store, so their quantities can't be updated.",
                fix: "Correct the SKU/barcode, create the product in Shopify, or remove the row.",
                items: data.missing_rows,
            });
        }
        if ((data.duplicate_rows || []).length) {
            issues.push({
                code: "duplicate_skus", severity: "blocking",
                title: `${data.duplicate_rows.length} duplicate SKU(s) in the file`,
                explanation: "These SKUs appear more than once, so the app can't tell which quantity to apply.",
                fix: "Keep one row per SKU, or merge the quantities into a single row.",
                items: data.duplicate_rows,
            });
        }
        (data.warnings || []).forEach((warning, index) => {
            const level = warning.level || "warning";
            issues.push({
                code: `check_${level}_${index}`,
                severity: level === "info" ? "info" : (level === "error" ? "blocking" : "warning"),
                title: warning.message || "Preflight issue",
                items: [],
            });
        });
        if (!issues.length && !data.ready_to_sync) {
            issues.push({
                code: "check_blocked", severity: "blocking",
                title: "This file can't be synced yet",
                explanation: data.detail || "The file did not pass the preflight check.",
                fix: "Review the report above and run Select & Check again.",
                items: [],
            });
        }
        return issues;
    }

    function normalizeIssues(data) {
        if (Array.isArray(data && data.issues) && data.issues.length) {
            return data.issues.map(normalizeIssue);
        }
        return legacyIssues(data || {}).map(normalizeIssue);
    }

    function copyNoun(issue) {
        if (issue.code === "missing_columns") return "item";
        if (issue.code === "missing_skus" || issue.code === "duplicate_skus") return "SKU";
        if (issue.code === "no_shopify_matches") return "identifier";
        return issue.count === 1 ? "item" : "items";
    }

    function issueHtml(issue, index) {
        const icon = issue.severity === "info" ? "i" : "!";
        const preview = issue.items.slice(0, 5);
        const hasMore = issue.items.length > preview.length;
        const previewHtml = preview.length ? `
            <ul class="issue-items issue-items--preview">
                ${preview.map(item => `<li><code>${escapeHtml(item)}</code></li>`).join("")}
            </ul>` : "";
        const fullHtml = issue.items.length ? `
            <ol class="issue-items issue-items--all" id="issue-items-${index}" ${hasMore ? "hidden" : ""}>
                ${issue.items.map(item => `<li><code>${escapeHtml(item)}</code></li>`).join("")}
            </ol>` : "";
        const copyButton = issue.items.length ? `
            <button type="button" class="issue-btn issue-btn--copy" data-copy-issue="${index}">
                Copy ${issue.count} ${copyNoun(issue)}${issue.count === 1 ? "" : "s"}
            </button>` : "";
        const toggleButton = hasMore ? `
            <button type="button" class="issue-btn" data-toggle-issue="${index}"
                    data-collapsed-label="Show all ${issue.items.length}"
                    aria-expanded="false" aria-controls="issue-items-${index}">
                Show all ${issue.items.length}
            </button>` : "";

        return `
            <li class="issue-card issue-card--${issue.severity}">
                <div class="issue-card__head">
                    <span class="issue-card__icon" aria-hidden="true">${icon}</span>
                    <div class="issue-card__heading">
                        <h4>${escapeHtml(issue.title)}</h4>
                        ${issue.items.length ? `<span class="issue-card__count">${issue.count}</span>` : ""}
                    </div>
                </div>
                ${issue.explanation ? `<p class="issue-card__text">${escapeHtml(issue.explanation)}</p>` : ""}
                ${issue.fix ? `<p class="issue-card__fix"><strong>How to fix:</strong> ${escapeHtml(issue.fix)}</p>` : ""}
                ${previewHtml}
                ${fullHtml}
                ${copyButton || toggleButton ? `<div class="issue-card__actions">${copyButton}${toggleButton}</div>` : ""}
            </li>`;
    }

    function buildStatus(data, filename, options = {}) {
        const issues = normalizeIssues(data);
        const blocking = issues.filter(issue => issue.severity === "blocking");
        const warnings = issues.filter(issue => issue.severity === "warning");
        const state = data && data.ready_to_sync
            ? (warnings.length ? "attention" : "ready")
            : (blocking.length ? "blocked" : "attention");
        const headline = options.title || (
            state === "ready" ? "Ready to sync"
                : state === "blocked" ? "This file can't be synced yet"
                    : "Check this file before syncing"
        );
        let subtitle = options.subtitle || "";
        if (!subtitle) {
            if (state === "ready") {
                subtitle = `All ${data.total_skus || (data.summary && data.summary.rows) || 0} identifiers were verified in Shopify.`;
            } else {
                const parts = [];
                if (blocking.length) parts.push(`${blocking.length} blocking issue${blocking.length === 1 ? "" : "s"}`);
                if (warnings.length) parts.push(`${warnings.length} warning${warnings.length === 1 ? "" : "s"}`);
                subtitle = `${parts.join(" and ") || "Preflight check did not pass"} for ${filename}.`;
            }
        }
        const details = options.showDetails === false ? "" : `
            <details class="check-status__details" ${options.detailsOpen ? "open" : ""}>
                <summary>View detailed report</summary>
                ${buildReport(data, filename, { showWarnings: false })}
            </details>`;

        return `
            <div class="check-status check-status--${state}" data-check-status tabindex="-1"
                 role="${state === "blocked" ? "alert" : "status"}"
                 ${state === "blocked" ? "" : 'aria-live="polite"'}>
                <div class="check-status__header">
                    <span class="check-status__icon" aria-hidden="true">${state === "ready" ? "✓" : state === "blocked" ? "!" : "?"}</span>
                    <div>
                        <h3 class="check-status__title">${escapeHtml(headline)}</h3>
                        <p class="check-status__subtitle">${escapeHtml(subtitle)}</p>
                    </div>
                </div>
                ${issues.length ? `<ul class="issue-list">${issues.map(issueHtml).join("")}</ul>` : ""}
                ${details}
            </div>`;
    }

    function buildNotice(notice) {
        const noticeData = notice || {};
        const severity = ["blocked", "warning", "info", "ready"].includes(noticeData.severity)
            ? noticeData.severity
            : "blocked";
        const icon = severity === "ready" ? "✓" : (severity === "info" ? "i" : "!");
        return `
            <div class="check-status check-status--${severity} app-notice"
                 role="${severity === "blocked" ? "alert" : "status"}"
                 ${severity === "blocked" ? "" : 'aria-live="polite"'}>
                <div class="check-status__header">
                    <span class="check-status__icon" aria-hidden="true">${icon}</span>
                    <div>
                        <h3 class="check-status__title">${escapeHtml(noticeData.title || "Something went wrong")}</h3>
                        ${noticeData.message ? `<p class="check-status__subtitle">${escapeHtml(noticeData.message)}</p>` : ""}
                        ${noticeData.fix ? `<p class="issue-card__fix"><strong>How to fix:</strong> ${escapeHtml(noticeData.fix)}</p>` : ""}
                    </div>
                </div>
            </div>`;
    }

    return {
        build, buildSummary, buildReport, buildStatus, buildNotice, normalizeIssues,
        rowsTable, targetText, escapeHtml, currentStockText,
    };
});
