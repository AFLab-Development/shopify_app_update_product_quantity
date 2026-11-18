const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSummary, buildReport, targetText } = require('../app/views/static/check_report.js');

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
