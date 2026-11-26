const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildSummary, buildReport, buildStatus, buildNotice, normalizeIssues, targetText,
} = require('../app/views/static/check_report.js');

function data(overrides = {}) {
    const row = (i) => ({
        row: i,
        reference: `805813642799${i}`,
        quantity: '1',
        quantity_number: 1,
        location_id: '115117195591',
        location_name: 'RefrigiWear® Store Napoli',
        sale_channel: '176929734983',
        matched: true,
        product_id: '9653471084871',
        variant_title: `S / COLOR ${i}`,
        inventory_item_id: `gid://shopify/InventoryItem/${i}`,
        current_available: 4,
        stock_status: "ok",
        change: "+1",
        projected_after_adjust: 5,
    });
    const rows = Array.from({ length: 25 }, (_, i) => row(i + 1));
    return {
        ready_to_sync: true,
        summary: {
            rows: 25, matched: 25, missing: 0, duplicates: 0,
            total_quantity: 23, zero_quantity_rows: 0,
            negative_quantity_rows: 0, invalid_quantity_rows: 0,
        },
        target: {
            location_ids: [{ id: '115117195591', name: 'RefrigiWear® Store Napoli', known: true }],
            sale_channels: [{ id: '176929734983', name: 'Point of Sale', known: true }],
        },
        warnings: [{ level: 'info', message: 'Target location: RefrigiWear® Store Napoli.' }],
        rows,
        preview: rows.slice(0, 20),
        ...overrides,
    };
}

test('summary tiles show rows, matches, skips and signed total', () => {
    const html = buildSummary(data(), 'check.xlsx');
    assert.match(html, /Preflight report — check\.xlsx/);
    assert.match(html, /Rows<\/span><strong>25<\/strong>/);
    assert.match(html, /Matched in Shopify<\/span><strong>25<\/strong>/);
    assert.match(html, /Total quantity<\/span><strong>\+23<\/strong>/);
    assert.match(html, /<strong>Target location:<\/strong> RefrigiWear® Store Napoli \(115117195591\)/);
    assert.match(html, /report-warning--info/);
});

test('preview shows 20 rows and a collapsible full report', () => {
    const html = buildReport(data(), 'check.xlsx');
    // preview (20 rows) + full report (25 rows), each with one header row
    assert.equal((html.match(/<tr>/g) || []).length, 47);
    assert.match(html, /Preview of the first 20 row\(s\)/);
    assert.match(html, /View all 25 rows/);
    assert.match(html, /Current @ target/);
    assert.match(html, /<th>Change<\/th>/);
    assert.match(html, /4<\/td>/);
    assert.match(html, /\+1<\/td>/);
    assert.match(html, /5<\/td>/);
    assert.match(html, /Replace mode sets the value to the file quantity/);
});

test('not-stocked rows show zero current and a real projected value', () => {
    const notStocked = {
        ...data().rows[0],
        current_available: 0,
        stock_status: "not_stocked",
        change: "+2",
        projected_after_adjust: 2,
    };
    const html = buildReport(data({ rows: [notStocked], preview: [notStocked] }), 'check.xlsx');
    assert.match(html, /0 \(not stocked\)/);
    assert.match(html, /\+2<\/td>/);
    assert.match(html, /2<\/td>/);
    assert.doesNotMatch(html, /Not stocked yet/);
});

test('target text uses the location name and id', () => {
    assert.equal(targetText(data()), 'RefrigiWear® Store Napoli (115117195591)');
    assert.equal(targetText({ target: { location_ids: [] } }), '—');
});

test('escapes untrusted values in warnings and rows', () => {
    const d = data({
        warnings: [{ level: 'warning', message: '<script>alert(1)</script>' }],
        rows: [{ ...data().rows[0], reference: '<img src=x>', product_id: '<b>x</b>' }],
        preview: [{ ...data().rows[0], reference: '<img src=x>', product_id: '<b>x</b>' }],
    });
    const html = buildReport(d, '<file>.xlsx');
    assert.doesNotMatch(html, /<script>/);
    assert.doesNotMatch(html, /<img src=x>/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&lt;img src=x&gt;/);
});

test('summary can leave warnings to the status card', () => {
    assert.match(buildSummary(data(), 'x.xlsx'), /report-warning--info/);
    assert.doesNotMatch(buildSummary(data(), 'x.xlsx', { showWarnings: false }), /report-warning/);
});

test('blocking status card renders actionable issues without inline handlers', () => {
    const d = data({
        ready_to_sync: false,
        issues: [
            {
                code: 'missing_skus', severity: 'blocking',
                title: '2 SKUs not found in Shopify',
                explanation: "These products don't exist in the selected store.",
                fix: 'Correct the SKU/barcode.', count: 2, items: ['ABC', 'DEF'],
            },
            {
                code: 'duplicate_skus', severity: 'blocking',
                title: '1 duplicate SKU in the file',
                explanation: 'These SKUs appear more than once.',
                fix: 'Keep one row per SKU.', count: 1, items: ['XYZ'],
            },
        ],
    });
    const html = buildStatus(d, 'file.xlsx');
    assert.match(html, /check-status--blocked/);
    assert.match(html, /role="alert"/);
    assert.match(html, /How to fix:<\/strong> Correct the SKU\/barcode\./);
    assert.match(html, /data-copy-issue="0"/);
    assert.match(html, /issue-items--preview/);
    assert.doesNotMatch(html, /onclick=/);
    assert.match(html, /View detailed report/);
});

test('long SKU lists are collapsed behind a Show all toggle', () => {
    const d = data({
        ready_to_sync: false,
        issues: [{
            code: 'missing_skus', severity: 'blocking',
            title: '6 SKUs not found in Shopify', count: 6,
            items: ['A', 'B', 'C', 'D', 'E', 'F'],
        }],
    });
    const html = buildStatus(d, 'file.xlsx', { showDetails: false });
    assert.match(html, /data-toggle-issue="0"/);
    assert.match(html, /data-collapsed-label="Show all 6"/);
    assert.match(html, /id="issue-items-0" hidden/);
});

test('ready status card keeps the report open', () => {
    const html = buildStatus(data(), 'ok.xlsx', { detailsOpen: true });
    assert.match(html, /check-status--ready/);
    assert.match(html, /<details class="check-status__details" open>/);
    assert.match(html, /File preview/);
});

test('status card escapes untrusted issue text and SKUs', () => {
    const d = data({
        ready_to_sync: false,
        issues: [{
            code: 'missing_skus', severity: 'blocking',
            title: '<img src=x>', explanation: '<script>alert(1)</script>',
            fix: '<b>do this</b>', items: ['A&<B>'],
        }],
    });
    const html = buildStatus(d, '<file>.xlsx', { showDetails: false });
    assert.doesNotMatch(html, /<script>/);
    assert.doesNotMatch(html, /<img src=x>/);
    assert.match(html, /&lt;img src=x&gt;/);
    assert.match(html, /A&amp;&lt;B&gt;/);
    assert.doesNotMatch(html, /View detailed report/);
});

test('shared notice escapes text and keeps the blocking role', () => {
    const html = buildNotice({
        severity: 'blocked', title: 'Could not load logs',
        message: '<script>alert(1)</script>', fix: 'Try refreshing.',
    });
    assert.match(html, /check-status--blocked app-notice/);
    assert.match(html, /role="alert"/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
});

test('legacy check payload without issues still renders a blocking card', () => {
    const d = data({ ready_to_sync: false, issues: undefined, missing_rows: ['OLD-SKU'] });
    const html = buildStatus(d, 'old.xlsx', { showDetails: false });
    assert.match(html, /check-status--blocked/);
    assert.match(html, /OLD-SKU/);
    const issues = normalizeIssues(d);
    assert.equal(issues[0].code, 'missing_skus');
    assert.equal(issues[0].severity, 'blocking');
});
