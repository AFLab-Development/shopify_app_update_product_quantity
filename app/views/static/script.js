document.addEventListener("DOMContentLoaded", function () {
    const uploadForm = document.getElementById("UploadFile");
    const responseBox = document.getElementById("check-results");
    const resultsSection = document.getElementById("results");
    const list = document.getElementById("resources-list");
    const syncConfig = document.getElementById("sync-config");
    const fileModal = document.getElementById("file-modal");
    const fileModalTitle = document.getElementById("file-modal-title");
    const fileModalContent = document.getElementById("file-modal-content");
    const fileModalNotice = document.getElementById("file-modal-notice");
    const fileModalDownloadBtn = document.getElementById("file-modal-download");
    const fileModalCloseBtn = document.getElementById("file-modal-close");
    let fileModalTrigger = null;
    let fileModalFilename = null;

    // Get selected store from localStorage
    const selectedStore = localStorage.getItem('selectedStore');
    const globalLocationSelect = document.getElementById('global-location-select');
    const globalLocationField = document.getElementById('global-location-field');
    const globalLocationError = document.getElementById('global-location-error');
    const globalSaleChannelsContainer = document.getElementById('global-sale-channels');
    const globalSaleChannelsField = document.getElementById('global-sale-channels-field');
    const globalSaleChannelsToggle = document.getElementById('global-sale-channels-toggle');
    const globalSaleChannelsPanel = document.getElementById('global-sale-channels-panel');
    const globalSaleChannelsError = document.getElementById('global-sale-channels-error');
    const globalStoreConfig = document.getElementById('global-store-config');

    // Override fetch to add store header and root path prefix
    const originalFetch = window.fetch;
    window.fetch = function (...args) {
        let [url, options = {}] = args;
        if (typeof url === 'string' && url.startsWith('/') && window.ROOT_PATH) {
            url = window.ROOT_PATH + url;
        }
        if (selectedStore) {
            options.headers = {
                ...options.headers,
                'X-Selected-Store': selectedStore
            };
        }
        return originalFetch(url, options);
    };

    function getGlobalLocationStorageKey(storeId = selectedStore) {
        return storeId ? `selectedLocation:${storeId}` : null;
    }

    function getGlobalSaleChannelsStorageKey(storeId = selectedStore) {
        return storeId ? `selectedSaleChannels:${storeId}` : null;
    }

    function getSelectedGlobalLocationId() {
        const key = getGlobalLocationStorageKey();
        if (!key) return '';
        return localStorage.getItem(key) || '';
    }

    function setSelectedGlobalLocationId(locationId) {
        const key = getGlobalLocationStorageKey();
        if (!key) return;
        if (locationId) localStorage.setItem(key, locationId);
        else localStorage.removeItem(key);
    }

    function getSelectedGlobalSaleChannelIds() {
        const key = getGlobalSaleChannelsStorageKey();
        if (!key) return [];
        try {
            const parsed = JSON.parse(localStorage.getItem(key) || '[]');
            return Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
            return [];
        }
    }

    function setSelectedGlobalSaleChannelIds(ids) {
        const key = getGlobalSaleChannelsStorageKey();
        if (!key) return;
        const normalized = Array.from(new Set((ids || []).map(String).filter(Boolean)));
        if (normalized.length) localStorage.setItem(key, JSON.stringify(normalized));
        else localStorage.removeItem(key);
    }

    function getGlobalConfigParams() {
        const params = new URLSearchParams();
        const locationId = getSelectedGlobalLocationId();
        const saleChannels = getSelectedGlobalSaleChannelIds();
        if (locationId) params.set('location_id', locationId);
        if (saleChannels.length) params.set('sale_channels', saleChannels.join(','));
        return params;
    }

    function appendGlobalConfigToFormData(formData) {
        const locationId = getSelectedGlobalLocationId();
        const saleChannels = getSelectedGlobalSaleChannelIds();
        if (locationId) formData.append('location_id', locationId);
        saleChannels.forEach(id => formData.append('sale_channels', id));
        return formData;
    }

    function clearGlobalConfigErrors() {
        globalLocationField?.classList.remove('has-error');
        globalSaleChannelsField?.classList.remove('has-error');
        if (globalLocationError) globalLocationError.textContent = '';
        if (globalSaleChannelsError) globalSaleChannelsError.textContent = '';
    }

    function showGlobalConfigErrors(missingFields = []) {
        clearGlobalConfigErrors();
        const missing = new Set(missingFields || []);
        if (missing.has('location_id')) {
            globalLocationField?.classList.add('has-error');
            if (globalLocationError) globalLocationError.textContent = 'Select a location or include it in the file.';
        }
        if (missing.has('sale_channel')) {
            globalSaleChannelsField?.classList.add('has-error');
            if (globalSaleChannelsError) globalSaleChannelsError.textContent = 'Select at least one sale channel or include it in the file.';
        }
    }

    async function loadGlobalLocations() {
        if (!globalLocationSelect || !selectedStore) return;
        globalLocationSelect.innerHTML = '<option value="">Loading locations...</option>';
        try {
            const res = await fetch('/api/v1/store-locations');
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || 'Failed to load locations');
            const locations = data.locations || [];
            const selected = getSelectedGlobalLocationId();
            globalLocationSelect.innerHTML = '<option value="">Use file location / select location</option>';
            locations.forEach(loc => {
                const opt = document.createElement('option');
                opt.value = loc.id;
                opt.textContent = loc.name ? `${loc.name} (${loc.id})` : loc.id;
                if (String(loc.id) === String(selected)) opt.selected = true;
                globalLocationSelect.appendChild(opt);
            });
            if (selected && !locations.some(l => String(l.id) === String(selected))) {
                setSelectedGlobalLocationId('');
            }
        } catch (err) {
            globalLocationSelect.innerHTML = '<option value="">Could not load locations</option>';
            console.error('Failed to load locations:', err);
        }
    }

    function updateGlobalSaleChannelsLabel() {
        if (!globalSaleChannelsToggle) return;
        const selected = getSelectedGlobalSaleChannelIds();
        const labels = Array.from(globalSaleChannelsPanel?.querySelectorAll('input[type="checkbox"]:checked') || [])
            .map(input => input.dataset.label || input.value);
        if (!selected.length) {
            globalSaleChannelsToggle.textContent = 'Select sale channels';
            return;
        }
        if (labels.length <= 2) {
            globalSaleChannelsToggle.textContent = labels.join(', ');
        } else {
            globalSaleChannelsToggle.textContent = `${labels.length} channels selected`;
        }
    }

    function closeGlobalSaleChannels() {
        if (!globalSaleChannelsPanel || !globalSaleChannelsToggle) return;
        globalSaleChannelsPanel.hidden = true;
        globalSaleChannelsToggle.setAttribute('aria-expanded', 'false');
    }

    function openGlobalSaleChannels() {
        if (!globalSaleChannelsPanel || !globalSaleChannelsToggle) return;
        globalSaleChannelsPanel.hidden = false;
        globalSaleChannelsToggle.setAttribute('aria-expanded', 'true');
    }

    async function loadGlobalSaleChannels() {
        if (!globalSaleChannelsPanel || !selectedStore) return;
        globalSaleChannelsPanel.innerHTML = '<div class="multi-select-empty">Loading sale channels...</div>';
        try {
            const res = await fetch('/api/v1/sale-channels');
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || 'Failed to load sale channels');
            const channels = data.sale_channels || [];
            const selectedIds = new Set(getSelectedGlobalSaleChannelIds().map(String));
            globalSaleChannelsPanel.innerHTML = '';
            if (!channels.length) {
                globalSaleChannelsPanel.innerHTML = '<div class="multi-select-empty">No sale channels found</div>';
                updateGlobalSaleChannelsLabel();
                return;
            }
            channels.forEach(ch => {
                const label = document.createElement('label');
                label.className = 'multi-select-option';
                const input = document.createElement('input');
                input.type = 'checkbox';
                input.value = ch.id;
                input.dataset.label = ch.name ? `${ch.name} (${ch.id})` : ch.id;
                input.checked = selectedIds.has(String(ch.id));
                input.addEventListener('change', () => {
                    const ids = Array.from(globalSaleChannelsPanel.querySelectorAll('input[type="checkbox"]:checked')).map(i => i.value);
                    setSelectedGlobalSaleChannelIds(ids);
                    updateGlobalSaleChannelsLabel();
                    if (ids.length) {
                        globalSaleChannelsField?.classList.remove('has-error');
                        if (globalSaleChannelsError) globalSaleChannelsError.textContent = '';
                    }
                });
                const text = document.createElement('span');
                text.textContent = input.dataset.label;
                label.appendChild(input);
                label.appendChild(text);
                globalSaleChannelsPanel.appendChild(label);
            });
            const validIds = new Set(channels.map(c => String(c.id)));
            const pruned = Array.from(selectedIds).filter(id => validIds.has(id));
            const prunedSet = new Set(pruned);
            globalSaleChannelsPanel.querySelectorAll('input[type="checkbox"]').forEach(i => {
                i.checked = prunedSet.has(i.value);
            });
            setSelectedGlobalSaleChannelIds(pruned);
            updateGlobalSaleChannelsLabel();
        } catch (err) {
            globalSaleChannelsPanel.innerHTML = '<div class="multi-select-empty">Could not load sale channels</div>';
            console.error('Failed to load sale channels:', err);
        }
    }

    if (globalLocationSelect) {
        globalLocationSelect.addEventListener('change', function () {
            setSelectedGlobalLocationId(this.value || '');
            if (this.value) {
                globalLocationField?.classList.remove('has-error');
                if (globalLocationError) globalLocationError.textContent = '';
            }
        });
    }

    if (globalSaleChannelsToggle && globalSaleChannelsPanel) {
        globalSaleChannelsToggle.addEventListener('click', function () {
            if (globalSaleChannelsPanel.hidden) openGlobalSaleChannels();
            else closeGlobalSaleChannels();
        });
        document.addEventListener('click', function (e) {
            if (!globalSaleChannelsContainer?.contains(e.target)) closeGlobalSaleChannels();
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') closeGlobalSaleChannels();
        });
    }

    // Update storeSelected based on localStorage
    if (selectedStore) {
        window.storeSelected = true;
        // Show the file sections
        document.getElementById('files-section').style.display = 'block';
        document.getElementById('upload-section').style.display = 'block';
        if (globalStoreConfig) globalStoreConfig.style.display = 'flex';
        loadGlobalLocations();
        loadGlobalSaleChannels();
    }

    // Store selector is now handled by inline script in base.html template



    let selectedFile = null;

    function isDoneFilename(filename) {
        return filename.toLowerCase().includes('__done__');
    }

    function getSyncButtonText(filename) {
        return isDoneFilename(filename) ? '↻ Re-sync' : '▶ Sync';
    }

    // Handle file upload
    function handleUploadForm() {
        if (!uploadForm) return;
        uploadForm.addEventListener("submit", async function (e) {
            e.preventDefault();
            responseBox.textContent = "Uploading...";
            try {
                const res = await fetch(uploadForm.action, {
                    method: "POST",
                    body: new FormData(uploadForm),
                });
                const result = await res.json();
                console.log(result);

                responseBox.textContent = res.ok
                    ? JSON.stringify(result, null, 2)
                    : `Response error: ${res.status} - ${result.detail}`;

                loadFiles()
            } catch (err) {
                responseBox.textContent = "Error: " + err;
            }
        });
    }

    // Render file list with check buttons (no sync buttons initially)
    function renderFileList(files) {
        if (!Array.isArray(files) || files.length === 0) {
            list.innerHTML = "<li>No files found.</li>";
            return;
        }
        list.innerHTML = files.map(f => {
            const done = isDoneFilename(f);
            return `<li class="file-row ${done ? 'file-row-done' : ''}" data-filename="${encodeURIComponent(f)}">
                ${done ? '<span class="file-done-badge">DONE</span>' : ''}
                <div class="file-label-wrap">
                    <span>${f}</span>
                </div>
                <div class="file-actions">
                    <button class="check-btn" data-filename="${encodeURIComponent(f)}">Select & Check</button>
                    <button class="view-file-btn" data-filename="${encodeURIComponent(f)}">View</button>
                    <button class="download-btn" data-filename="${encodeURIComponent(f)}">Download</button>
                    <button class="del-btn" data-filename="${encodeURIComponent(f)}">Delete</button>
                </div>
            </li>`;
        }).join("");
        addViewFileButtonListeners();
        addCheckButtonListeners();
        addDownloadButtonListeners();
        addDeleteButtonListeners();
        // Nest each file's quantity backups in a collapsible row beneath it.
        if (window.Backups && window.Backups.attachFileBackups) {
            window.Backups.attachFileBackups(list);
        }
    }
    function showFileNotice(title, message, fix, target = "page") {
        if (!window.CheckReport) {
            return;
        }
        const notice = window.CheckReport.buildNotice({ severity: "blocked", title, message, fix });
        if (target === "modal" && fileModalNotice) {
            fileModalNotice.innerHTML = notice;
        } else {
            responseBox.innerHTML = notice;
        }
    }

    function clearFileNotice(target = "page") {
        if (target === "modal" && fileModalNotice) {
            fileModalNotice.innerHTML = "";
        } else if (target === "page") {
            responseBox.innerHTML = "";
        }
    }

    function buildPreviewTable(data) {
        const wrap = document.createElement("div");
        const hint = document.createElement("p");
        hint.className = "report-hint";
        hint.textContent = `Showing first ${data.row_count || 0} row(s)`
            + (data.truncated ? " — download the file for all rows." : ".");
        wrap.appendChild(hint);

        if (!data.rows || !data.rows.length) {
            const empty = document.createElement("p");
            empty.className = "logs-empty";
            empty.textContent = "This file has no rows.";
            wrap.appendChild(empty);
            return wrap;
        }

        const table = document.createElement("table");
        table.className = "sync-table check-table file-preview-table";
        const thead = document.createElement("thead");
        const headerRow = document.createElement("tr");
        data.columns.forEach(column => {
            const th = document.createElement("th");
            th.textContent = column;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = document.createElement("tbody");
        data.rows.forEach(row => {
            const tr = document.createElement("tr");
            data.columns.forEach((_, index) => {
                const td = document.createElement("td");
                const value = row[index];
                td.textContent = value === "" || value === null || value === undefined ? "—" : String(value);
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        wrap.appendChild(table);
        return wrap;
    }

    async function openFileModal(filename, trigger) {
        if (!fileModal || !fileModalTitle || !fileModalContent) {
            return;
        }
        fileModalTrigger = trigger || null;
        fileModalFilename = filename;
        fileModal.hidden = false;
        document.body.classList.add("modal-open");
        fileModalTitle.textContent = `File Preview — ${filename}`;
        fileModalContent.textContent = "Loading preview...";
        fileModalDownloadBtn.style.display = "inline-block";
        clearFileNotice("modal");
        fileModalCloseBtn?.focus();

        try {
            const res = await fetch(`/api/v1/resources/preview/${encodeURIComponent(filename)}?rows=20`);
            const data = await res.json();
            if (!res.ok) {
                showFileNotice(
                    "Couldn't preview this file",
                    data.detail || `The server returned HTTP ${res.status}.`,
                    "Download the file to inspect it, or try again.",
                    "modal",
                );
                fileModalContent.textContent = "Preview unavailable.";
                return;
            }
            fileModalContent.replaceChildren(buildPreviewTable(data));
        } catch (err) {
            showFileNotice(
                "Couldn't preview this file",
                String(err && err.message ? err.message : err),
                "Check your connection and try again.",
                "modal",
            );
            fileModalContent.textContent = "Preview unavailable.";
        }
    }

    function closeFileModal() {
        if (!fileModal) {
            return;
        }
        fileModal.hidden = true;
        document.body.classList.remove("modal-open");
        clearFileNotice("modal");
        fileModalContent.textContent = "Loading...";
        fileModalFilename = null;
        if (fileModalTrigger && document.contains(fileModalTrigger)) {
            fileModalTrigger.focus();
        }
        fileModalTrigger = null;
    }

    function addViewFileButtonListeners() {
        list.querySelectorAll(".view-file-btn").forEach(btn => {
            btn.addEventListener("click", function () {
                const filename = decodeURIComponent(this.getAttribute("data-filename"));
                openFileModal(filename, this);
            });
        });
    }

    async function downloadFile(filename, target = "page") {
        const url = `/api/v1/resources/${encodeURIComponent(filename)}?download=1`;
        const selectedStore = localStorage.getItem('selectedStore');
        try {
            const res = await fetch(url, {
                headers: selectedStore ? { 'X-Selected-Store': selectedStore } : {}
            });
            if (!res.ok) {
                showFileNotice(
                    "Couldn't download the file",
                    (await res.text()) || `The server returned HTTP ${res.status}.`,
                    "Check the file permissions and try again.",
                    target,
                );
                return;
            }
            const blob = await res.blob();
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                URL.revokeObjectURL(a.href);
                a.remove();
            }, 100);
        } catch (err) {
            showFileNotice(
                "Couldn't download the file",
                String(err && err.message ? err.message : err),
                "Check your connection and try again.",
                target,
            );
        }
    }

    // Add event listeners to download buttons
    function addDownloadButtonListeners() {
        list.querySelectorAll(".download-btn").forEach(btn => {
            btn.addEventListener("click", async function () {
                const filename = decodeURIComponent(this.getAttribute("data-filename"));
                await downloadFile(filename);
            });
        });
    }

    // Copy / expand handlers for the preflight status card.
    let currentCheckIssues = [];

    async function copyText(text) {
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (err) {
            // Fall back to the legacy copy path below.
        }
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        try {
            return document.execCommand("copy");
        } finally {
            textarea.remove();
        }
    }

    responseBox.addEventListener("click", async (event) => {
        const toggle = event.target.closest("[data-toggle-issue]");
        if (toggle) {
            const index = Number(toggle.getAttribute("data-toggle-issue"));
            const card = toggle.closest(".issue-card");
            const full = responseBox.querySelector(`#issue-items-${index}`);
            const preview = card && card.querySelector(".issue-items--preview");
            const expanded = toggle.getAttribute("aria-expanded") === "true";
            if (full) full.hidden = expanded;
            if (preview) preview.hidden = !expanded;
            toggle.setAttribute("aria-expanded", String(!expanded));
            toggle.textContent = expanded ? toggle.dataset.collapsedLabel : "Show less";
            return;
        }

        const copyButton = event.target.closest("[data-copy-issue]");
        if (copyButton) {
            const issue = currentCheckIssues[Number(copyButton.getAttribute("data-copy-issue"))];
            if (!issue || !issue.items.length) return;
            const originalLabel = copyButton.textContent;
            const copied = await copyText(issue.items.join("\n"));
            copyButton.textContent = copied ? "Copied ✓" : "Copy failed";
            setTimeout(() => { copyButton.textContent = originalLabel; }, 1800);
        }
    });

    function focusCheckStatus() {
        responseBox.querySelector("[data-check-status]")?.focus({ preventScroll: true });
    }

    function revealResults() {
        if (!resultsSection || !resultsSection.scrollIntoView) {
            return;
        }
        const reduceMotion = window.matchMedia
            && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        resultsSection.scrollIntoView({
            behavior: reduceMotion ? "auto" : "smooth",
            block: "start",
        });
    }

    function renderCheckError(filename, title, message, fix) {
        const data = {
            ready_to_sync: false,
            issues: [{
                code: "check_request_failed",
                severity: "blocking",
                title: title,
                explanation: message,
                fix: fix || "Try the check again.",
                items: [],
            }],
        };
        currentCheckIssues = window.CheckReport.normalizeIssues(data);
        responseBox.innerHTML = window.CheckReport.buildStatus(data, filename, {
            showDetails: false,
            title: title,
            subtitle: "The preflight check could not be completed.",
        });
        revealResults();
        focusCheckStatus();
    }

    // Check file structure and show configuration if needed
    async function checkFileStructure(filename) {
        try {
            // Reset the sync config panel first
            resetSyncConfig();

            const params = getGlobalConfigParams();
            const query = params.toString();
            const url = query ? `/api/v1/check/${filename}?${query}` : `/api/v1/check/${filename}`;
            const res = await fetch(url, { method: "GET" });

            let data;
            try {
                data = await res.json();
            } catch (err) {
                renderCheckError(
                    filename,
                    "The check response could not be read",
                    `The server returned HTTP ${res.status}.`,
                    "Try again in a moment.",
                );
                return;
            }
            if (!res.ok) {
                renderCheckError(
                    filename,
                    "The check could not be completed",
                    data.detail || `The server returned HTTP ${res.status}.`,
                    "Check the selected store and file name, then try again.",
                );
                return;
            }

            selectedFile = filename;
            currentCheckIssues = window.CheckReport.normalizeIssues(data);
            const hasBlocking = currentCheckIssues.some(issue => issue.severity === "blocking");
            const summary = window.CheckReport.buildSummary(data, filename, { showWarnings: false });
            const status = window.CheckReport.buildStatus(data, filename, {
                detailsOpen: Boolean(data.ready_to_sync && !hasBlocking),
            });

            if (data.ready_to_sync && !hasBlocking) {
                clearGlobalConfigErrors();
                showSyncModeSelection();
                addSyncButtonToListItem(filename);
            } else if ((data.missing_fields || []).length) {
                showGlobalConfigErrors(data.missing_fields);
            } else {
                clearGlobalConfigErrors();
            }

            responseBox.innerHTML = summary + status;
            revealResults();
            focusCheckStatus();
        } catch (err) {
            renderCheckError(
                filename,
                "The check could not be completed",
                String(err && err.message ? err.message : err),
                "Check your connection and try again.",
            );
        }
    }


    // Reset sync configuration panel
    function resetSyncConfig() {
        syncConfig.innerHTML = "";
        syncConfig.style.display = "none";
    }

    // Show sync mode selection panel (without the sync button)
    function showSyncModeSelection() {
        syncConfig.innerHTML = `
            <h2>Quantity Update Strategy</h2>
            <p style="color: #bdbdbd; font-size: 1rem; margin-bottom: 1em;">
                Choose how inventory quantities should be updated:
            </p>
            <div style="display: flex; gap: 1em; flex-wrap: wrap; margin-bottom: 1.5em;">
                <button class="sync-mode-btn disabled" disabled data-mode="tabula_rasa">
                    <strong>Tabula Rasa</strong>
                    <p style="font-size: 0.85em; margin-top: 5px; color: #bdbdbd;">Set all to 0, then apply file values</p>
                </button>
                
                <button class="sync-mode-btn active" data-mode="adjust">
                    <strong>Adjust Quantity</strong>
                    <p style="font-size: 0.85em; margin-top: 5px; color: #bdbdbd;">Add/subtract from existing</p>
                </button>
                
                <button class="sync-mode-btn disabled" data-mode="replace" disabled>
                    <strong>Replace Quantity</strong>
                    <p style="font-size: 0.85em; margin-top: 5px; color: #bdbdbd;">Set to exact file values</p>
                </button>
            </div>
            <input type="hidden" id="selected-sync-mode" value="adjust">
        `;
        syncConfig.style.display = "block";

        // Add sync mode button listeners
        const syncModeButtons = document.querySelectorAll('.sync-mode-btn');
        const selectedModeInput = document.getElementById('selected-sync-mode');

        syncModeButtons.forEach(btn => {
            btn.addEventListener('click', function () {
                syncModeButtons.forEach(b => {
                    b.classList.remove('active');
                    b.style.borderColor = '#444';
                });
                this.classList.add('active');
                this.style.borderColor = 'var(--color-primary)';
                selectedModeInput.value = this.dataset.mode;
            });
        });
    }

    // Add sync button to the specific file list item
function addSyncButtonToListItem(filename) {
        const decodedFilename = decodeURIComponent(filename);
        const listItems = list.querySelectorAll('li');
        
        listItems.forEach(item => {
            const span = item.querySelector('span');
            const checkBtn = item.querySelector('.check-btn');
            
            // Try multiple matching approaches
            let matchFound = false;
            
            // Check 1: Exact text match
            if (span && span.textContent === decodedFilename) {
                matchFound = true;
            }
            // Check 2: Check button data-filename attribute
            if (!matchFound && checkBtn) {
                const btnFilename = decodeURIComponent(checkBtn.getAttribute('data-filename') || '');
                if (btnFilename === decodedFilename || btnFilename === filename) {
                    matchFound = true;
                }
            }
            
            if (matchFound) {
                const buttonContainer = item.querySelector('.file-actions');
                if (!buttonContainer) {
                    return;
                }
                // Remove any existing sync button first
                const existingSyncBtn = buttonContainer.querySelector('.sync-btn');
                if (existingSyncBtn) {
                    existingSyncBtn.remove();
                }
                
                // If check button doesn't exist, create one or add sync button
                if (!checkBtn) {
                    return;
                }
                
                const syncBtn = document.createElement('button');
                syncBtn.className = 'sync-btn';
                syncBtn.setAttribute('data-filename', encodeURIComponent(decodedFilename));
                syncBtn.textContent = getSyncButtonText(decodedFilename);
                const isResync = isDoneFilename(decodedFilename);
                syncBtn.style.cssText = isResync 
                    ? 'background: var(--color-error); color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; margin-left: 5px; font-weight: bold;'
                    : 'background: var(--color-highlight); color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; margin-left: 5px;';
                syncBtn.onclick = () => {
                    const mode = document.getElementById('selected-sync-mode')?.value || 'adjust';
                    syncFile(decodedFilename, mode);
                };
                checkBtn.insertAdjacentElement('beforebegin', syncBtn);
            }
        });
    }



    // Sync file
    async function syncFile(filename, syncMode = 'adjust') {
        try {
            const modeLabels = {
                'adjust': 'Adjusting',
                'replace': 'Replacing',
                'tabula_rasa': 'Resetting & Setting'
            };

            // Show initial loading message
            responseBox.innerHTML = `
                <div style="display: flex; flex-direction: column; justify-content: center; align-items: center; padding: 40px;">
                    <div class="loader"></div>
                    <p id="progress-message" style="margin-top: 20px; color: var(--color-primary);">${modeLabels[syncMode]} quantities for "${filename}"...</p>
                    <p style="color: #bdbdbd; font-size: 0.9rem;">Preparing sync...</p>
                </div>
            `;

            document.getElementById('upload-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });

            // Disable inline sync button
            const inlineSyncBtn = list.querySelector(`button.sync-btn[data-filename="${encodeURIComponent(filename)}"]`);
            if (inlineSyncBtn) {
                inlineSyncBtn.disabled = true;
                inlineSyncBtn.textContent = 'Syncing...';
            }

            // Get selected store from localStorage
            const selectedStore = localStorage.getItem('selectedStore');

            // Create FormData for the POST request
            const formData = new FormData();
            formData.append('sync_mode', syncMode);
            appendGlobalConfigToFormData(formData);

            // We can't use EventSource with POST, so we'll use fetch with streaming
            const response = await fetch(`/api/v1/sync/${filename}`, {
                method: 'POST',
                headers: selectedStore ? {
                    'X-Selected-Store': selectedStore
                } : {},
                body: formData
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            console.log('🚀 Starting SSE stream reading...');

            while (true) {
                const { done, value } = await reader.read();

                if (done) {
                    console.log('✅ SSE stream completed');
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');

                // Keep the last incomplete line in the buffer
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.trim() === '') continue; // Skip empty lines

                    console.log('📥 Raw line:', line);

                    if (line.startsWith('data: ')) {
                        const jsonStr = line.substring(6);
                        console.log('📦 JSON string:', jsonStr);
                        try {
                            const data = JSON.parse(jsonStr);
                            console.log('✨ Parsed data:', data);

                            if (data.type === 'start') {
                                responseBox.innerHTML = `
                                    <div style="display: flex; flex-direction: column; justify-content: center; align-items: center; padding: 40px;">
                                        <div class="loader"></div>
                                        <p id="sync-title" style="margin-top: 20px; color: var(--color-primary); font-size: 1.2rem; font-weight: bold;">${modeLabels[syncMode]} quantities for "${filename}"...</p>
                                        
                                        <!-- Progress Bar -->
                                        <div class="progress-bar-container" style="width: 80%; margin: 20px 0;">
                                            <div id="progress-bar" class="progress-bar" style="width: 10%;"></div>
                                        </div>
                                        
                                        <p id="progress-count" style="color: #bdbdbd; font-size: 1.1rem; margin-top: 10px;">Starting sync with ${data.total} items...</p>
                                        
                                        <!-- Progress Steps -->
                                        <div id="progress-steps" style="margin-top: 20px; width: 80%; max-width: 600px;">
                                            <div id="step-loading" class="progress-step" data-step="loading">
                                                <span class="progress-step-icon">📦</span>
                                                <span class="progress-step-text">Loading items from file</span>
                                                <span class="progress-step-time"></span>
                                            </div>
                                            <div id="step-searching" class="progress-step" data-step="searching">
                                                <span class="progress-step-icon">🔍</span>
                                                <span class="progress-step-text">Searching Shopify catalog</span>
                                                <span class="progress-step-time"></span>
                                            </div>
                                            <div id="step-processing" class="progress-step" data-step="processing">
                                                <span class="progress-step-icon">⚙️</span>
                                                <span class="progress-step-text">Processing products</span>
                                                <span class="progress-step-time"></span>
                                            </div>
                                            <div id="step-updating" class="progress-step" data-step="updating">
                                                <span class="progress-step-icon">📊</span>
                                                <span class="progress-step-text">Updating inventory</span>
                                                <span class="progress-step-time"></span>
                                            </div>
                                            <div id="step-saving" class="progress-step" data-step="saving">
                                                <span class="progress-step-icon">💾</span>
                                                <span class="progress-step-text">Saving changes</span>
                                                <span class="progress-step-time"></span>
                                            </div>
                                        </div>
                                    </div>
                                `;
                            } else if (data.type === 'status') {
                                const progressCount = document.getElementById('progress-count');
                                const progressBar = document.getElementById('progress-bar');

                                console.log('Status update:', data.message);
                                console.log('Progress bar element:', progressBar);

                                if (progressCount) {
                                    progressCount.innerHTML = `<span style="font-size: 1.3rem;">${data.message}</span>`;
                                }

                                // Update progress bar and steps based on message
                                const message = data.message.toLowerCase();
                                let currentStep = null;
                                let progress = 0;

                                if (message.includes('loading')) {
                                    currentStep = 'loading';
                                    progress = 20;
                                } else if (message.includes('searching') || message.includes('catalog')) {
                                    document.getElementById('step-loading')?.classList.add('completed');
                                    currentStep = 'searching';
                                    progress = 35;
                                } else if (message.includes('processing') || message.includes('elapsed')) {
                                    document.getElementById('step-loading')?.classList.add('completed');
                                    document.getElementById('step-searching')?.classList.add('completed');
                                    currentStep = 'processing';
                                    progress = 50;
                                } else if (message.includes('matched') || message.includes('products in shopify')) {
                                    document.getElementById('step-loading')?.classList.add('completed');
                                    document.getElementById('step-searching')?.classList.add('completed');
                                    document.getElementById('step-processing')?.classList.add('completed');
                                    progress = 65;
                                } else if (message.includes('adjusting') || message.includes('replacing') || message.includes('resetting') || message.includes('inventory')) {
                                    document.getElementById('step-loading')?.classList.add('completed');
                                    document.getElementById('step-searching')?.classList.add('completed');
                                    document.getElementById('step-processing')?.classList.add('completed');
                                    currentStep = 'updating';
                                    progress = 80;
                                } else if (message.includes('saving')) {
                                    document.getElementById('step-loading')?.classList.add('completed');
                                    document.getElementById('step-searching')?.classList.add('completed');
                                    document.getElementById('step-processing')?.classList.add('completed');
                                    document.getElementById('step-updating')?.classList.add('completed');
                                    currentStep = 'saving';
                                    progress = 95;
                                }

                                console.log('Progress:', progress + '%', 'Current step:', currentStep);

                                // Update active step
                                if (currentStep) {
                                    document.querySelectorAll('.progress-step').forEach(step => {
                                        step.classList.remove('active');
                                    });
                                    const stepEl = document.getElementById(`step-${currentStep}`);
                                    if (stepEl) {
                                        stepEl.classList.add('active');
                                        const timeEl = stepEl.querySelector('.progress-step-time');
                                        if (timeEl) {
                                            timeEl.textContent = new Date().toLocaleTimeString();
                                        }
                                    }
                                }

                                // Animate progress bar
                                if (progressBar && progress > 0) {
                                    console.log('Setting progress bar width to:', progress + '%');
                                    progressBar.style.width = progress + '%';
                                }
                            } else if (data.type === 'progress') {
                                const progressCount = document.getElementById('progress-count');
                                if (progressCount) {
                                    progressCount.innerHTML = `<span style="font-size: 1.3rem;">Processing item ${data.current}/${data.total}...</span>`;
                                }
                            } else if (data.type === 'complete') {
                                const succeeded = data.success !== false && data.status !== 'failed';
                                // Only mark the progress flow as completed on success.
                                if (succeeded) {
                                    document.querySelectorAll('.progress-step').forEach(step => {
                                        step.classList.add('completed');
                                        step.classList.remove('active');
                                    });
                                    // Set progress bar to 100%
                                    const progressBar = document.getElementById('progress-bar');
                                    if (progressBar) {
                                        progressBar.style.width = '100%';
                                    }
                                }
                                // Wait a moment to show completion, then show results
                                setTimeout(() => {
                                    responseBox.innerHTML = window.SyncTable.buildSyncTable(data);
                                    // Hide the sync config and reset state
                                    resetSyncConfig();
                                    selectedFile = null;
                                    loadFiles();
                                }, 800);
                            } else if (data.type === 'error') {
                                responseBox.textContent = "Sync error: " + data.error;
                                // Re-enable inline sync button on error
                                if (inlineSyncBtn) {
                                    inlineSyncBtn.disabled = false;
                                    inlineSyncBtn.textContent = '▶ Sync';
                                }
                            }
                        } catch (e) {
                            console.error('❌ Error parsing SSE JSON:', e);
                            console.error('❌ Failed JSON string:', jsonStr);
                        }
                    }
                }
            }

        } catch (err) {
            console.error('❌ Sync error:', err);
            responseBox.textContent = "Sync error: " + err;
            // Re-enable inline sync button on error
            const inlineSyncBtn = list.querySelector(`button.sync-btn[data-filename="${encodeURIComponent(filename)}"]`);
            if (inlineSyncBtn) {
                inlineSyncBtn.disabled = false;
                inlineSyncBtn.textContent = '▶ Sync';
            }
        }
    }

    function loadingSpinner(show) {
        return `
            <div class="spinner" style="display: flex; justify-content: center; align-items: center; height: 100px;">
                <div class="loader"></div>
            </div>
        `;
    }


    // Make this function global so it can be called from inline onclick
    window.copyMissingSKUs = function (missing_skus) {
        const skus = missing_skus || [];
        const btn = document.querySelector(".copy-all-btn");
        const originalText = btn.querySelector("span").innerHTML;

        if (skus.length === 0) return;
        const textToCopy = skus.join("\n");
        navigator.clipboard.writeText(textToCopy).then(() => {
            btn.querySelector("span").innerHTML = "Copied!";
            setTimeout(() => {
                btn.querySelector("span").innerHTML = originalText;
            }, 2000);
        }).catch(err => {
            alert("Failed to copy SKUs: " + err);
        });
    }

    // Function to copy error SKUs (missing or duplicate) from the check report
    window.copyErrorSKUs = function (skus_array, type) {
        const skus = skus_array || [];
        const btnClass = type === "missing" ? ".copy-missing-btn" : ".copy-duplicate-btn";
        const btn = document.querySelector(btnClass);
        if (!btn) return;

        const originalText = btn.querySelector("span").innerHTML;

        if (skus.length === 0) return;
        const textToCopy = skus.join("\n");
        navigator.clipboard.writeText(textToCopy).then(() => {
            btn.querySelector("span").innerHTML = "✓ Copied!";
            setTimeout(() => {
                btn.querySelector("span").innerHTML = originalText;
            }, 2000);
        }).catch(err => {
            alert("Failed to copy SKUs: " + err);
        });
    }

    // Add event listeners to check buttons
    function addCheckButtonListeners() {
        list.querySelectorAll(".check-btn").forEach(btn => {
            btn.addEventListener("click", async function () {
                const filename = decodeURIComponent(this.getAttribute("data-filename"));
                this.disabled = true;
                this.textContent = "Checking...";

                await checkFileStructure(filename);

                this.textContent = "Select & Check";
                this.disabled = false;
            });
        });
    }

    // Add event listeners to delete buttons
    function addDeleteButtonListeners() {
        list.querySelectorAll(".del-btn").forEach(btn => {
            btn.addEventListener("click", async function () {
                const filename = this.getAttribute("data-filename");
                if (confirm(`Delete file "${decodeURIComponent(filename)}"?`)) {
                    await deleteFile(this, filename);
                }
            });
        });
    }

    // Delete file handler
    async function deleteFile(button, filename) {
        button.disabled = true;
        button.textContent = "Deleting...";
        try {
            const res = await fetch(`/api/v1/resources/${filename}`, { method: "DELETE" });
            const data = await res.json();
            if (res.ok) {
                button.closest("li").remove();
                // Hide sync config if this was the selected file
                if (selectedFile === decodeURIComponent(filename)) {
                    syncConfig.style.display = "none";
                    selectedFile = null;
                }
            } else {
                button.textContent = "Failed";
                alert(data.detail || "Delete failed");
                button.disabled = false;
                button.textContent = "Del";
            }
        } catch (err) {
            button.textContent = "Error";
            alert("Delete error: " + err);
            button.disabled = false;
            button.textContent = "Del";
        }

        loadFiles()
    }

    // Fetch and display files
    async function loadFiles() {
        // Don't load files if no store is selected
        if (!window.storeSelected) {
            return;
        }

        try {
            const res = await fetch("/api/v1/resources");
            if (res.ok) {
                const files = await res.json();
                renderFileList(files);
            } else {
                list.innerHTML = "<li>Could not load files.</li>";
            }
        } catch {
            list.innerHTML = "<li>Error loading files.</li>";
        }
    }

    if (fileModal) {
        fileModal.addEventListener("click", (event) => {
            if (event.target.closest("[data-close-file-modal]")) {
                closeFileModal();
            }
        });
    }

    if (fileModalDownloadBtn) {
        fileModalDownloadBtn.addEventListener("click", async function () {
            if (fileModalFilename) {
                await downloadFile(fileModalFilename, "modal");
            }
        });
    }

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && fileModal && !fileModal.hidden) {
            closeFileModal();
        }
    });

    // Initialize
    handleUploadForm();
    loadFiles();
});