/*
 * Quantity backup browser and restore flow.
 *
 * Backups are nested inside each row of the "Uploaded Files" list, in a
 * collapsed <details> block. Pure render helpers are exported for Node tests.
 * Every fetch sets the store header itself (rather than relying on script.js's
 * global fetch override) so load order cannot break it.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.Backups = api;
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

    function formatDate(value) {
        if (!value) return "unknown date";
        const text = String(value).replace("T", " ");
        return text.length > 19 ? text.slice(0, 19) : text;
    }

    // A sync renames the source file to "...__DONE__.xlsx". Strip that suffix
    // so backups still group under the file after the rename.
    function fileKey(name) {
        return String(name || "").toLowerCase().replace(/__done__\d*/g, "");
    }

    function groupBackupsByFile(backups) {
        const grouped = new Map();
        (backups || []).forEach(backup => {
            const key = fileKey(backup.source_file);
            if (!key) return;
            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key).push(backup);
        });
        return grouped;
    }

    function renderBackupList(backups) {
        if (!Array.isArray(backups) || backups.length === 0) {
            return '<li>No backups yet. They are created automatically before each sync.</li>';
        }
        return backups.map(backup => {
            const location = backup.location || {};
            return `<li class="backup-row" data-backup-id="${escapeHtml(backup.id)}">
                <div class="backup-meta">
                    <strong>${escapeHtml(formatDate(backup.created_at))}</strong>
                    <span class="backup-pill">${escapeHtml(backup.sync_mode || "sync")}</span>
                    <span>${escapeHtml(backup.item_count ?? 0)} item(s)</span>
                    <span title="${escapeHtml(location.id || "")}">${escapeHtml(location.name || location.id || "Unknown location")}</span>
                </div>
                <div class="backup-actions">
                    <button type="button" class="backup-view-btn" data-backup-id="${escapeHtml(backup.id)}">View</button>
                    <button type="button" class="backup-restore-btn" data-backup-id="${escapeHtml(backup.id)}">Restore…</button>
                </div>
            </li>`;
        }).join("");
    }

    function renderFileBackups(backups) {
        if (!Array.isArray(backups) || backups.length === 0) return "";
        return `<details class="file-backups">
            <summary>🗄 Quantity backups (${backups.length})</summary>
            <ul class="backup-list">${renderBackupList(backups)}</ul>
            <div class="backup-detail" style="display: none;"></div>
        </details>`;
    }

    function renderRestorePreview(backup) {
        if (!backup || !Array.isArray(backup.items)) {
            return '<p class="backup-error">This backup could not be read.</p>';
        }
        if (backup.items.length === 0) {
            return '<p>No items in this backup.</p>';
        }

        let html = `<div class="backup-preview-head">
            <h3>Backup ${escapeHtml(backup.id)}</h3>
            <p>${escapeHtml(backup.source_file || "")} — ${escapeHtml(formatDate(backup.created_at))}</p>
        </div>`;

        if (backup.current_read_ok === false) {
            html += '<p class="backup-error">Shopify stock could not be read right now; restoring is disabled.</p>';
        }

        html += `<table class="backup-table">
            <thead><tr>
                <th>Restore</th><th>SKU / reference</th><th>Variant</th>
                <th>Location</th><th>Current</th><th>Target</th><th>Change</th>
            </tr></thead><tbody>`;

        backup.items.forEach(item => {
            const current = item.current_quantity === null || item.current_quantity === undefined
                ? "not stocked" : item.current_quantity;
            const target = item.target_quantity;
            const delta = item.delta_to_restore;
            const deltaText = delta > 0 ? `+${delta}` : String(delta);
            const note = item.before_quantity === null || item.before_quantity === undefined
                ? ' <span class="backup-note">(was unstocked → 0)</span>' : "";
            const disabled = backup.current_read_ok === false ? " disabled" : "";
            html += `<tr>
                <td><input type="checkbox" class="backup-item-check" value="${escapeHtml(item.reference || "")}" checked${disabled}></td>
                <td>${escapeHtml(item.reference || item.sku || item.barcode || "-")}</td>
                <td>${escapeHtml(item.variant_name || "-")}</td>
                <td title="${escapeHtml(item.location_id || "")}">${escapeHtml((backup.location || {}).name || item.location_id || "-")}</td>
                <td>${escapeHtml(current)}</td>
                <td>${escapeHtml(target === null || target === undefined ? "-" : target)}${note}</td>
                <td>${escapeHtml(deltaText)}</td>
            </tr>`;
        });

        html += `</tbody></table>
            <div class="backup-preview-actions">
                <button type="button" class="backup-confirm-btn" data-backup-id="${escapeHtml(backup.id)}"${backup.current_read_ok === false ? " disabled" : ""}>Restore selected items</button>
                <button type="button" class="backup-cancel-btn">Cancel</button>
            </div>`;
        return html;
    }

    function formatDetails(details) {
        if (details === null || details === undefined) return "";
        let text;
        if (typeof details === "string") {
            text = details;
        } else {
            try {
                text = JSON.stringify(details, null, 2);
            } catch (err) {
                text = String(details);
            }
        }
        if (!text) return "";
        return `<pre class="backup-error-details">${escapeHtml(text)}</pre>`;
    }

    function buildResultBanner(result, fetchOk, status) {
        // The API returns errors as {"error": ...} (and sometimes FastAPI's
        // {"detail": ...}). Read both so a failure is never reduced to the
        // meaningless "Request failed" text.
        const failed = !fetchOk || !result || result.success === false;
        if (failed) {
            const message = result && (result.error || result.detail);
            const statusText = status ? ` (HTTP ${escapeHtml(status)})` : "";
            return `<div class="backup-result backup-result-error">
                <strong>Restore failed${statusText}:</strong> ${escapeHtml(message || "Unknown error")}
                ${formatDetails(result && result.details)}
            </div>`;
        }
        return `<div class="backup-result backup-result-ok">
            <strong>Restore complete.</strong> ${escapeHtml(result.restored_count ?? 0)} item(s) restored.
            A new backup (${escapeHtml(result.restore_backup_id || "-")}) was saved first, so this restore can be undone.
        </div>`;
    }

    function attachFileBackups(listEl, fetchImpl, storage) {
        if (!listEl) return Promise.resolve();
        const fetcher = fetchImpl || (typeof window !== "undefined" ? window.fetch.bind(window) : null);
        const store = storage || (typeof window !== "undefined" ? window.localStorage : null);
        if (!fetcher) return Promise.resolve();
        const storeId = store && store.getItem ? store.getItem("selectedStore") : null;

        function apiFetch(path, options) {
            const opts = Object.assign({}, options || {});
            opts.headers = Object.assign({}, opts.headers || {}, {
                "X-Selected-Store": storeId || "",
            });
            if (opts.body && typeof opts.body === "object") {
                opts.headers["Content-Type"] = "application/json";
                opts.body = JSON.stringify(opts.body);
            }
            // `script.js`'s global fetch wrapper prefixes ROOT_PATH, so `path`
            // is left as a plain /api/v1/... URL here.
            return fetcher(path, opts);
        }

        // The file list is re-rendered by script.js; keep one delegated
        // listener on the persistent <ul> and only replace the injected rows.
        if (!listEl._backupsListenerAttached) {
            listEl._backupsListenerAttached = true;
            listEl.addEventListener("click", async event => {
                const refreshLink = event.target.closest(".backup-refresh-link");
                if (refreshLink) {
                    await attachFileBackups(listEl, fetcher, store);
                    return;
                }

                const viewBtn = event.target.closest(".backup-view-btn");
                const restoreBtn = event.target.closest(".backup-restore-btn");
                const actionBtn = viewBtn || restoreBtn;
                if (actionBtn) {
                    const block = actionBtn.closest(".file-backups");
                    const detailBox = block && block.querySelector(".backup-detail");
                    if (!detailBox) return;
                    detailBox.style.display = "block";
                    detailBox.innerHTML = "<p>Loading backup…</p>";
                    try {
                        const res = await apiFetch(`/api/v1/backups/${encodeURIComponent(actionBtn.dataset.backupId)}`);
                        const data = await res.json();
                        if (!res.ok) {
                            detailBox.innerHTML = `<p class="backup-error">${escapeHtml(data.detail || data.error || "Could not load backup")}</p>`;
                            return;
                        }
                        detailBox.innerHTML = renderRestorePreview(data);
                        if (restoreBtn) detailBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
                    } catch (err) {
                        detailBox.innerHTML = `<p class="backup-error">${escapeHtml(err)}</p>`;
                    }
                    return;
                }

                if (event.target.closest(".backup-cancel-btn")) {
                    const block = event.target.closest(".file-backups");
                    if (block) {
                        const detailBox = block.querySelector(".backup-detail");
                        detailBox.style.display = "none";
                        detailBox.innerHTML = "";
                    }
                    return;
                }

                const confirmBtn = event.target.closest(".backup-confirm-btn");
                if (!confirmBtn) return;
                const block = confirmBtn.closest(".file-backups");
                const detailBox = block && block.querySelector(".backup-detail");
                if (!detailBox) return;
                const references = Array.from(detailBox.querySelectorAll(".backup-item-check:checked"))
                    .map(box => box.value);
                if (references.length === 0) {
                    detailBox.insertAdjacentHTML("beforeend", '<p class="backup-error">Select at least one item.</p>');
                    return;
                }
                confirmBtn.disabled = true;
                confirmBtn.textContent = "Restoring…";
                try {
                    const res = await apiFetch(
                        `/api/v1/backups/${encodeURIComponent(confirmBtn.dataset.backupId)}/restore`,
                        { method: "POST", body: { references } }
                    );
                    const data = await res.json();
                    detailBox.innerHTML = buildResultBanner(data, res.ok, res.status) +
                        '<p><button type="button" class="backup-refresh-link">Refresh backups</button></p>';
                    await attachFileBackups(listEl, fetcher, store);
                } catch (err) {
                    detailBox.innerHTML = buildResultBanner({ error: String(err) }, false);
                }
            });
        }

        // Only the newest fetch may write into the list.
        const token = (listEl._backupsAttachToken || 0) + 1;
        listEl._backupsAttachToken = token;

        return apiFetch("/api/v1/backups").then(async res => {
            const data = await res.json();
            if (listEl._backupsAttachToken !== token) return;
            if (!res.ok) return;
            const grouped = groupBackupsByFile(data.backups);

            listEl.querySelectorAll(".file-backups").forEach(el => el.remove());
            listEl.querySelectorAll("li.file-row").forEach(row => {
                let name = row.dataset.filename || "";
                try { name = decodeURIComponent(name); } catch (err) { /* keep raw */ }
                const backups = grouped.get(fileKey(name));
                if (!backups || !backups.length) return;
                row.insertAdjacentHTML("beforeend", renderFileBackups(backups));
            });
        }).catch(() => {
            // Backups are a safety net; a failed listing must not break the
            // uploaded-files list. The restore endpoints still report errors.
        });
    }

    return {
        escapeHtml,
        formatDate,
        fileKey,
        groupBackupsByFile,
        renderBackupList,
        renderFileBackups,
        renderRestorePreview,
        buildResultBanner,
        attachFileBackups,
    };
});
