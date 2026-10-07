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
