const test = require('node:test');
const assert = require('node:assert/strict');
const { groupLogs, RUN_PATTERN } = require('../app/views/static/logs_groups.js');

function file(filename, opts = {}) {
    return {
        filename,
        size_bytes: opts.size_bytes ?? 100,
        modified_at: opts.modified_at ?? '2026-11-26T15:40:56',
        type: opts.type ?? filename.split('.').pop(),
    };
}

test('pairs a sync log with its quantity changes CSV', () => {
    const groups = groupLogs([
        file('quantity_changes_2026-11-26_15-40-48.csv', { size_bytes: 1100 }),
        file('sync_2026-11-26_15-40-48.log', { size_bytes: 2500 }),
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].id, '2026-11-26_15-40-48');
    assert.equal(groups[0].label, '2026-11-26 15:40:48');
    assert.deepEqual(groups[0].files.map(f => f.filename), [
        'quantity_changes_2026-11-26_15-40-48.csv',
        'sync_2026-11-26_15-40-48.log',
    ]);
    assert.equal(groups[0].size_bytes, 3600);
});

test('sorts runs newest first and keeps unrelated files separate', () => {
    const groups = groupLogs([
        file('sync_2026-11-18_10-32-40.log', { modified_at: '2026-11-18T10:32:49' }),
        file('notes.txt', { modified_at: '2026-11-20T09:00:00' }),
        file('sync_2026-11-26_15-40-48.log', { modified_at: '2026-11-26T15:40:56' }),
    ]);
    assert.equal(groups.length, 3);
    assert.equal(groups[0].id, '2026-11-26_15-40-48');
    assert.equal(groups[1].id, 'notes.txt');
    assert.equal(groups[1].label, 'notes.txt');
    assert.equal(groups[2].id, '2026-11-18_10-32-40');
});

test('recognises only complete run filenames', () => {
    assert.ok(RUN_PATTERN.test('sync_2026-11-26_15-40-48.log'));
    assert.ok(RUN_PATTERN.test('quantity_changes_2026-11-26_15-40-48.csv'));
    assert.equal(RUN_PATTERN.test('sync_short.log'), false);
});
