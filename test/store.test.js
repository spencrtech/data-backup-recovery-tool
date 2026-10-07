const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');

test('encrypted configuration is not stored as plaintext', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spencer-store-'));
    const store = await Store.create(directory);
    const secret = { uri: 'mongodb://user:very-secret@example.test/app', database: 'app' };
    const encrypted = store.encrypt(secret);
    assert.equal(encrypted.includes('very-secret'), false);
    assert.deepEqual(store.decrypt(encrypted), secret);
    assert.equal(fs.statSync(path.join(directory, 'master.key')).mode & 0o777, 0o600);
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
});

test('startup scrubs credentials from historical job errors', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spencer-redaction-'));
    let store = await Store.create(directory);
    store.db.prepare(`INSERT INTO jobs (id, type, source_id, destination_ids, trigger, status, error)
        VALUES ('job-secret', 'backup', 'source', '[]', 'manual', 'failed', ?)`)
        .run('failed mongodb://admin:exposed-password@example.test');
    store.close();

    store = await Store.create(directory);
    const error = store.db.prepare("SELECT error FROM jobs WHERE id = 'job-secret'").get().error;
    assert.equal(error.includes('admin'), false);
    assert.equal(error.includes('exposed-password'), false);
    assert.match(error, /\[credentials-redacted\]/);
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
});
