const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const cron = require('node-cron');
const { MongoClient } = require('mongodb');
const { Store } = require('./store');
const {
    createAuth, hashPassword, verifyPassword, generateTotpSecret, verifyTotpCode, buildOtpAuthUri
} = require('./auth');
const { EventBus } = require('./events');
const { JobWorker } = require('./worker');
const { Scheduler } = require('./scheduler');
const { testDestination } = require('./destinations');
const { redactSensitive } = require('./redact');

const safeError = (error) => redactSensitive(error?.message || error || 'Unexpected error');

function publicSource(row) {
    return {
        id: row.id, name: row.name, type: row.type, enabled: Boolean(row.enabled),
        createdAt: row.created_at, updatedAt: row.updated_at
    };
}

function publicDestination(row) {
    return {
        id: row.id, name: row.name, type: row.type, enabled: Boolean(row.enabled),
        config: JSON.parse(row.config), hasCredentials: Boolean(row.encrypted_secret),
        createdAt: row.created_at, updatedAt: row.updated_at
    };
}

function publicRestoreTarget(row) {
    return {
        id: row.id, name: row.name, type: row.type, database: row.database_name,
        enabled: Boolean(row.enabled), createdAt: row.created_at, updatedAt: row.updated_at
    };
}

function validatePassword(password) {
    return typeof password === 'string' && password.length >= 10 && /[A-Za-z]/.test(password) && /\d/.test(password);
}

function validateTimezone(timezone) {
    try {
        Intl.DateTimeFormat(undefined, { timeZone: timezone }).format();
        return true;
    } catch {
        return false;
    }
}

function slugId(prefix) {
    return `${prefix}_${crypto.randomUUID()}`;
}

function mongoDefaultsFromUri(uri) {
    const value = String(uri || '').trim();
    const queryIndex = value.indexOf('?');
    const parameters = new URLSearchParams(queryIndex >= 0 ? value.slice(queryIndex + 1) : '');
    const withoutQuery = queryIndex >= 0 ? value.slice(0, queryIndex) : value;
    const schemeEnd = withoutQuery.indexOf('://');
    const pathStart = schemeEnd >= 0 ? withoutQuery.indexOf('/', schemeEnd + 3) : -1;
    let database = '';
    if (pathStart >= 0) {
        try { database = decodeURIComponent(withoutQuery.slice(pathStart + 1)).trim(); }
        catch { database = withoutQuery.slice(pathStart + 1).trim(); }
    }
    return { database, authDatabase: parameters.get('authSource') || 'admin' };
}

function mongoConnectionOptions(config) {
    const connectTimeoutMS = Math.max(5000, Number(process.env.MONGO_CONNECT_TIMEOUT_MS) || 15000);
    const serverSelectionTimeoutMS = Math.max(connectTimeoutMS, Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS) || 20000);
    return {
        serverSelectionTimeoutMS,
        connectTimeoutMS,
        ...(config.authDatabase && !/[?&]authSource=/i.test(config.uri) ? { authSource: config.authDatabase } : {})
    };
}

async function inspectMongo(config) {
    const client = new MongoClient(config.uri, mongoConnectionOptions(config));
    try {
        await client.connect();
        const db = client.db(config.database);
        await db.command({ ping: 1 });
        const stats = await db.command({ dbStats: 1, scale: 1 });
        return {
            ok: true,
            database: config.database,
            metrics: {
                collections: stats.collections || 0,
                dataBytes: stats.dataSize || 0,
                storageBytes: stats.storageSize || 0,
                indexBytes: stats.indexSize || 0
            }
        };
    } finally {
        await client.close();
    }
}

async function discoverMongo(config) {
    const defaults = mongoDefaultsFromUri(config.uri);
    const authDatabase = /[?&]authSource=/i.test(config.uri) ? defaults.authDatabase : (config.authDatabase || defaults.authDatabase);
    const client = new MongoClient(config.uri, mongoConnectionOptions({ ...config, authDatabase }));
    try {
        await client.connect();
        const result = await client.db('admin').admin().listDatabases({ nameOnly: true, authorizedDatabases: true });
        const databases = [...new Set([
            defaults.database,
            ...result.databases.map((item) => item.name).filter((name) => !['admin', 'config', 'local'].includes(name))
        ].filter(Boolean))].sort();
        return {
            ok: true,
            databases,
            database: defaults.database || (databases.length === 1 ? databases[0] : ''),
            authDatabase
        };
    } catch (error) {
        if (/not authorized|unauthorized/i.test(error.message)) {
            return {
                ok: true,
                databases: defaults.database ? [defaults.database] : [],
                database: defaults.database,
                authDatabase
            };
        }
        throw error;
    } finally {
        await client.close();
    }
}

async function startServer(options = {}) {
    const port = Number(options.port ?? process.env.PORT ?? 7480);
    const host = options.host || process.env.HOST || '0.0.0.0';
    const dataDir = options.dataDir || process.env.DATA_DIR || path.join(__dirname, '..', 'data');
    const backupDir = options.backupDir || process.env.BACKUP_DIR || path.join(dataDir, 'backups');
    const store = await Store.create(dataDir);
    const auth = createAuth(store);
    const events = new EventBus();
    const worker = new JobWorker(store, events, { workDir: path.join(dataDir, 'work') });
    const scheduler = new Scheduler(store, events);
    const loginAttempts = new Map();
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json({ limit: '2mb' }));
    app.use(express.urlencoded({ extended: false }));
    app.use((_req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        next();
    });

    app.get('/health/live', (_req, res) => res.json({ status: 'ok', service: 'spencer-data-backup' }));
    app.get('/health/ready', async (_req, res) => {
        try {
            await fsp.mkdir(backupDir, { recursive: true });
            await fsp.access(dataDir, fs.constants.R_OK | fs.constants.W_OK);
            res.json({ status: 'ready', setupRequired: !store.getSetting('setup_complete', false) });
        } catch (error) {
            res.status(503).json({ status: 'not_ready', error: safeError(error) });
        }
    });

    app.get('/api/setup/status', (_req, res) => {
        res.json({
            setupRequired: !store.getSetting('setup_complete', false),
            productName: 'Spencer Data Backup',
            version: require('../package.json').version
        });
    });

    app.post('/api/setup', async (req, res) => {
        if (store.getSetting('setup_complete', false)) return res.status(409).json({ error: 'Setup has already been completed' });
        const { instanceName, username, password, localPath } = req.body || {};
        if (!instanceName || !username || !validatePassword(password)) {
            return res.status(400).json({ error: 'Instance name, username, and a 10+ character password containing letters and numbers are required' });
        }
        const localConfig = { path: path.resolve(localPath || backupDir) };
        try {
            await testDestination({ id: 'setup', type: 'local', config: JSON.stringify(localConfig) }, {});
            const result = hashPassword(password);
            const userId = store.db.transaction(() => {
                const user = store.db.prepare('INSERT INTO users (username, password_hash, password_salt) VALUES (?, ?, ?)')
                    .run(username.trim(), result.hash, result.salt);
                const destinationId = slugId('dst');
                store.db.prepare(`INSERT INTO destinations (id, name, type, config) VALUES (?, ?, 'local', ?)`)
                    .run(destinationId, 'Local storage', JSON.stringify(localConfig));
                store.setSetting('instance_name', instanceName.trim());
                store.setSetting('setup_complete', true);
                store.audit(username.trim(), 'setup.completed', 'instance', null, { destinationId });
                return user.lastInsertRowid;
            })();
            const session = auth.createSession(userId);
            auth.setCookie(req, res, session.token);
            res.status(201).json({ success: true });
        } catch (error) {
            res.status(400).json({ error: safeError(error) });
        }
    });

    app.post('/auth/login', (req, res) => {
        const key = req.ip || req.socket.remoteAddress || 'unknown';
        const now = Date.now();
        const attempt = loginAttempts.get(key) || { count: 0, resetAt: now + 15 * 60 * 1000 };
        if (attempt.resetAt <= now) { attempt.count = 0; attempt.resetAt = now + 15 * 60 * 1000; }
        if (attempt.count >= 5) return res.status(429).json({ error: 'Too many sign-in attempts. Try again later.' });
        const { username, password } = req.body || {};
        const user = store.db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
        if (!user || !user.enabled || !verifyPassword(String(password || ''), user.password_hash, user.password_salt)) {
            attempt.count += 1;
            loginAttempts.set(key, attempt);
            return res.status(401).json({ error: 'Invalid username or password' });
        }
        loginAttempts.delete(key);
        const requiresMfa = Boolean(user.mfa_enabled);
        const session = auth.createSession(user.id, !requiresMfa);
        store.db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
        auth.setCookie(req, res, session.token);
        res.json({ success: true, requiresMfa });
    });
    app.post('/auth/mfa/verify', (req, res) => {
        const session = auth.getSession(req);
        if (!session || !session.enabled) return res.status(401).json({ error: 'Sign in again to continue' });
        if (!session.mfa_enabled) return res.status(400).json({ error: 'Authenticator verification is not enabled' });
        let secret;
        try { secret = store.decrypt(session.mfa_secret).secret; }
        catch { return res.status(500).json({ error: 'Authenticator configuration could not be read' }); }
        if (!verifyTotpCode(secret, req.body?.code)) return res.status(401).json({ error: 'Invalid or expired authenticator code' });
        store.db.prepare('UPDATE sessions SET mfa_verified = 1 WHERE token_hash = ?').run(session.token_hash);
        store.audit(session.username, 'auth.mfa_verified', 'user', String(session.user_id));
        res.json({ success: true });
    });
    app.post('/auth/logout', (req, res) => {
        auth.clearCookie(req, res);
        res.json({ success: true });
    });
    app.get('/api/session', (req, res) => {
        const session = auth.getSession(req);
        if (!session || !session.enabled) return res.json({ authenticated: false });
        if (session.mfa_enabled && !session.mfa_verified) return res.json({ authenticated: false, mfaRequired: true });
        res.json({ authenticated: true, user: { username: session.username, role: session.role } });
    });

    app.use('/api', auth.requireAuth);
    app.use('/api', (req, res, next) => {
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)
            && req.get('X-Spencer-Request') !== '1'
            && req.get('X-Dispenser-Request') !== '1') {
            return res.status(403).json({ error: 'Missing request verification header' });
        }
        next();
    });

    app.get('/api/security', (req, res) => {
        res.json({
            user: { username: req.user.username, role: req.user.role },
            mfaEnabled: Boolean(req.session.mfa_enabled),
            sessionExpiresAt: req.session.expires_at
        });
    });
    app.post('/api/security/mfa/setup', (req, res) => {
        if (req.session.mfa_enabled) return res.status(409).json({ error: 'Authenticator verification is already enabled' });
        const secret = generateTotpSecret();
        store.db.prepare('UPDATE sessions SET pending_mfa_secret = ? WHERE token_hash = ?')
            .run(store.encrypt({ secret }), req.session.token_hash);
        res.json({
            secret,
            otpAuthUri: buildOtpAuthUri(secret, req.user.username, store.getSetting('instance_name', 'Spencer'))
        });
    });
    app.post('/api/security/mfa/enable', (req, res) => {
        const pending = store.db.prepare('SELECT pending_mfa_secret FROM sessions WHERE token_hash = ?').get(req.session.token_hash);
        if (!pending?.pending_mfa_secret) return res.status(400).json({ error: 'Start authenticator setup first' });
        let secret;
        try { secret = store.decrypt(pending.pending_mfa_secret).secret; }
        catch { return res.status(400).json({ error: 'Authenticator setup expired; start again' }); }
        if (!verifyTotpCode(secret, req.body?.code)) return res.status(400).json({ error: 'Invalid or expired authenticator code' });
        store.db.transaction(() => {
            store.db.prepare('UPDATE users SET mfa_enabled = 1, mfa_secret = ? WHERE id = ?')
                .run(store.encrypt({ secret }), req.user.id);
            store.db.prepare('UPDATE sessions SET pending_mfa_secret = NULL, mfa_verified = 1 WHERE user_id = ?').run(req.user.id);
            store.audit(req.user.username, 'security.mfa_enabled', 'user', String(req.user.id));
        })();
        res.json({ success: true });
    });
    app.post('/api/security/mfa/disable', (req, res) => {
        const user = store.db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
        if (!verifyPassword(String(req.body?.password || ''), user.password_hash, user.password_salt)) {
            return res.status(400).json({ error: 'Current password is incorrect' });
        }
        store.db.transaction(() => {
            store.db.prepare('UPDATE users SET mfa_enabled = 0, mfa_secret = NULL WHERE id = ?').run(req.user.id);
            store.db.prepare('UPDATE sessions SET mfa_verified = 1, pending_mfa_secret = NULL WHERE user_id = ?').run(req.user.id);
            store.audit(req.user.username, 'security.mfa_disabled', 'user', String(req.user.id));
        })();
        res.json({ success: true });
    });
    app.get('/api/audit-events', auth.requireAdmin, (_req, res) => {
        const events = store.db.prepare('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 100').all()
            .map((event) => ({ ...event, detail: event.detail ? JSON.parse(event.detail) : null }));
        res.json({ events });
    });

    app.get('/api/overview', async (_req, res) => {
        const sourceCount = store.db.prepare('SELECT COUNT(*) AS count FROM sources WHERE enabled = 1 AND deleted_at IS NULL').get().count;
        const destinationCount = store.db.prepare('SELECT COUNT(*) AS count FROM destinations WHERE enabled = 1 AND deleted_at IS NULL').get().count;
        const failedJobs = store.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'failed' AND created_at >= datetime('now', '-24 hours')").get().count;
        const lastSuccess = store.db.prepare("SELECT * FROM jobs WHERE status = 'succeeded' ORDER BY finished_at DESC LIMIT 1").get() || null;
        const storage = await fsp.statfs(backupDir).catch(() => null);
        res.json({
            instanceName: store.getSetting('instance_name', 'Spencer'), sourceCount, destinationCount, failedJobs, lastSuccess,
            localStorage: storage ? {
                totalBytes: storage.blocks * storage.bsize,
                freeBytes: storage.bavail * storage.bsize,
                usedBytes: (storage.blocks - storage.bfree) * storage.bsize
            } : null
        });
    });

    app.get('/api/sources', (_req, res) => {
        res.json({ sources: store.db.prepare('SELECT * FROM sources WHERE deleted_at IS NULL ORDER BY created_at DESC').all().map(publicSource) });
    });
    app.post('/api/sources/test', async (req, res) => {
        const { uri, database, authDatabase = 'admin' } = req.body || {};
        if (!uri || !database) return res.status(400).json({ error: 'MongoDB URI and database are required' });
        try { res.json(await inspectMongo({ uri, database, authDatabase })); }
        catch (error) { res.status(400).json({ error: safeError(error) }); }
    });
    app.post('/api/sources/discover', async (req, res) => {
        const { uri, authDatabase } = req.body || {};
        if (!uri) return res.status(400).json({ error: 'MongoDB URI is required' });
        try { res.json(await discoverMongo({ uri, authDatabase })); }
        catch (error) { res.status(400).json({ error: safeError(error) }); }
    });
    app.post('/api/sources', async (req, res) => {
        const { name, uri } = req.body || {};
        const defaults = mongoDefaultsFromUri(uri);
        const database = String(req.body?.database || defaults.database || '').trim();
        const authDatabase = String(/[?&]authSource=/i.test(uri) ? defaults.authDatabase : (req.body?.authDatabase || defaults.authDatabase || 'admin')).trim();
        if (!name || !uri || !database) return res.status(400).json({ error: 'Name, MongoDB URI, and database are required' });
        try {
            const test = await inspectMongo({ uri, database, authDatabase });
            const id = slugId('src');
            store.db.prepare(`INSERT INTO sources (id, name, type, encrypted_config) VALUES (?, ?, 'mongodb', ?)`)
                .run(id, name.trim(), store.encrypt({ uri, database, authDatabase }));
            store.audit(req.user.username, 'source.created', 'source', id, { name, database });
            res.status(201).json({ source: publicSource(store.db.prepare('SELECT * FROM sources WHERE id = ?').get(id)), test });
        } catch (error) { res.status(400).json({ error: safeError(error) }); }
    });
    app.post('/api/sources/:id/test', async (req, res) => {
        const row = store.db.prepare('SELECT * FROM sources WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
        if (!row) return res.status(404).json({ error: 'Source not found' });
        try { res.json(await inspectMongo(store.decrypt(row.encrypted_config))); }
        catch (error) { res.status(400).json({ error: safeError(error) }); }
    });
    app.get('/api/sources/:id/metrics', async (req, res) => {
        const row = store.db.prepare('SELECT * FROM sources WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
        if (!row) return res.status(404).json({ error: 'Source not found' });
        try { res.json(await inspectMongo(store.decrypt(row.encrypted_config))); }
        catch (error) { res.status(400).json({ error: safeError(error) }); }
    });
    app.patch('/api/sources/:id', async (req, res) => {
        const row = store.db.prepare('SELECT * FROM sources WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
        if (!row) return res.status(404).json({ error: 'Source not found' });
        const current = store.decrypt(row.encrypted_config);
        const next = {
            uri: req.body.uri || current.uri,
            database: req.body.database || current.database,
            authDatabase: req.body.authDatabase || current.authDatabase || 'admin'
        };
        try {
            if (req.body.uri || req.body.database) await inspectMongo(next);
            store.db.prepare(`UPDATE sources SET name = ?, encrypted_config = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                .run(String(req.body.name || row.name).trim(), store.encrypt(next), req.body.enabled === undefined ? row.enabled : Number(Boolean(req.body.enabled)), row.id);
            store.audit(req.user.username, 'source.updated', 'source', row.id);
            res.json({ source: publicSource(store.db.prepare('SELECT * FROM sources WHERE id = ?').get(row.id)) });
        } catch (error) { res.status(400).json({ error: safeError(error) }); }
    });
    app.delete('/api/sources/:id', (req, res) => {
        const row = store.db.prepare('SELECT * FROM sources WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
        if (!row) return res.status(404).json({ error: 'Source not found' });
        const current = store.decrypt(row.encrypted_config);
        store.db.prepare(`UPDATE sources SET enabled = 0, deleted_at = CURRENT_TIMESTAMP,
            encrypted_config = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(store.encrypt({ database: current.database, authDatabase: current.authDatabase || 'admin' }), req.params.id);
        store.db.prepare('UPDATE policies SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE source_id = ?').run(req.params.id);
        store.audit(req.user.username, 'source.deleted', 'source', req.params.id);
        scheduler.reload();
        res.json({ success: true });
    });

    app.get('/api/destinations', (_req, res) => {
        res.json({ destinations: store.db.prepare('SELECT * FROM destinations WHERE deleted_at IS NULL ORDER BY created_at DESC').all().map(publicDestination) });
    });
    app.post('/api/destinations', async (req, res) => {
        const { name, type, config = {}, secret = {} } = req.body || {};
        if (!name || !['local', 'firebase', 's3'].includes(type)) return res.status(400).json({ error: 'Valid name and destination type are required' });
        const id = slugId('dst');
        const row = { id, type, config: JSON.stringify(config) };
        try {
            await testDestination(row, secret);
            store.db.prepare(`INSERT INTO destinations (id, name, type, config, encrypted_secret) VALUES (?, ?, ?, ?, ?)`)
                .run(id, name.trim(), type, row.config, Object.keys(secret).length ? store.encrypt(secret) : null);
            store.audit(req.user.username, 'destination.created', 'destination', id, { name, type });
            res.status(201).json({ destination: publicDestination(store.db.prepare('SELECT * FROM destinations WHERE id = ?').get(id)) });
        } catch (error) { res.status(400).json({ error: safeError(error) }); }
    });
    app.post('/api/destinations/:id/test', async (req, res) => {
        const row = store.db.prepare('SELECT * FROM destinations WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
        if (!row) return res.status(404).json({ error: 'Destination not found' });
        try { res.json(await testDestination(row, row.encrypted_secret ? store.decrypt(row.encrypted_secret) : {})); }
        catch (error) { res.status(400).json({ error: safeError(error) }); }
    });
    app.patch('/api/destinations/:id', async (req, res) => {
        const row = store.db.prepare('SELECT * FROM destinations WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
        if (!row) return res.status(404).json({ error: 'Destination not found' });
        const config = req.body.config || JSON.parse(row.config);
        const secret = req.body.secret || (row.encrypted_secret ? store.decrypt(row.encrypted_secret) : {});
        const candidate = { ...row, config: JSON.stringify(config) };
        try {
            if (req.body.config || req.body.secret) await testDestination(candidate, secret);
            store.db.prepare(`UPDATE destinations SET name = ?, config = ?, encrypted_secret = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                .run(String(req.body.name || row.name).trim(), candidate.config, Object.keys(secret).length ? store.encrypt(secret) : null, req.body.enabled === undefined ? row.enabled : Number(Boolean(req.body.enabled)), row.id);
            store.audit(req.user.username, 'destination.updated', 'destination', row.id);
            res.json({ destination: publicDestination(store.db.prepare('SELECT * FROM destinations WHERE id = ?').get(row.id)) });
        } catch (error) { res.status(400).json({ error: safeError(error) }); }
    });
    app.delete('/api/destinations/:id', (req, res) => {
        const destination = store.db.prepare('SELECT id FROM destinations WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
        if (!destination) return res.status(404).json({ error: 'Destination not found' });
        const artifactCount = store.db.prepare('SELECT COUNT(*) AS count FROM artifacts WHERE destination_id = ?').get(req.params.id).count;
        if (artifactCount) {
            store.db.prepare(`UPDATE destinations SET enabled = 0, deleted_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(req.params.id);
        } else {
            store.db.prepare(`UPDATE destinations SET enabled = 0, deleted_at = CURRENT_TIMESTAMP,
                config = '{}', encrypted_secret = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(req.params.id);
        }
        const policies = store.db.prepare('SELECT * FROM policies WHERE enabled = 1').all();
        for (const policy of policies) {
            if (JSON.parse(policy.destination_ids).includes(req.params.id)) {
                store.db.prepare('UPDATE policies SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(policy.id);
            }
        }
        store.audit(req.user.username, 'destination.deleted', 'destination', req.params.id);
        scheduler.reload();
        res.json({ success: true, retainedForRecovery: Boolean(artifactCount) });
    });

    app.get('/api/restore-targets', (_req, res) => {
        res.json({ targets: store.db.prepare('SELECT * FROM restore_targets ORDER BY created_at DESC').all().map(publicRestoreTarget) });
    });
    app.post('/api/restore-targets', async (req, res) => {
        const { name, uri, database, authDatabase = 'admin' } = req.body || {};
        if (!name || !uri || !database) return res.status(400).json({ error: 'Name, MongoDB URI, and target database are required' });
        try {
            const test = await inspectMongo({ uri, database, authDatabase });
            const id = slugId('target');
            store.db.prepare(`INSERT INTO restore_targets (id, name, database_name, encrypted_config) VALUES (?, ?, ?, ?)`)
                .run(id, name.trim(), database.trim(), store.encrypt({ uri, database: database.trim(), authDatabase }));
            store.audit(req.user.username, 'restore_target.created', 'restore_target', id, { name, database });
            res.status(201).json({ target: publicRestoreTarget(store.db.prepare('SELECT * FROM restore_targets WHERE id = ?').get(id)), test });
        } catch (error) { res.status(400).json({ error: safeError(error) }); }
    });
    app.post('/api/restore-targets/:id/test', async (req, res) => {
        const row = store.db.prepare('SELECT * FROM restore_targets WHERE id = ?').get(req.params.id);
        if (!row) return res.status(404).json({ error: 'Restore target not found' });
        try { res.json(await inspectMongo(store.decrypt(row.encrypted_config))); }
        catch (error) { res.status(400).json({ error: safeError(error) }); }
    });
    app.patch('/api/restore-targets/:id', async (req, res) => {
        const row = store.db.prepare('SELECT * FROM restore_targets WHERE id = ?').get(req.params.id);
        if (!row) return res.status(404).json({ error: 'Restore target not found' });
        const current = store.decrypt(row.encrypted_config);
        const next = {
            uri: req.body.uri || current.uri,
            database: req.body.database || current.database,
            authDatabase: req.body.authDatabase || current.authDatabase || 'admin'
        };
        try {
            if (req.body.uri || req.body.database) await inspectMongo(next);
            store.db.prepare(`UPDATE restore_targets SET name = ?, database_name = ?, encrypted_config = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
                .run(String(req.body.name || row.name).trim(), next.database, store.encrypt(next), req.body.enabled === undefined ? row.enabled : Number(Boolean(req.body.enabled)), row.id);
            store.audit(req.user.username, 'restore_target.updated', 'restore_target', row.id);
            res.json({ target: publicRestoreTarget(store.db.prepare('SELECT * FROM restore_targets WHERE id = ?').get(row.id)) });
        } catch (error) { res.status(400).json({ error: safeError(error) }); }
    });
    app.delete('/api/restore-targets/:id', (req, res) => {
        const result = store.db.prepare('UPDATE restore_targets SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
        if (!result.changes) return res.status(404).json({ error: 'Restore target not found' });
        store.audit(req.user.username, 'restore_target.disabled', 'restore_target', req.params.id);
        res.json({ success: true });
    });

    app.get('/api/policies', (_req, res) => {
        const policies = store.db.prepare('SELECT * FROM policies ORDER BY created_at DESC').all()
            .map((row) => ({ ...row, destination_ids: JSON.parse(row.destination_ids), enabled: Boolean(row.enabled) }));
        res.json({ policies });
    });
    app.post('/api/policies', (req, res) => {
        const { name, sourceId, destinationIds, schedule, timezone = 'UTC', retentionDays = 30 } = req.body || {};
        if (!name || !sourceId || !Array.isArray(destinationIds) || !destinationIds.length || !cron.validate(schedule) || !validateTimezone(timezone)) {
            return res.status(400).json({ error: 'Name, source, destination, valid cron schedule, and timezone are required' });
        }
        const source = store.db.prepare('SELECT id FROM sources WHERE id = ? AND deleted_at IS NULL').get(sourceId);
        const destinations = destinationIds.map((id) => store.db.prepare('SELECT id FROM destinations WHERE id = ? AND deleted_at IS NULL').get(id)).filter(Boolean);
        if (!source || destinations.length !== destinationIds.length) return res.status(400).json({ error: 'Source or destination does not exist' });
        const id = slugId('pol');
        store.db.prepare(`
            INSERT INTO policies (id, name, source_id, destination_ids, schedule, timezone, retention_days)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(id, name.trim(), sourceId, JSON.stringify(destinationIds), schedule, timezone, Math.max(1, Number(retentionDays) || 30));
        store.audit(req.user.username, 'policy.created', 'policy', id, { name, schedule, timezone });
        scheduler.reload();
        res.status(201).json({ id });
    });
    app.patch('/api/policies/:id', (req, res) => {
        const row = store.db.prepare('SELECT * FROM policies WHERE id = ?').get(req.params.id);
        if (!row) return res.status(404).json({ error: 'Policy not found' });
        const destinationIds = req.body.destinationIds || JSON.parse(row.destination_ids);
        const schedule = req.body.schedule || row.schedule;
        const timezone = req.body.timezone || row.timezone;
        if (!cron.validate(schedule) || !validateTimezone(timezone) || !Array.isArray(destinationIds) || !destinationIds.length) {
            return res.status(400).json({ error: 'Valid destinations, cron schedule, and timezone are required' });
        }
        store.db.prepare(`UPDATE policies SET name = ?, destination_ids = ?, schedule = ?, timezone = ?, retention_days = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(String(req.body.name || row.name).trim(), JSON.stringify(destinationIds), schedule, timezone, Math.max(1, Number(req.body.retentionDays || row.retention_days)), req.body.enabled === undefined ? row.enabled : Number(Boolean(req.body.enabled)), row.id);
        store.audit(req.user.username, 'policy.updated', 'policy', row.id);
        scheduler.reload();
        res.json({ success: true });
    });
    app.delete('/api/policies/:id', (req, res) => {
        const result = store.db.prepare('DELETE FROM policies WHERE id = ?').run(req.params.id);
        if (!result.changes) return res.status(404).json({ error: 'Policy not found' });
        store.audit(req.user.username, 'policy.deleted', 'policy', req.params.id);
        scheduler.reload();
        res.json({ success: true });
    });

    app.get('/api/jobs', (req, res) => {
        const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
        res.json({ jobs: store.db.prepare(`
            SELECT jobs.*, sources.name AS source_name FROM jobs
            LEFT JOIN sources ON sources.id = jobs.source_id
            ORDER BY jobs.created_at DESC LIMIT ?
        `).all(limit).map((job) => ({ ...job, destination_ids: JSON.parse(job.destination_ids) })) });
    });
    app.get('/api/jobs/:id', (req, res) => {
        const job = store.db.prepare(`
            SELECT jobs.*, sources.name AS source_name
            FROM jobs LEFT JOIN sources ON sources.id = jobs.source_id
            WHERE jobs.id = ?
        `).get(req.params.id);
        if (!job) return res.status(404).json({ error: 'Job not found' });
        const destinationIds = JSON.parse(job.destination_ids);
        const destinations = destinationIds.map((id) => store.db.prepare('SELECT id, name, type FROM destinations WHERE id = ?').get(id))
            .filter(Boolean);
        const logs = store.db.prepare('SELECT id, level, message, created_at FROM job_logs WHERE job_id = ? ORDER BY id ASC LIMIT 1000').all(job.id);
        res.json({ job: { ...job, destination_ids: destinationIds, destinations }, logs });
    });
    app.post('/api/jobs', (req, res) => {
        const { sourceId, destinationIds } = req.body || {};
        if (!sourceId || !Array.isArray(destinationIds) || !destinationIds.length) return res.status(400).json({ error: 'Source and at least one destination are required' });
        const source = store.db.prepare('SELECT id FROM sources WHERE id = ? AND enabled = 1 AND deleted_at IS NULL').get(sourceId);
        const destinations = destinationIds.map((id) => store.db.prepare('SELECT id FROM destinations WHERE id = ? AND enabled = 1 AND deleted_at IS NULL').get(id)).filter(Boolean);
        if (!source || destinations.length !== destinationIds.length) return res.status(400).json({ error: 'Source or destination is unavailable' });
        const id = slugId('job');
        store.db.prepare(`
            INSERT INTO jobs (id, type, source_id, destination_ids, trigger, status, phase, message)
            VALUES (?, 'backup', ?, ?, 'manual', 'queued', 'queued', 'Waiting for worker')
        `).run(id, sourceId, JSON.stringify(destinationIds));
        store.db.prepare("INSERT INTO job_logs (job_id, level, message) VALUES (?, 'info', 'Backup queued')").run(id);
        store.audit(req.user.username, 'job.created', 'job', id, { sourceId, destinationIds });
        events.publish('job.created', { id });
        res.status(202).json({ id, status: 'queued' });
    });
    app.post('/api/restores', (req, res) => {
        const { artifactId, targetId, dropExisting = false, confirmation } = req.body || {};
        const artifact = store.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(artifactId);
        const target = store.db.prepare('SELECT * FROM restore_targets WHERE id = ? AND enabled = 1').get(targetId);
        if (!artifact || !target) return res.status(404).json({ error: 'Recovery point or restore target not found' });
        if (String(confirmation || '') !== target.database_name) {
            return res.status(400).json({ error: `Type ${target.database_name} exactly to confirm this restore` });
        }
        const id = slugId('job');
        store.db.prepare(`
            INSERT INTO jobs (id, type, source_id, destination_ids, artifact_id, restore_target_id, options, trigger, status, phase, message)
            VALUES (?, 'restore', ?, ?, ?, ?, ?, 'manual', 'queued', 'queued', 'Waiting for worker')
        `).run(id, artifact.source_id, JSON.stringify([artifact.destination_id]), artifact.id, target.id, JSON.stringify({ dropExisting: Boolean(dropExisting) }));
        store.db.prepare("INSERT INTO job_logs (job_id, level, message) VALUES (?, 'info', 'Restore queued')").run(id);
        store.audit(req.user.username, 'restore.queued', 'job', id, { artifactId, targetId, dropExisting: Boolean(dropExisting) });
        events.publish('job.created', { id, type: 'restore' });
        res.status(202).json({ id, status: 'queued' });
    });
    app.get('/api/artifacts', (_req, res) => {
        res.json({ artifacts: store.db.prepare(`
            SELECT artifacts.*, sources.name AS source_name, destinations.name AS destination_name
            FROM artifacts
            LEFT JOIN sources ON sources.id = artifacts.source_id
            LEFT JOIN destinations ON destinations.id = artifacts.destination_id
            ORDER BY artifacts.created_at DESC LIMIT 200
        `).all() });
    });
    app.get('/api/events', (req, res) => events.connect(req, res));

    app.use(express.static(path.join(__dirname, '..', 'public'), { index: false, maxAge: '1h' }));
    app.use((_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

    await fsp.mkdir(backupDir, { recursive: true });
    worker.start();
    scheduler.reload();
    return new Promise((resolve, reject) => {
        const server = http.createServer(app);
        server.once('error', (error) => {
            worker.stop();
            store.close();
            reject(error);
        });
        server.listen(port, host, () => {
            const interfaces = require('os').networkInterfaces();
            const addresses = Object.values(interfaces).flat().filter((item) => item && item.family === 'IPv4' && !item.internal).map((item) => item.address);
            const boundPort = server.address().port;
            console.log(`Spencer Data Backup is running at http://localhost:${boundPort}`);
            for (const address of addresses) console.log(`Network: http://${address}:${boundPort}`);
            resolve({ app, server, store, worker, scheduler });
        });
    });
}

module.exports = { startServer, mongoDefaultsFromUri };
