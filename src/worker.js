const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { upload, download, remove } = require('./destinations');

function run(command, args, onOutput) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stdout.on('data', (chunk) => onOutput?.(chunk.toString()));
        child.stderr.on('data', (chunk) => {
            stderr = `${stderr}${chunk}`.slice(-12000);
            onOutput?.(chunk.toString());
        });
        child.on('error', reject);
        child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `${command} exited with ${code}`)));
    });
}

async function sha256(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        fs.createReadStream(filePath).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
    });
}

class JobWorker {
    constructor(store, events, options = {}) {
        this.store = store;
        this.events = events;
        this.workDir = path.resolve(options.workDir || path.join(store.dataDir, 'work'));
        this.timer = null;
        this.running = false;
    }

    start() {
        fsp.mkdir(this.workDir, { recursive: true });
        this.store.db.prepare("UPDATE jobs SET status = 'queued', phase = 'recovered', message = 'Recovered after restart' WHERE status = 'running'").run();
        this.timer = setInterval(() => this.tick().catch((error) => console.error('Worker tick failed', error)), 1000);
        this.tick().catch((error) => console.error('Worker startup failed', error));
    }

    stop() {
        clearInterval(this.timer);
    }

    update(jobId, fields) {
        const allowed = ['status', 'phase', 'progress', 'message', 'error', 'artifact_name', 'artifact_size', 'checksum', 'started_at', 'finished_at'];
        const entries = Object.entries(fields).filter(([key]) => allowed.includes(key));
        if (!entries.length) return;
        const sql = `UPDATE jobs SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`;
        this.store.db.prepare(sql).run(...entries.map(([, value]) => value), jobId);
        this.events.publish('job.updated', { id: jobId, ...fields });
    }

    async tick() {
        if (this.running) return;
        const job = this.store.db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1").get();
        if (!job) return;
        this.running = true;
        try {
            if (job.type === 'restore') await this.restore(job);
            else await this.backup(job);
        } finally {
            this.running = false;
        }
    }

    async backup(job) {
        const source = this.store.db.prepare('SELECT * FROM sources WHERE id = ? AND enabled = 1').get(job.source_id);
        if (!source) {
            this.update(job.id, { status: 'failed', error: 'Source is unavailable', finished_at: new Date().toISOString() });
            return;
        }
        const sourceConfig = this.store.decrypt(source.encrypted_config);
        const destinationIds = JSON.parse(job.destination_ids);
        const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
        const filename = `${source.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${timestamp}.archive.gz`;
        const temporaryPath = path.join(this.workDir, `${job.id}.archive.gz`);
        this.update(job.id, {
            status: 'running', phase: 'dumping', progress: 10,
            message: `Creating MongoDB archive for ${sourceConfig.database}`,
            started_at: new Date().toISOString()
        });
        try {
            await run('mongodump', [
                `--uri=${sourceConfig.uri}`,
                `--db=${sourceConfig.database}`,
                `--archive=${temporaryPath}`,
                '--gzip',
                '--numParallelCollections=4'
            ]);
            const stats = await fsp.stat(temporaryPath);
            const checksum = await sha256(temporaryPath);
            this.update(job.id, { phase: 'uploading', progress: 55, message: `Uploading ${filename}` });
            let completed = 0;
            for (const destinationId of destinationIds) {
                const destination = this.store.db.prepare('SELECT * FROM destinations WHERE id = ? AND enabled = 1').get(destinationId);
                if (!destination) throw new Error(`Destination ${destinationId} is unavailable`);
                const secret = destination.encrypted_secret ? this.store.decrypt(destination.encrypted_secret) : {};
                const result = await upload(destination, secret, temporaryPath, filename, {
                    sourceId: source.id,
                    jobId: job.id,
                    checksum
                });
                this.store.db.prepare(`
                    INSERT INTO artifacts (id, job_id, source_id, destination_id, name, location, size, checksum)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `).run(crypto.randomUUID(), job.id, source.id, destination.id, filename, result.location, stats.size, checksum);
                completed += 1;
                this.update(job.id, {
                    progress: 55 + Math.round((completed / destinationIds.length) * 40),
                    message: `Stored in ${completed} of ${destinationIds.length} destinations`
                });
            }
            this.update(job.id, {
                status: 'succeeded', phase: 'complete', progress: 100, message: 'Backup completed and verified',
                artifact_name: filename, artifact_size: stats.size, checksum, finished_at: new Date().toISOString()
            });
            const policy = job.policy_id ? this.store.db.prepare('SELECT retention_days FROM policies WHERE id = ?').get(job.policy_id) : null;
            if (policy?.retention_days) {
                await this.enforceRetention(source.id, destinationIds, policy.retention_days).catch((error) => {
                    this.events.publish('retention.warning', { jobId: job.id, message: error.message });
                });
            }
        } catch (error) {
            this.update(job.id, {
                status: 'failed', phase: 'failed', message: 'Backup failed', error: error.message,
                finished_at: new Date().toISOString()
            });
        } finally {
            await fsp.rm(temporaryPath, { force: true }).catch(() => {});
        }
    }

    async restore(job) {
        const artifact = this.store.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(job.artifact_id);
        const target = this.store.db.prepare('SELECT * FROM restore_targets WHERE id = ? AND enabled = 1').get(job.restore_target_id);
        if (!artifact || !target) {
            this.update(job.id, { status: 'failed', error: 'Recovery point or restore target is unavailable', finished_at: new Date().toISOString() });
            return;
        }
        const source = this.store.db.prepare('SELECT * FROM sources WHERE id = ?').get(artifact.source_id);
        const destination = this.store.db.prepare('SELECT * FROM destinations WHERE id = ?').get(artifact.destination_id);
        if (!source || !destination) {
            this.update(job.id, { status: 'failed', error: 'Source metadata or storage destination is unavailable', finished_at: new Date().toISOString() });
            return;
        }
        const destinationSecret = destination.encrypted_secret ? this.store.decrypt(destination.encrypted_secret) : {};
        const sourceConfig = this.store.decrypt(source.encrypted_config);
        const targetConfig = this.store.decrypt(target.encrypted_config);
        const options = job.options ? JSON.parse(job.options) : {};
        const temporaryPath = path.join(this.workDir, `${job.id}.restore.archive.gz`);
        this.update(job.id, {
            status: 'running', phase: 'downloading', progress: 10,
            message: `Downloading ${artifact.name}`,
            started_at: new Date().toISOString()
        });
        try {
            await download(destination, destinationSecret, artifact.location, temporaryPath);
            this.update(job.id, { phase: 'verifying', progress: 35, message: 'Verifying SHA-256 checksum' });
            const checksum = await sha256(temporaryPath);
            if (checksum !== artifact.checksum) throw new Error('Checksum verification failed; restore was stopped');
            this.update(job.id, { phase: 'restoring', progress: 55, message: `Restoring into ${target.database_name}` });
            const args = [
                `--uri=${targetConfig.uri}`,
                `--archive=${temporaryPath}`,
                '--gzip',
                `--nsInclude=${sourceConfig.database}.*`,
                `--nsFrom=${sourceConfig.database}.*`,
                `--nsTo=${targetConfig.database}.*`
            ];
            if (options.dropExisting) args.push('--drop');
            await run('mongorestore', args);
            this.update(job.id, {
                status: 'succeeded', phase: 'complete', progress: 100,
                message: `Restore completed into ${target.database_name}`,
                artifact_name: artifact.name, artifact_size: artifact.size, checksum,
                finished_at: new Date().toISOString()
            });
        } catch (error) {
            this.update(job.id, {
                status: 'failed', phase: 'failed', message: 'Restore failed', error: error.message,
                finished_at: new Date().toISOString()
            });
        } finally {
            await fsp.rm(temporaryPath, { force: true }).catch(() => {});
        }
    }

    async enforceRetention(sourceId, destinationIds, retentionDays) {
        const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
        for (const destinationId of destinationIds) {
            const destination = this.store.db.prepare('SELECT * FROM destinations WHERE id = ?').get(destinationId);
            if (!destination) continue;
            const secret = destination.encrypted_secret ? this.store.decrypt(destination.encrypted_secret) : {};
            const expired = this.store.db.prepare(`
                SELECT * FROM artifacts WHERE source_id = ? AND destination_id = ? AND created_at < ? ORDER BY created_at ASC
            `).all(sourceId, destinationId, cutoff);
            for (const artifact of expired) {
                await remove(destination, secret, artifact.location);
                this.store.db.prepare('DELETE FROM artifacts WHERE id = ?').run(artifact.id);
                this.events.publish('artifact.expired', { id: artifact.id, destinationId, retentionDays });
            }
        }
    }
}

module.exports = { JobWorker };
