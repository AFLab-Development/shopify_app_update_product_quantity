const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSyncTable } = require('../app/views/static/sync_table.js');

function level(id, name, quantity) {
    return {
        location: { id, name },
        quantities: [{ name: 'available', quantity }],
    };
}

function payload(levels, location) {
    return {
        type: 'complete',
        data: {
            inventoryAdjustQuantities: {
                inventoryAdjustmentGroup: {
                    changes: [{
                        delta: 2,
                        location: location || {
                            id: 'gid://shopify/Location/115117195591',
                            name: 'RefrigiWear® Store Napoli',
                        },
                        item: {
                            variant: {
                                displayName: 'ORIGINAL VEST - S / SEA TURTLE',
                                product: { handle: 'original-vest-24airm0g03508' },
                            },
                            inventoryLevels: { nodes: levels },
                        },
                    }],
                },
            },
        },
    };
}

const ALL_LEVELS = [
    level('gid://shopify/Location/115117195591', 'RefrigiWear® Store Napoli', 2),
    level('gid://shopify/Location/107277222179', 'RefrigiWear® c/o NIPPON EXPRESS', 8),
    level('gid://shopify/Location/101947474247', 'RefrigiWear® Store Cortina', 0),
];

test('renders only the adjusted location, not every inventory level', () => {
    const html = buildSyncTable(payload(ALL_LEVELS));
    assert.match(html, /RefrigiWear® Store Napoli/);
    assert.doesNotMatch(html, /NIPPON EXPRESS/i);
    assert.doesNotMatch(html, /Cortina/i);
    assert.equal((html.match(/<tr>/g) || []).length, 2); // header + one change
    assert.match(html, /Only the location that was adjusted is shown/);
});

test('shows a placeholder quantity when the changed location is absent from inventory levels', () => {
    const levels = ALL_LEVELS.slice(1); // Napoli (just activated) is missing
    const html = buildSyncTable(payload(levels));
    assert.match(html, /RefrigiWear® Store Napoli/);
    assert.match(html, /—/);
    assert.doesNotMatch(html, /NIPPON EXPRESS/i);
    assert.equal((html.match(/<tr>/g) || []).length, 2);
});

test('escapes product and location names', () => {
    const html = buildSyncTable(payload(ALL_LEVELS, {
        id: 'gid://shopify/Location/1',
        name: '<script>alert(1)</script>',
    }));
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
});
