const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const initSqlJs = require('sql.js');
const { redactSensitive } = require('./redact');

class SqliteAdapter {
    constructor(database, filePath) {
        this.database = database;
        this.filePath = filePath;
        this.transactionDepth = 0;
    }

    persist() {
        if (this.transactionDepth) return;
        const temporaryPath = `${this.filePath}.tmp`;
        fs.writeFileSync(temporaryPath, Buffer.from(this.database.export()), { mode: 0o600 });
        fs.renameSync(temporaryPath, this.filePath);
    }

    exec(sql) {
        this.database.exec(sql);
        this.persist();
    }

    prepare(sql) {
        const adapter = this;
        const execute = (params, mode) => {
            const statement = adapter.database.prepare(sql);
            try {
                statement.bind(params);
                if (mode === 'run') {
                    while (statement.step()) { /* consume */ }
                    const changes = adapter.database.getRowsModified();
                    const idResult = adapter.database.exec('SELECT last_insert_rowid() AS id');
                    const lastInsertRowid = idResult[0]?.values?.[0]?.[0] || 0;
                    adapter.persist();
                    return { changes, lastInsertRowid };
                }
                if (mode === 'get') return statement.step() ? statement.getAsObject() : undefined;
                const rows = [];
                while (statement.step()) rows.push(statement.getAsObject());
                return rows;
            } finally {
                statement.free();
            }
        };
        return {
            run: (...params) => execute(params, 'run'),
            get: (...params) => execute(params, 'get'),
            all: (...params) => execute(params, 'all')
        };
    }

    transaction(callback) {
        return (...args) => {
            this.database.run('BEGIN');
            this.transactionDepth += 1;
            try {
                const result = callback(...args);
                this.database.run('COMMIT');
                this.transactionDepth -= 1;
                this.persist();
                return result;
            } catch (error) {
                this.database.run('ROLLBACK');
                this.transactionDepth -= 1;
                throw error;
            }
        };
    }

    close() {
        this.persist();
        this.database.close();
    }
}

class Store {
    constructor(dataDir, database) {
        this.dataDir = path.resolve(dataDir);
        this.masterKey = this.loadMasterKey();
        this.db = new SqliteAdapter(database, path.join(this.dataDir, 'spencer.db'));
        this.migrate();
    }

    static async create(dataDir) {
        const resolved = path.resolve(dataDir);
        fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
        const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
        const databasePath = path.join(resolved, 'spencer.db');
        const legacyDatabasePath = path.join(resolved, 'dispenser.db');
        if (!fs.existsSync(databasePath) && fs.existsSync(legacyDatabasePath)) fs.renameSync(legacyDatabasePath, databasePath);
        const database = fs.existsSync(databasePath)
            ? new SQL.Database(fs.readFileSync(databasePath))
            : new SQL.Database();
        database.run('PRAGMA foreign_keys = ON');
        return new Store(resolved, database);
    }

    loadMasterKey() {
        const keyPath = path.join(this.dataDir, 'master.key');
        if (fs.existsSync(keyPath)) {
            const key = fs.readFileSync(keyPath);
            if (key.length !== 32) throw new Error('Invalid master encryption key');
            return key;
        }
        const key = crypto.randomBytes(32);
        fs.writeFileSync(keyPath, key, { mode: 0o600, flag: 'wx' });
        return key;
    }

    migrate() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                password_salt TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'admin',
                enabled INTEGER NOT NULL DEFAULT 1,
                mfa_enabled INTEGER NOT NULL DEFAULT 0,
                mfa_secret TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                last_login_at TEXT
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                expires_at TEXT NOT NULL,
                mfa_verified INTEGER NOT NULL DEFAULT 1,
                pending_mfa_secret TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS sources (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                type TEXT NOT NULL,
                encrypted_config TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                deleted_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS destinations (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                type TEXT NOT NULL,
                config TEXT NOT NULL,
                encrypted_secret TEXT,
                enabled INTEGER NOT NULL DEFAULT 1,
                deleted_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS restore_targets (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                type TEXT NOT NULL DEFAULT 'mongodb',
                database_name TEXT NOT NULL,
                encrypted_config TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS policies (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
                destination_ids TEXT NOT NULL,
                schedule TEXT NOT NULL,
                timezone TEXT NOT NULL DEFAULT 'UTC',
                retention_days INTEGER NOT NULL DEFAULT 30,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                source_id TEXT NOT NULL,
                destination_ids TEXT NOT NULL,
                policy_id TEXT,
                artifact_id TEXT,
                restore_target_id TEXT,
                options TEXT,
                trigger TEXT NOT NULL,
                status TEXT NOT NULL,
                phase TEXT,
                progress INTEGER NOT NULL DEFAULT 0,
                message TEXT,
                error TEXT,
                artifact_name TEXT,
                artifact_size INTEGER,
                checksum TEXT,
                started_at TEXT,
                finished_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS artifacts (
                id TEXT PRIMARY KEY,
                job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
                source_id TEXT NOT NULL,
                destination_id TEXT NOT NULL,
                name TEXT NOT NULL,
                location TEXT NOT NULL,
                size INTEGER NOT NULL,
                checksum TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS audit_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                actor TEXT NOT NULL,
                action TEXT NOT NULL,
                target_type TEXT,
                target_id TEXT,
                detail TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS job_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
                level TEXT NOT NULL DEFAULT 'info',
                message TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_artifacts_source ON artifacts(source_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_job_logs_job ON job_logs(job_id, id);
        `);
        this.ensureColumn('jobs', 'artifact_id', 'TEXT');
        this.ensureColumn('jobs', 'restore_target_id', 'TEXT');
        this.ensureColumn('jobs', 'options', 'TEXT');
        this.ensureColumn('users', 'role', "TEXT NOT NULL DEFAULT 'admin'");
        this.ensureColumn('users', 'enabled', 'INTEGER NOT NULL DEFAULT 1');
        this.ensureColumn('users', 'mfa_enabled', 'INTEGER NOT NULL DEFAULT 0');
        this.ensureColumn('users', 'mfa_secret', 'TEXT');
        this.ensureColumn('sessions', 'mfa_verified', 'INTEGER NOT NULL DEFAULT 1');
        this.ensureColumn('sessions', 'pending_mfa_secret', 'TEXT');
        this.ensureColumn('sources', 'deleted_at', 'TEXT');
        this.ensureColumn('destinations', 'deleted_at', 'TEXT');
        for (const job of this.db.prepare('SELECT id, error FROM jobs WHERE error IS NOT NULL').all()) {
            const redacted = redactSensitive(job.error);
            if (redacted !== job.error) this.db.prepare('UPDATE jobs SET error = ? WHERE id = ?').run(redacted, job.id);
        }
    }

    ensureColumn(table, column, definition) {
        const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
        if (!columns.some((item) => item.name === column)) {
            this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
        }
    }

    encrypt(value) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, iv);
        const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
        return JSON.stringify({
            version: 1,
            iv: iv.toString('base64'),
            tag: cipher.getAuthTag().toString('base64'),
            data: encrypted.toString('base64')
        });
    }

    decrypt(payload) {
        const parsed = JSON.parse(payload);
        const decipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey, Buffer.from(parsed.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
        return JSON.parse(Buffer.concat([
            decipher.update(Buffer.from(parsed.data, 'base64')),
            decipher.final()
        ]).toString('utf8'));
    }

    getSetting(key, fallback = null) {
        const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
        return row ? JSON.parse(row.value) : fallback;
    }

    setSetting(key, value) {
        this.db.prepare(`
            INSERT INTO settings (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        `).run(key, JSON.stringify(value));
    }

    audit(actor, action, targetType = null, targetId = null, detail = null) {
        this.db.prepare(`
            INSERT INTO audit_events (actor, action, target_type, target_id, detail)
            VALUES (?, ?, ?, ?, ?)
        `).run(actor, action, targetType, targetId, detail ? JSON.stringify(detail) : null);
    }

    close() {
        this.db.close();
    }
}

module.exports = { Store };
