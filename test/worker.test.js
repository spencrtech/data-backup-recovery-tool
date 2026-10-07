const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Store } = require('../src/store');
const { EventBus } = require('../src/events');
const { JobWorker } = require('../src/worker');

test('retention removes expired local artifacts and keeps recent recovery points', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spencer-retention-'));
    const backupDirectory = path.join(directory, 'backups');
    fs.mkdirSync(backupDirectory);
    const store = await Store.create(directory);
    const worker = new JobWorker(store, new EventBus(), { workDir: path.join(directory, 'work') });
    const sourceId = `src_${crypto.randomUUID()}`;
    const destinationId = `dst_${crypto.randomUUID()}`;
    const jobId = `job_${crypto.randomUUID()}`;
    store.db.prepare(`INSERT INTO sources (id, name, type, encrypted_config) VALUES (?, 'Source', 'mongodb', ?)`)
        .run(sourceId, store.encrypt({ uri: 'mongodb://example.invalid', database: 'app' }));
    store.db.prepare(`INSERT INTO destinations (id, name, type, config) VALUES (?, 'Local', 'local', ?)`)
        .run(destinationId, JSON.stringify({ path: backupDirectory }));
    store.db.prepare(`INSERT INTO jobs (id, type, source_id, destination_ids, trigger, status) VALUES (?, 'backup', ?, ?, 'manual', 'succeeded')`)
        .run(jobId, sourceId, JSON.stringify([destinationId]));
    const expiredPath = path.join(backupDirectory, 'expired.archive.gz');
    const recentPath = path.join(backupDirectory, 'recent.archive.gz');
    fs.writeFileSync(expiredPath, 'old');
    fs.writeFileSync(recentPath, 'new');
    store.db.prepare(`INSERT INTO artifacts (id, job_id, source_id, destination_id, name, location, size, checksum, created_at) VALUES ('old', ?, ?, ?, 'expired.archive.gz', ?, 3, 'x', datetime('now', '-40 days'))`)
        .run(jobId, sourceId, destinationId, expiredPath);
    store.db.prepare(`INSERT INTO artifacts (id, job_id, source_id, destination_id, name, location, size, checksum, created_at) VALUES ('new', ?, ?, ?, 'recent.archive.gz', ?, 3, 'y', datetime('now', '-2 days'))`)
        .run(jobId, sourceId, destinationId, recentPath);

    await worker.enforceRetention(sourceId, [destinationId], 30);

    assert.equal(fs.existsSync(expiredPath), false);
    assert.equal(fs.existsSync(recentPath), true);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM artifacts').get().count, 1);
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
});
