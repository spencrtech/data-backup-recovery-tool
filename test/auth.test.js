const test = require('node:test');
const assert = require('node:assert/strict');
const { generateTotpSecret, totpAt, verifyTotpCode, buildOtpAuthUri } = require('../src/auth');

test('authenticator codes follow the standard TOTP algorithm', () => {
    const rfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    assert.equal(totpAt(rfcSecret, 59000), '287082');
    assert.equal(verifyTotpCode(rfcSecret, '287082', 59000), true);
    assert.equal(verifyTotpCode(rfcSecret, '000000', 59000), false);

    const secret = generateTotpSecret();
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.match(buildOtpAuthUri(secret, 'admin', 'Production'), /^otpauth:\/\/totp\//);
});
