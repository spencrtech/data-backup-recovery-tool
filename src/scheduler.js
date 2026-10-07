const cron = require('node-cron');
const crypto = require('crypto');

class Scheduler {
    constructor(store, events) {
        this.store = store;
        this.events = events;
        this.tasks = new Map();
    }

    reload() {
        for (const task of this.tasks.values()) task.stop();
        this.tasks.clear();
        const policies = this.store.db.prepare('SELECT * FROM policies WHERE enabled = 1').all();
        for (const policy of policies) {
            if (!cron.validate(policy.schedule)) continue;
            const task = cron.schedule(policy.schedule, () => {
                const id = crypto.randomUUID();
                this.store.db.prepare(`
                    INSERT INTO jobs (id, type, source_id, destination_ids, policy_id, trigger, status, phase, message)
                    VALUES (?, 'backup', ?, ?, ?, 'scheduled', 'queued', 'queued', 'Waiting for worker')
                `).run(id, policy.source_id, policy.destination_ids, policy.id);
                this.store.db.prepare("INSERT INTO job_logs (job_id, level, message) VALUES (?, 'info', 'Scheduled backup queued')").run(id);
                this.events.publish('job.created', { id, policyId: policy.id });
            }, { timezone: policy.timezone || 'UTC' });
            this.tasks.set(policy.id, task);
        }
    }
}

module.exports = { Scheduler };
