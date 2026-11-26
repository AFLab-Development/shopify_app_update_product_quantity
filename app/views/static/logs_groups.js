/*
 * Grouping for the Store Logs page.
 * Pure functions, also unit tested with node:test.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.LogsGroups = api;
    }
})(typeof window !== "undefined" ? window : null, function () {
    "use strict";

    const RUN_PATTERN = /(?:sync|quantity_changes)_(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.(log|csv)$/i;

    function groupLogs(logs) {
        const groups = new Map();

        (Array.isArray(logs) ? logs : []).forEach((file) => {
            const match = RUN_PATTERN.exec(file.filename || "");
            const runId = match ? match[1] : String(file.filename || "unknown");
            if (!groups.has(runId)) {
                const [date, time] = runId.split("_");
                groups.set(runId, {
                    id: runId,
                    label: match && time
                        ? `${date} ${time.replace(/-/g, ":")}`
                        : (file.filename || "Unknown file"),
                    files: [],
                });
            }
            groups.get(runId).files.push(file);
        });

        return Array.from(groups.values())
            .map((group) => {
                const times = group.files
                    .map(file => file.modified_at || "")
                    .filter(Boolean)
                    .sort();
                return {
                    ...group,
                    files: group.files.slice().sort((a, b) => (
                        String(a.filename).localeCompare(String(b.filename))
                    )),
                    modified_at: times.length ? times[times.length - 1] : "",
                    size_bytes: group.files.reduce((total, file) => total + (Number(file.size_bytes) || 0), 0),
                };
            })
            .sort((a, b) => String(b.modified_at).localeCompare(String(a.modified_at)));
    }

    return { groupLogs, RUN_PATTERN };
});
