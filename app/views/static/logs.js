document.addEventListener("DOMContentLoaded", function () {
    const logsSection = document.getElementById("logs-section");
    const logsList = document.getElementById("logs-list");
    const refreshBtn = document.getElementById("refresh-logs");
    const deleteAllBtn = document.getElementById("delete-all-logs");
    const noticeArea = document.getElementById("logs-notice");
    const modal = document.getElementById("log-modal");
    const modalTitle = document.getElementById("log-modal-title");
    const modalContent = document.getElementById("log-modal-content");
    const modalNoticeArea = document.getElementById("log-modal-notice");
    const modalDownloadBtn = document.getElementById("log-modal-download");
    const modalCloseBtn = document.getElementById("log-modal-close");

    const groupLogs = window.LogsGroups
        ? window.LogsGroups.groupLogs
        : (logs) => (Array.isArray(logs) ? logs.map(file => ({
            id: file.filename, label: file.filename, files: [file],
            modified_at: file.modified_at, size_bytes: file.size_bytes,
        })) : []);
    const escapeHtml = window.CheckReport
        ? window.CheckReport.escapeHtml
        : (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
        })[char]);

    let selectedLog = null;
    let currentGroups = [];
    let modalTrigger = null;

    const selectedStore = localStorage.getItem("selectedStore");

    const originalFetch = window.fetch;
    window.fetch = function (...args) {
        let [url, options = {}] = args;
        if (typeof url === "string" && url.startsWith("/") && window.ROOT_PATH) {
            url = window.ROOT_PATH + url;
        }
        if (selectedStore) {
            options.headers = {
                ...options.headers,
                "X-Selected-Store": selectedStore,
            };
        }
        return originalFetch(url, options);
    };

    if (selectedStore && logsSection) {
        window.storeSelected = true;
        logsSection.style.display = "block";
    }

    function formatSize(bytes) {
        if (!Number.isFinite(bytes) || bytes < 1024) {
            return `${bytes || 0} B`;
        }
        const kb = bytes / 1024;
        if (kb < 1024) {
            return `${kb.toFixed(1)} KB`;
        }
        return `${(kb / 1024).toFixed(1)} MB`;
    }

    function noticeTargetArea(target) {
        return target === "modal" ? modalNoticeArea : noticeArea;
    }

    function showNotice(title, message, fix, severity = "blocked", target = "logs") {
        const area = noticeTargetArea(target);
        if (!area || !window.CheckReport) {
            return;
        }
        area.innerHTML = window.CheckReport.buildNotice({ severity, title, message, fix });
    }

    function clearNotice(target = "logs") {
        const area = noticeTargetArea(target);
        if (area) {
            area.innerHTML = "";
        }
    }

    function errorMessage(error) {
        return String(error && error.message ? error.message : error);
    }

    function renderFile(file) {
        const encodedFilename = encodeURIComponent(file.filename || "");
        const kind = (file.type || "file").toUpperCase();
        return `
            <li class="log-file-row">
                <span class="log-file-kind log-file-kind--${escapeHtml(kind.toLowerCase())}">${escapeHtml(kind)}</span>
                <span class="log-file-name">${escapeHtml(file.filename)}</span>
                <small class="log-meta">${escapeHtml(formatSize(file.size_bytes))}</small>
                <div class="log-actions log-file-actions">
                    <button class="view-log-btn" data-filename="${encodedFilename}">View</button>
                    <button class="download-log-btn" data-filename="${encodedFilename}">Download</button>
                    <button class="delete-log-btn" data-filename="${encodedFilename}">Delete</button>
                </div>
            </li>`;
    }

    function renderGroup(group) {
        const fileCount = group.files.length;
        const updated = group.modified_at ? ` | Updated ${escapeHtml(group.modified_at)}` : "";
        return `
            <li class="log-group">
                <div class="log-group__header">
                    <div class="log-info">
                        <strong>Run · ${escapeHtml(group.label)}</strong>
                        <small class="log-meta">${fileCount} file${fileCount === 1 ? "" : "s"} | ${escapeHtml(formatSize(group.size_bytes))}${updated}</small>
                    </div>
                    <div class="log-actions">
                        <button class="delete-run-btn" data-run-id="${encodeURIComponent(group.id)}">Delete run</button>
                    </div>
                </div>
                <ul class="log-group__files">
                    ${group.files.map(renderFile).join("")}
                </ul>
            </li>`;
    }

    function renderLogs(logs) {
        if (!logsList) {
            return;
        }

        currentGroups = groupLogs(logs);
        if (deleteAllBtn) {
            deleteAllBtn.disabled = currentGroups.length === 0;
        }

        if (!currentGroups.length) {
            logsList.innerHTML = '<li class="logs-empty">No logs found for this store.</li>';
            return;
        }

        logsList.innerHTML = currentGroups.map(renderGroup).join("");
    }

    function openLogModal(filename, trigger) {
        if (!modal || !modalTitle || !modalContent || !modalDownloadBtn) {
            return;
        }
        selectedLog = filename;
        modalTrigger = trigger || null;
        modal.hidden = false;
        document.body.classList.add("modal-open");
        modalTitle.textContent = `File Preview — ${filename}`;
        modalContent.textContent = "Loading log preview...";
        modalDownloadBtn.style.display = "inline-block";
        clearNotice("modal");
        modalCloseBtn?.focus();
        viewLog(filename);
    }

    function closeLogModal() {
        if (!modal) {
            return;
        }
        modal.hidden = true;
        document.body.classList.remove("modal-open");
        clearNotice("modal");
        selectedLog = null;
        modalContent.textContent = "Loading...";
        if (modalTrigger && document.contains(modalTrigger)) {
            modalTrigger.focus();
        }
        modalTrigger = null;
    }

    async function viewLog(filename) {
        try {
            const res = await fetch(`/api/v1/logs/content/${encodeURIComponent(filename)}?lines=400`);
            const text = await res.text();

            if (!res.ok) {
                showNotice(
                    "Couldn't open this log",
                    text || res.statusText || `The server returned HTTP ${res.status}.`,
                    "Check the file permissions or refresh the list, then try again.",
                    "blocked",
                    "modal",
                );
                modalContent.textContent = "Preview unavailable.";
                return;
            }

            clearNotice("modal");
            modalContent.textContent = text || "(empty file)";
        } catch (err) {
            showNotice(
                "Couldn't open this log",
                errorMessage(err),
                "Check your connection and try again.",
                "blocked",
                "modal",
            );
            modalContent.textContent = "Preview unavailable.";
        }
    }

    async function downloadLog(filename, target = "logs") {
        try {
            const res = await fetch(`/api/v1/logs/download/${encodeURIComponent(filename)}`);
            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || `Download failed (${res.status})`);
            }

            const blob = await res.blob();
            const objectUrl = URL.createObjectURL(blob);

            const link = document.createElement("a");
            link.href = objectUrl;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            link.remove();

            URL.revokeObjectURL(objectUrl);
        } catch (err) {
            showNotice(
                "Couldn't download the log",
                errorMessage(err),
                "Check the file permissions and try again.",
                "blocked",
                target,
            );
        }
    }

    async function deleteFiles(filenames, labels) {
        const deleted = [];
        const failed = [];

        for (const filename of filenames) {
            try {
                const res = await fetch(`/api/v1/logs/${encodeURIComponent(filename)}`, {
                    method: "DELETE",
                });
                if (!res.ok) {
                    const text = await res.text();
                    let detail = text;
                    try {
                        detail = JSON.parse(text).detail || detail;
                    } catch (err) {
                        // The response is sometimes plain text.
                    }
                    throw new Error(detail || `Delete failed (${res.status})`);
                }
                deleted.push(filename);
            } catch (err) {
                failed.push(`${filename}: ${errorMessage(err)}`);
            }
        }

        if (failed.length) {
            showNotice(
                labels.errorTitle,
                failed.join(" · "),
                `${deleted.length} file${deleted.length === 1 ? "" : "s"} deleted. Check permissions for the rest and try again.`,
            );
        } else {
            showNotice(
                labels.successTitle,
                `${deleted.length} file${deleted.length === 1 ? "" : "s"} deleted.`,
                "",
                "ready",
            );
        }

        await loadLogs();
    }

    function groupForRun(runId) {
        return currentGroups.find(group => group.id === runId);
    }

    if (logsList) {
        logsList.addEventListener("click", async (event) => {
            const viewBtn = event.target.closest(".view-log-btn");
            if (viewBtn) {
                openLogModal(decodeURIComponent(viewBtn.dataset.filename), viewBtn);
                return;
            }

            const downloadBtn = event.target.closest(".download-log-btn");
            if (downloadBtn) {
                await downloadLog(decodeURIComponent(downloadBtn.dataset.filename));
                return;
            }

            const deleteBtn = event.target.closest(".delete-log-btn");
            if (deleteBtn) {
                const filename = decodeURIComponent(deleteBtn.dataset.filename);
                if (confirm(`Delete "${filename}"?`)) {
                    await deleteFiles([filename], {
                        errorTitle: "Couldn't delete the log",
                        successTitle: "Log deleted",
                    });
                }
                return;
            }

            const deleteRunBtn = event.target.closest(".delete-run-btn");
            if (deleteRunBtn) {
                const runId = decodeURIComponent(deleteRunBtn.dataset.runId);
                const group = groupForRun(runId);
                if (!group) {
                    return;
                }
                if (confirm(`Delete ${group.files.length} file${group.files.length === 1 ? "" : "s"} for run ${group.label}?`)) {
                    await deleteFiles(group.files.map(file => file.filename), {
                        errorTitle: "Couldn't delete the run",
                        successTitle: "Run deleted",
                    });
                }
            }
        });
    }

    if (refreshBtn) {
        refreshBtn.addEventListener("click", async function () {
            await loadLogs();
        });
    }

    if (deleteAllBtn) {
        deleteAllBtn.addEventListener("click", async function () {
            const filenames = currentGroups.flatMap(group => group.files.map(file => file.filename));
            if (!filenames.length) {
                return;
            }
            if (confirm(`Delete all ${filenames.length} log file${filenames.length === 1 ? "" : "s"} for this store?`)) {
                await deleteFiles(filenames, {
                    errorTitle: "Couldn't delete all logs",
                    successTitle: "All logs deleted",
                });
            }
        });
    }

    if (modal) {
        modal.addEventListener("click", (event) => {
            if (event.target.closest("[data-close-modal]")) {
                closeLogModal();
            }
        });
    }

    if (modalDownloadBtn) {
        modalDownloadBtn.addEventListener("click", async function () {
            if (selectedLog) {
                await downloadLog(selectedLog, "modal");
            }
        });
    }

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && modal && !modal.hidden) {
            closeLogModal();
        }
    });

    async function loadLogs() {
        if (!window.storeSelected || !logsList) {
            return;
        }

        logsList.innerHTML = '<li class="logs-empty">Loading logs...</li>';

        try {
            const res = await fetch("/api/v1/logs");
            if (!res.ok) {
                const detail = await res.text();
                showNotice(
                    "Couldn't load the logs",
                    detail || `The server returned HTTP ${res.status}.`,
                    "Refresh the page or check the logs directory permissions.",
                );
                logsList.innerHTML = '<li class="logs-empty">Logs are unavailable right now.</li>';
                return;
            }

            const logs = await res.json();
            clearNotice();
            renderLogs(logs);
        } catch (err) {
            showNotice(
                "Couldn't load the logs",
                errorMessage(err),
                "Check your connection and try again.",
            );
            logsList.innerHTML = '<li class="logs-empty">Logs are unavailable right now.</li>';
        }
    }

    loadLogs();
});
