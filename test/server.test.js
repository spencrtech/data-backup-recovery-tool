const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { startServer } = require('../src/server');
const { totpAt } = require('../src/auth');

test('first-run setup creates a local workspace and authenticated session', async (context) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spencer-server-'));
    const backups = path.join(directory, 'backups');
    const instance = await startServer({ port: 0, host: '127.0.0.1', dataDir: directory, backupDir: backups });
    const base = `http://127.0.0.1:${instance.server.address().port}`;
    context.after(async () => {
        instance.worker.stop();
        await new Promise((resolve) => instance.server.close(resolve));
        instance.store.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    let response = await fetch(`${base}/health/ready`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).setupRequired, true);

    response = await fetch(`${base}/api/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instanceName: 'Test backups', username: 'admin', password: 'strongpass123', localPath: backups })
    });
    assert.equal(response.status, 201);
    const cookie = response.headers.get('set-cookie').split(';')[0];

    response = await fetch(`${base}/api/overview`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const overview = await response.json();
    assert.equal(overview.instanceName, 'Test backups');
    assert.equal(overview.destinationCount, 1);

    response = await fetch(`${base}/api/destinations`, { headers: { cookie } });
    const destinations = (await response.json()).destinations;
    assert.equal(destinations.length, 1);
    assert.equal('encrypted_secret' in destinations[0], false);
    assert.equal(destinations[0].config.path, backups);

    instance.worker.stop();
    const sourceId = `src_${crypto.randomUUID()}`;
    const targetId = `target_${crypto.randomUUID()}`;
    const artifactId = `artifact_${crypto.randomUUID()}`;
    instance.store.db.prepare(`INSERT INTO sources (id, name, type, encrypted_config) VALUES (?, 'Test source', 'mongodb', ?)`)
        .run(sourceId, instance.store.encrypt({ uri: 'mongodb://example.invalid', database: 'source_db' }));
    instance.store.db.prepare(`INSERT INTO restore_targets (id, name, database_name, encrypted_config) VALUES (?, 'Recovery', 'recovery_db', ?)`)
        .run(targetId, instance.store.encrypt({ uri: 'mongodb://example.invalid', database: 'recovery_db' }));
    instance.store.db.prepare(`INSERT INTO jobs (id, type, source_id, destination_ids, trigger, status) VALUES (?, 'backup', ?, ?, 'manual', 'succeeded')`)
        .run(`job_${crypto.randomUUID()}`, sourceId, JSON.stringify([destinations[0].id]));
    const backupJob = instance.store.db.prepare("SELECT id FROM jobs WHERE type = 'backup' LIMIT 1").get();
    instance.store.db.prepare(`INSERT INTO artifacts (id, job_id, source_id, destination_id, name, location, size, checksum) VALUES (?, ?, ?, ?, 'test.archive.gz', ?, 4, 'checksum')`)
        .run(artifactId, backupJob.id, sourceId, destinations[0].id, path.join(backups, 'test.archive.gz'));

    response = await fetch(`${base}/api/restore-targets`, { headers: { cookie } });
    const targetResponse = await response.json();
    assert.equal(targetResponse.targets[0].database, 'recovery_db');
    assert.equal('encrypted_config' in targetResponse.targets[0], false);

    response = await fetch(`${base}/api/restores`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-spencer-request': '1' },
        body: JSON.stringify({ artifactId, targetId, confirmation: 'wrong' })
    });
    assert.equal(response.status, 400);

    response = await fetch(`${base}/api/restores`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-spencer-request': '1' },
        body: JSON.stringify({ artifactId, targetId, confirmation: 'recovery_db', dropExisting: true })
    });
    assert.equal(response.status, 202);
    assert.equal(instance.store.db.prepare("SELECT type FROM jobs WHERE id = ?").get((await response.json()).id).type, 'restore');

    response = await fetch(`${base}/api/setup`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instanceName: 'Overwrite', username: 'other', password: 'strongpass123', localPath: backups })
    });
    assert.equal(response.status, 409);

    response = await fetch(`${base}/api/security/mfa/setup`, {
        method: 'POST', headers: { cookie, 'x-spencer-request': '1' }
    });
    assert.equal(response.status, 200);
    const mfaSetup = await response.json();
    assert.match(mfaSetup.otpAuthUri, /^otpauth:\/\/totp\//);

    response = await fetch(`${base}/api/security/mfa/enable`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-spencer-request': '1' },
        body: JSON.stringify({ code: totpAt(mfaSetup.secret) })
    });
    assert.equal(response.status, 200);

    await fetch(`${base}/auth/logout`, { method: 'POST', headers: { cookie } });
    response = await fetch(`${base}/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'strongpass123' })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).requiresMfa, true);
    const mfaCookie = response.headers.get('set-cookie').split(';')[0];

    response = await fetch(`${base}/api/overview`, { headers: { cookie: mfaCookie } });
    assert.equal(response.status, 403);
    response = await fetch(`${base}/auth/mfa/verify`, {
        method: 'POST', headers: { cookie: mfaCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ code: totpAt(mfaSetup.secret) })
    });
    assert.equal(response.status, 200);
    response = await fetch(`${base}/api/overview`, { headers: { cookie: mfaCookie } });
    assert.equal(response.status, 200);
});
