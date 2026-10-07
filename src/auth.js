const crypto = require('crypto');

const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return { hash, salt };
}

function verifyPassword(password, expected, salt) {
    const actual = crypto.scryptSync(password, salt, 64);
    const expectedBuffer = Buffer.from(expected, 'hex');
    return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

function tokenHash(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function encodeBase32(buffer) {
    let bits = '';
    for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
    let output = '';
    for (let index = 0; index < bits.length; index += 5) {
        output += BASE32_ALPHABET[parseInt(bits.slice(index, index + 5).padEnd(5, '0'), 2)];
    }
    return output;
}

function decodeBase32(value) {
    const normalized = String(value || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = '';
    for (const character of normalized) {
        const index = BASE32_ALPHABET.indexOf(character);
        if (index < 0) throw new Error('Invalid authenticator secret');
        bits += index.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(parseInt(bits.slice(index, index + 8), 2));
    return Buffer.from(bytes);
}

function generateTotpSecret() {
    return encodeBase32(crypto.randomBytes(20));
}

function totpAt(secret, timestamp = Date.now()) {
    const counter = Math.floor(timestamp / 30000);
    const message = Buffer.alloc(8);
    message.writeBigUInt64BE(BigInt(counter));
    const digest = crypto.createHmac('sha1', decodeBase32(secret)).update(message).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 1000000;
    return String(number).padStart(6, '0');
}

function verifyTotpCode(secret, code, timestamp = Date.now()) {
    const candidate = String(code || '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(candidate)) return false;
    return [-30000, 0, 30000].some((offset) => {
        const expected = Buffer.from(totpAt(secret, timestamp + offset));
        const actual = Buffer.from(candidate);
        return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    });
}

function buildOtpAuthUri(secret, username, instanceName) {
    const issuer = 'Spencer Data Backup';
    const label = `${instanceName || issuer}:${username}`;
    return `otpauth://totp/${encodeURIComponent(label)}?secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

function parseCookies(header = '') {
    return header.split(';').reduce((cookies, item) => {
        const index = item.indexOf('=');
        if (index < 0) return cookies;
        cookies[item.slice(0, index).trim()] = decodeURIComponent(item.slice(index + 1).trim());
        return cookies;
    }, {});
}

function createAuth(store) {
    const cookieName = 'spencer_session';
    const legacyCookieName = 'dispenser_session';

    function createSession(userId, mfaVerified = true) {
        store.db.prepare('DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP').run();
        const token = crypto.randomBytes(32).toString('base64url');
        const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();
        store.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, mfa_verified) VALUES (?, ?, ?, ?)')
            .run(tokenHash(token), userId, expiresAt, Number(Boolean(mfaVerified)));
        return { token, expiresAt };
    }

    function getSession(req) {
        const cookies = parseCookies(req.headers.cookie || '');
        const token = cookies[cookieName] || cookies[legacyCookieName];
        if (!token) return null;
        const session = store.db.prepare(`
            SELECT sessions.token_hash, sessions.expires_at, sessions.mfa_verified, sessions.pending_mfa_secret,
                   users.id AS user_id, users.username, users.role, users.enabled, users.mfa_enabled, users.mfa_secret
            FROM sessions JOIN users ON users.id = sessions.user_id
            WHERE sessions.token_hash = ? AND sessions.expires_at > CURRENT_TIMESTAMP
        `).get(tokenHash(token)) || null;
        return session;
    }

    function requireAuth(req, res, next) {
        const session = getSession(req);
        if (!session || !session.enabled) return res.status(401).json({ error: 'Authentication required' });
        if (session.mfa_enabled && !session.mfa_verified) return res.status(403).json({ error: 'Authenticator code required', code: 'MFA_REQUIRED' });
        req.user = { id: session.user_id, username: session.username, role: session.role };
        req.session = session;
        next();
    }

    function requireAdmin(req, res, next) {
        if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Administrator access required' });
        next();
    }

    function setCookie(req, res, token) {
        res.cookie(cookieName, token, {
            httpOnly: true,
            sameSite: 'strict',
            secure: Boolean(req.secure),
            maxAge: SESSION_DURATION_MS,
            path: '/'
        });
    }

    function clearCookie(req, res) {
        const cookies = parseCookies(req.headers.cookie || '');
        const token = cookies[cookieName] || cookies[legacyCookieName];
        if (token) store.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
        res.clearCookie(cookieName, { path: '/' });
        res.clearCookie(legacyCookieName, { path: '/' });
    }

    return { cookieName, createSession, getSession, requireAuth, requireAdmin, setCookie, clearCookie };
}

module.exports = {
    createAuth, hashPassword, verifyPassword, generateTotpSecret, verifyTotpCode, buildOtpAuthUri, totpAt
};
