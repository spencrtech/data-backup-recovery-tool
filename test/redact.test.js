const test = require('node:test');
const assert = require('node:assert/strict');
const { redactSensitive } = require('../src/redact');

test('redacts credentials from MongoDB tool errors', () => {
    const error = 'failed to connect to mongodb+srv://backup-user:very-secret@example.mongodb.net: x509 error';
    const redacted = redactSensitive(error);
    assert.equal(redacted.includes('backup-user'), false);
    assert.equal(redacted.includes('very-secret'), false);
    assert.match(redacted, /mongodb\+srv:\/\/\[credentials-redacted\]@example\.mongodb\.net/);
});
