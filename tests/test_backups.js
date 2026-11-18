const test = require("node:test");
const assert = require("node:assert/strict");

const Backups = require("../app/views/static/backups.js");

const backup = {
  id: "20261118_101500_000000_abc123",
  created_at: "2026-11-18T10:15:00",
  source_file: "import_napoli.xlsx",
  sync_mode: "adjust",
  location: { id: "gid://shopify/Location/2", name: "Napoli" },
  current_read_ok: true,
  items: [
    {
      reference: "SKU-1",
      variant_name: 'M <"large">',
      location_id: "gid://shopify/Location/2",
      before_quantity: 8,
      current_quantity: 3,
      target_quantity: 8,
      delta_to_restore: 5,
    },
    {
      reference: "SKU-2",
      variant_name: "L",
      location_id: "gid://shopify/Location/2",
      before_quantity: null,
      current_quantity: 2,
      target_quantity: 0,
      delta_to_restore: -2,
    },
  ],
};

test("backup list is empty-safe and renders each backup", () => {
  assert.match(Backups.renderBackupList([]), /No backups yet/);
  const html = Backups.renderBackupList([backup]);
  assert.match(html, /data-backup-id="20261118_101500_000000_abc123"/);
  assert.match(html, /Napoli/);
  assert.match(html, /backup-restore-btn/);
});

test("backup list escapes untrusted location names", () => {
  const hostile = { ...backup, location: { name: '<img src=x onerror="alert(1)">' } };
  const html = Backups.renderBackupList([hostile]);
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;img"));
});

test("backups group by file and survive the DONE rename", () => {
  const grouped = Backups.groupBackupsByFile([
    backup,
    { ...backup, id: "after", source_file: "IMPORT_NAPOLI__DONE__.xlsx" },
    { ...backup, id: "other", source_file: "other.xlsx" },
  ]);
  assert.equal(grouped.get("import_napoli.xlsx").length, 2);
  assert.equal(grouped.get("other.xlsx").length, 1);
  assert.equal(Backups.fileKey("fixed__done__2.xlsx"), "fixed.xlsx");
});

test("per-file block is a collapsed details with the backups inside", () => {
  assert.equal(Backups.renderFileBackups([]), "");
  const html = Backups.renderFileBackups([backup]);
  assert.match(html, /<details class="file-backups">/);
  assert.match(html, /Quantity backups \(1\)/);
  assert.match(html, /class="backup-detail"/);
  assert.match(html, /backup-restore-btn/);
});

test("backups are injected into the matching row with a plain API path", async () => {
  const row = {
    dataset: { filename: encodeURIComponent("IMPORT_NAPOLI__DONE__.xlsx") },
    inserted: [],
    insertAdjacentHTML(where, html) { this.inserted.push(html); },
  };
  const other = {
    dataset: { filename: encodeURIComponent("unrelated.xlsx") },
    inserted: [],
    insertAdjacentHTML(where, html) { this.inserted.push(html); },
  };
  const listEl = {
    addEventListener() {},
    querySelectorAll(selector) {
      if (selector === "li.file-row") return [row, other];
      return [];
    },
  };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, headers: options.headers });
    return { ok: true, status: 200, json: async () => ({ backups: [backup] }) };
  };

  await Backups.attachFileBackups(
    listEl,
    fetchImpl,
    { getItem: () => "sviluppo" }
  );

  assert.deepEqual(calls.map(c => c.url), ["/api/v1/backups"]);
  assert.equal(calls[0].headers["X-Selected-Store"], "sviluppo");
  assert.equal(row.inserted.length, 1);
  assert.match(row.inserted[0], /file-backups/);
  assert.equal(other.inserted.length, 0);
});

test("restore preview checks every row by default and shows the delta", () => {
  const html = Backups.renderRestorePreview(backup);
  const checked = html.match(/class="backup-item-check"/g) || [];
  assert.equal(checked.length, 2);
  assert.match(html, /\+5/);
  assert.match(html, /-2/);
  assert.match(html, /was unstocked/);
  assert.match(html, /M &lt;&quot;large&quot;&gt;/);
});

test("restore preview disables controls when live stock is unreadable", () => {
  const html = Backups.renderRestorePreview({ ...backup, current_read_ok: false });
  assert.match(html, /restoring is disabled/);
  assert.match(html, /backup-confirm-btn[^>]*disabled/);
});

test("result banner reports success and failure distinctly", () => {
  const ok = Backups.buildResultBanner({ success: true, restored_count: 3, restore_backup_id: "abc" }, true);
  assert.match(ok, /Restore complete/);
  assert.match(ok, /abc/);

  const bad = Backups.buildResultBanner({ success: false, error: 'bad <request>' }, true);
  assert.match(bad, /Restore failed/);
  assert.ok(bad.includes("bad &lt;request&gt;"));
});

test("result banner surfaces the real API error, status and details", () => {
  const result = {
    success: false,
    error: "Inventory verification failed",
    details: { mismatches: [{ expected: 10, actual: 15 }] },
  };
  const html = Backups.buildResultBanner(result, false, 400);

  assert.match(html, /HTTP 400/);
  assert.match(html, /Inventory verification failed/);
  assert.ok(!html.includes("Request failed"));
  assert.match(html, /<pre class="backup-error-details">/);
  assert.match(html, /&quot;expected&quot;: 10/);
  assert.match(html, /&quot;actual&quot;: 15/);
});

test("result banner falls back to detail on network errors", () => {
  const html = Backups.buildResultBanner({ detail: "Network down" }, false);
  assert.match(html, /Network down/);
  assert.ok(!html.includes("Request failed"));
});
