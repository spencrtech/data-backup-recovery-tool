const state = {
    page: 'overview', user: null, overview: null, sources: [], destinations: [], policies: [], jobs: [], artifacts: [], restoreTargets: [], security: null, auditEvents: [], activeJobId: null
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const formatBytes = (bytes = 0) => {
    if (!Number(bytes)) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / (1024 ** index)).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
};
const relativeTime = (value) => {
    if (!value) return 'Never';
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
};

async function api(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && typeof options.body !== 'string') {
        headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(options.body);
    }
    if (options.method && options.method !== 'GET') headers['X-Spencer-Request'] = '1';
    const response = await fetch(url, { credentials: 'same-origin', ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(data.error || `Request failed (${response.status})`);
        error.status = response.status;
        throw error;
    }
    return data;
}

function toast(message, type = 'success') {
    const element = document.createElement('div');
    element.className = `toast ${type}`;
    element.textContent = message;
    $('#toast-region').appendChild(element);
    setTimeout(() => element.remove(), 4500);
}

function showOnly(id) {
    ['setup-view', 'login-view', 'app-view'].forEach((view) => $(`#${view}`).classList.toggle('hidden', view !== id));
}

function setFormError(id, message = '') {
    const element = $(`#${id}`);
    element.textContent = message;
    element.classList.toggle('hidden', !message);
}

async function initialize() {
    const setup = await api('/api/setup/status');
    if (setup.setupRequired) return showOnly('setup-view');
    const session = await api('/api/session');
    if (!session.authenticated) {
        showOnly('login-view');
        $('#login-form').classList.toggle('hidden', Boolean(session.mfaRequired));
        $('#mfa-form').classList.toggle('hidden', !session.mfaRequired);
        return;
    }
    state.user = session.user;
    showOnly('app-view');
    $('#profile-name').textContent = state.user.username;
    $('#profile-initial').textContent = state.user.username.slice(0, 1).toUpperCase();
    connectEvents();
    await navigate('overview');
}

$('#setup-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    setFormError('setup-error');
    const button = $('button[type="submit"]', event.currentTarget);
    button.disabled = true;
    button.textContent = 'Creating secure workspace…';
    try {
        const body = Object.fromEntries(new FormData(event.currentTarget));
        await api('/api/setup', { method: 'POST', body });
        toast('Workspace created. Welcome to Spencer.');
        await initialize();
    } catch (error) {
        setFormError('setup-error', error.message);
    } finally {
        button.disabled = false;
        button.innerHTML = 'Create workspace <span>→</span>';
    }
});

$('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    setFormError('login-error');
    const button = $('button[type="submit"]', event.currentTarget);
    button.disabled = true;
    try {
        const result = await api('/auth/login', { method: 'POST', body: Object.fromEntries(new FormData(event.currentTarget)) });
        if (result.requiresMfa) {
            event.currentTarget.classList.add('hidden');
            $('#mfa-form').classList.remove('hidden');
            $('#mfa-form [name="code"]').focus();
        } else await initialize();
    } catch (error) {
        setFormError('login-error', error.message);
    } finally { button.disabled = false; }
});

$('#mfa-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    setFormError('mfa-error');
    const button = $('button[type="submit"]', event.currentTarget);
    button.disabled = true;
    try {
        await api('/auth/mfa/verify', { method: 'POST', body: Object.fromEntries(new FormData(event.currentTarget)) });
        event.currentTarget.reset();
        await initialize();
    } catch (error) { setFormError('mfa-error', error.message); }
    finally { button.disabled = false; }
});

$('#mfa-back').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' });
    $('#mfa-form').classList.add('hidden');
    $('#login-form').classList.remove('hidden');
});

$('#logout-button').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' });
    location.reload();
});

$('#main-nav').addEventListener('click', (event) => {
    const button = event.target.closest('[data-page]');
    if (button) navigate(button.dataset.page);
});

async function loadData() {
    const [overview, sources, destinations, policies, jobs, artifacts, restoreTargets, security, audit] = await Promise.all([
        api('/api/overview'), api('/api/sources'), api('/api/destinations'), api('/api/policies'), api('/api/jobs'), api('/api/artifacts'), api('/api/restore-targets'),
        api('/api/security'), api('/api/audit-events')
    ]);
    Object.assign(state, {
        overview, sources: sources.sources, destinations: destinations.destinations,
        policies: policies.policies, jobs: jobs.jobs, artifacts: artifacts.artifacts, restoreTargets: restoreTargets.targets,
        security, auditEvents: audit.events
    });
}

async function navigate(page) {
    state.page = page;
    $$('#main-nav [data-page]').forEach((button) => button.classList.toggle('active', button.dataset.page === page));
    $('#page-title').textContent = ({ overview: 'Overview', sources: 'Sources', destinations: 'Destinations', policies: 'Backup policies', jobs: 'Jobs', recovery: 'Recovery', storage: 'Storage', settings: 'Settings' })[page];
    const primary = $('#primary-action');
    primary.textContent = ({ sources: 'Add source', destinations: 'Add destination', policies: 'Create policy', recovery: 'Add restore target' })[page] || 'Run backup';
    primary.onclick = ({ sources: openSourceModal, destinations: openDestinationModal, policies: openPolicyModal, recovery: openRestoreTargetModal })[page] || openRunModal;
    primary.classList.toggle('hidden', page === 'settings');
    $('#page-content').innerHTML = '<div class="empty-state"><div class="empty-icon">•••</div><p>Loading workspace…</p></div>';
    try {
        await loadData();
        render();
    } catch (error) {
        if (error.status === 401) return showOnly('login-view');
        $('#page-content').innerHTML = emptyState('!', 'Unable to load this page', escapeHtml(error.message));
    }
}

function render() {
    const renderers = { overview: renderOverview, sources: renderSources, destinations: renderDestinations, policies: renderPolicies, jobs: renderJobs, recovery: renderRecovery, storage: renderStorage, settings: renderSettings };
    $('#page-content').innerHTML = renderers[state.page]();
    bindPageActions();
}

function emptyState(icon, title, copy, action = '') {
    return `<div class="empty-state"><div class="empty-icon">${icon}</div><h3>${title}</h3><p>${copy}</p>${action}</div>`;
}

function jobStatus(job) {
    return `<span class="status ${escapeHtml(job.status)}">${escapeHtml(job.status)}</span>`;
}

function renderOverview() {
    const overview = state.overview;
    const disk = overview.localStorage || { totalBytes: 0, usedBytes: 0, freeBytes: 0 };
    const usedPercent = disk.totalBytes ? Math.min(100, (disk.usedBytes / disk.totalBytes) * 100) : 0;
    const successful = state.jobs.filter((job) => job.status === 'succeeded').length;
    const successRate = state.jobs.length ? Math.round((successful / state.jobs.length) * 100) : 100;
    const running = state.jobs.filter((job) => ['queued', 'running'].includes(job.status)).length;
    const latest = state.jobs.slice(0, 5);
    return `
        <div class="hero-row">
            <section class="hero-card">
                <p class="eyebrow">${escapeHtml(overview.instanceName).toUpperCase()}</p>
                <h2>${overview.sourceCount ? `${overview.sourceCount} source${overview.sourceCount === 1 ? '' : 's'} protected and ready.` : 'Your backup control plane is ready.'}</h2>
                <p>${overview.sourceCount ? 'Monitor protection health, run an on-demand backup, or inspect your latest recovery points.' : 'Connect your first MongoDB source, then choose where its recovery points should live.'}</p>
                <div class="hero-actions"><button class="button primary" data-action="run">Run backup</button><button class="button secondary" data-action="add-source">Add source</button></div>
            </section>
            <section class="capacity-card">
                <p class="eyebrow dark">LOCAL CAPACITY</p><h3>Storage headroom</h3>
                <div class="capacity-value">${formatBytes(disk.freeBytes)} <small>free</small></div>
                <div class="progress-track"><span style="width:${usedPercent.toFixed(1)}%"></span></div>
                <div class="capacity-meta"><span>${formatBytes(disk.usedBytes)} used</span><span>${formatBytes(disk.totalBytes)} total</span></div>
            </section>
        </div>
        <div class="metric-grid">
            <div class="metric-card"><div class="metric-label">Sources <span class="metric-icon">◉</span></div><strong>${overview.sourceCount}</strong><small>MongoDB connections</small></div>
            <div class="metric-card"><div class="metric-label">Destinations <span class="metric-icon">◇</span></div><strong>${overview.destinationCount}</strong><small>Active storage targets</small></div>
            <div class="metric-card"><div class="metric-label">Success rate <span class="metric-icon">✓</span></div><strong>${successRate}%</strong><small>Across recent jobs</small></div>
            <div class="metric-card"><div class="metric-label">In progress <span class="metric-icon">↗</span></div><strong>${running}</strong><small>${overview.failedJobs} failures in 24 hours</small></div>
        </div>
        <div class="content-grid">
            <section class="panel"><div class="panel-header"><div><h2>Recent jobs</h2><p>Persistent backup activity from this instance</p></div><button class="icon-button" data-page-jump="jobs">View all</button></div><div class="panel-body flush">${renderJobsTable(latest)}</div></section>
            <section class="panel"><div class="panel-header"><div><h2>Recovery points</h2><p>Latest verified artifacts</p></div></div><div class="panel-body">${renderActivity(state.artifacts.slice(0, 5))}</div></section>
        </div>`;
}

function renderJobsTable(jobs) {
    if (!jobs.length) return emptyState('↗', 'No jobs yet', 'Run your first backup to see persistent progress and results here.');
    return `<table class="data-table"><thead><tr><th>Source</th><th>Status</th><th>Progress</th><th>Started</th><th></th></tr></thead><tbody>${jobs.map((job) => `
        <tr><td><div class="primary-cell">${job.type === 'restore' ? '↩ Restore · ' : ''}${escapeHtml(job.source_name || 'Deleted source')}</div><div class="secondary-cell">${escapeHtml(job.message || job.phase || '')}</div></td><td>${jobStatus(job)}</td><td><div class="job-progress"><b>${job.progress}%</b><div class="progress-track"><span style="width:${job.progress}%"></span></div></div></td><td>${relativeTime(job.started_at || job.created_at)}</td><td><button class="icon-button" data-view-job="${job.id}">View</button></td></tr>
    `).join('')}</tbody></table>`;
}

function renderActivity(artifacts) {
    if (!artifacts.length) return emptyState('▱', 'No recovery points', 'Verified backup artifacts will appear here.');
    return `<div class="activity-list">${artifacts.map((item) => `<div class="activity-item"><span class="activity-icon">✓</span><div><strong>${escapeHtml(item.source_name)}</strong><small>${escapeHtml(item.destination_name)} · ${formatBytes(item.size)}</small></div><time>${relativeTime(item.created_at)}</time></div>`).join('')}</div>`;
}

function renderSources() {
    return `<div class="section-heading"><div><h2>MongoDB sources</h2><p>Credentials are encrypted locally and never returned to the browser.</p></div></div>
        ${state.sources.length ? `<div class="source-grid">${state.sources.map((source) => `<article class="resource-card"><div class="resource-icon">M</div><h3>${escapeHtml(source.name)}</h3><p>MongoDB source · Added ${relativeTime(source.createdAt)}</p><div class="resource-footer"><span class="status ${source.enabled ? 'healthy' : 'failed'}">${source.enabled ? 'Enabled' : 'Disabled'}</span><div class="row-actions"><button class="icon-button" data-test-source="${source.id}">Test</button><button class="icon-button" data-toggle-source="${source.id}" data-enabled="${source.enabled}">${source.enabled ? 'Disable' : 'Enable'}</button><button class="icon-button danger-text" data-delete-source="${source.id}">Delete</button></div></div></article>`).join('')}</div>` : emptyState('◉', 'No sources connected', 'Add a MongoDB connection to start measuring and protecting your data.', '<button class="button primary" data-action="add-source">Add MongoDB source</button>')}`;
}

function destinationDetail(item) {
    if (item.type === 'local') return item.config.path;
    if (item.type === 'firebase') return item.config.bucket;
    return `${item.config.bucket}${item.config.region ? ` · ${item.config.region}` : ''}`;
}

function renderDestinations() {
    return `<div class="section-heading"><div><h2>Storage destinations</h2><p>Local disk, private Firebase Storage, and S3-compatible object storage.</p></div></div>
        <div class="destination-grid">${state.destinations.map((item) => `<article class="resource-card"><div class="resource-icon">${item.type === 'local' ? '▱' : item.type === 'firebase' ? 'F' : 'S3'}</div><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(destinationDetail(item))}</p><div class="resource-footer"><span class="status ${item.enabled ? 'healthy' : 'failed'}">${item.enabled ? escapeHtml(item.type) : 'Disabled'}</span><div class="row-actions"><button class="icon-button" data-test-destination="${item.id}">Test</button><button class="icon-button" data-toggle-destination="${item.id}" data-enabled="${item.enabled}">${item.enabled ? 'Disable' : 'Enable'}</button><button class="icon-button danger-text" data-delete-destination="${item.id}">Delete</button></div></div></article>`).join('')}
        <button class="resource-card" data-action="add-destination" style="border-style:dashed;text-align:left"><div class="resource-icon">＋</div><h3>Add destination</h3><p>Connect Firebase or S3-compatible storage.</p></button></div>`;
}

function renderPolicies() {
    if (!state.policies.length) return `<div class="section-heading"><div><h2>Backup policies</h2><p>Automate protection with cron schedules, time zones, and retention.</p></div></div>${emptyState('◷', 'No policies configured', 'Create a policy after adding a source and destination.', '<button class="button primary" data-action="add-policy">Create policy</button>')}`;
    return `<div class="section-heading"><div><h2>Backup policies</h2><p>Schedules are persisted and resume automatically after restarts.</p></div></div><section class="panel"><div class="panel-body flush"><table class="data-table"><thead><tr><th>Policy</th><th>Schedule</th><th>Timezone</th><th>Retention</th><th>Status</th><th></th></tr></thead><tbody>${state.policies.map((item) => `<tr><td class="primary-cell">${escapeHtml(item.name)}</td><td><code>${escapeHtml(item.schedule)}</code></td><td>${escapeHtml(item.timezone)}</td><td>${item.retention_days} days</td><td><span class="status ${item.enabled ? 'healthy' : 'failed'}">${item.enabled ? 'Active' : 'Paused'}</span></td><td><div class="row-actions"><button class="icon-button" data-toggle-policy="${item.id}" data-enabled="${item.enabled}">${item.enabled ? 'Pause' : 'Resume'}</button><button class="icon-button" data-delete-policy="${item.id}">Delete</button></div></td></tr>`).join('')}</tbody></table></div></section>`;
}

function renderJobs() {
    return `<div class="section-heading"><div><h2>Backup jobs</h2><p>Live, persistent execution history. Refresh is automatic while this page is open.</p></div></div><section class="panel"><div class="panel-body flush">${renderJobsTable(state.jobs)}</div></section>`;
}

function renderRecovery() {
    const targets = state.restoreTargets;
    return `<div class="section-heading"><div><h2>Recovery</h2><p>Every restore verifies the artifact checksum and requires the target database name as confirmation.</p></div></div>
        <div class="content-grid"><section class="panel"><div class="panel-header"><div><h2>Recovery points</h2><p>Choose a verified artifact to restore</p></div></div><div class="panel-body flush">${state.artifacts.length ? `<table class="data-table"><thead><tr><th>Source</th><th>Destination</th><th>Size</th><th>Created</th><th></th></tr></thead><tbody>${state.artifacts.map((item) => `<tr><td class="primary-cell">${escapeHtml(item.source_name)}</td><td>${escapeHtml(item.destination_name)}</td><td>${formatBytes(item.size)}</td><td>${relativeTime(item.created_at)}</td><td><button class="icon-button" data-restore-artifact="${item.id}">Restore</button></td></tr>`).join('')}</tbody></table>` : emptyState('↩', 'No recovery points', 'Run a successful backup before attempting a restore.')}</div></section>
        <section class="panel"><div class="panel-header"><div><h2>Restore targets</h2><p>MongoDB destinations approved for recovery</p></div></div><div class="panel-body">${targets.length ? `<div class="activity-list">${targets.map((target) => `<div class="activity-item"><span class="activity-icon">M</span><div><strong>${escapeHtml(target.name)}</strong><small>${escapeHtml(target.database)}</small></div><button class="icon-button" data-toggle-target="${target.id}" data-enabled="${target.enabled}">${target.enabled ? 'Disable' : 'Enable'}</button></div>`).join('')}</div>` : emptyState('M', 'No restore targets', 'Add an isolated MongoDB target for recovery tests.', '<button class="button primary" data-action="add-target">Add target</button>')}</div></section></div>`;
}

function renderStorage() {
    const total = state.artifacts.reduce((sum, item) => sum + Number(item.size || 0), 0);
    const byDestination = state.destinations.map((destination) => {
        const items = state.artifacts.filter((item) => item.destination_id === destination.id);
        return { destination, count: items.length, bytes: items.reduce((sum, item) => sum + Number(item.size || 0), 0) };
    });
    const estimatedMonthly = byDestination.reduce((sum, item) => sum + (item.bytes / (1024 ** 3)) * Number(item.destination.config.costPerGbMonth || 0), 0);
    return `<div class="metric-grid"><div class="metric-card"><div class="metric-label">Stored backups</div><strong>${state.artifacts.length}</strong><small>Verified recovery points</small></div><div class="metric-card"><div class="metric-label">Backup footprint</div><strong>${formatBytes(total)}</strong><small>Across known destinations</small></div><div class="metric-card"><div class="metric-label">Destinations</div><strong>${state.destinations.length}</strong><small>Local and cloud</small></div><div class="metric-card"><div class="metric-label">Estimated monthly</div><strong>$${estimatedMonthly.toFixed(2)}</strong><small>Storage only, using configured rates</small></div></div>
        <section class="panel"><div class="panel-header"><div><h2>Destination usage</h2><p>Recorded artifacts and configurable storage-rate estimates. Requests and transfer are excluded.</p></div></div><div class="panel-body flush"><table class="data-table"><thead><tr><th>Destination</th><th>Type</th><th>Recovery points</th><th>Recorded size</th><th>Estimate / month</th></tr></thead><tbody>${byDestination.map(({ destination, count, bytes }) => `<tr><td class="primary-cell">${escapeHtml(destination.name)}</td><td>${escapeHtml(destination.type)}</td><td>${count}</td><td>${formatBytes(bytes)}</td><td>$${((bytes / (1024 ** 3)) * Number(destination.config.costPerGbMonth || 0)).toFixed(2)}</td></tr>`).join('')}</tbody></table></div></section>`;
}

function renderSettings() {
    const security = state.security;
    return `<div class="section-heading"><div><h2>Workspace settings</h2><p>Security and administrative activity remain local to this Spencer instance.</p></div></div>
        <div class="content-grid"><section class="panel"><div class="panel-header"><div><h2>Sign-in security</h2><p>${escapeHtml(security.user.username)} · ${escapeHtml(security.user.role)}</p></div><span class="status ${security.mfaEnabled ? 'healthy' : 'queued'}">${security.mfaEnabled ? 'MFA enabled' : 'Password only'}</span></div><div class="panel-body"><p class="muted">Add a time-based one-time password from 1Password, Google Authenticator, Microsoft Authenticator, or another compatible app.</p>${security.mfaEnabled ? '<button class="button danger" data-action="disable-mfa">Disable authenticator MFA</button>' : '<button class="button primary" data-action="setup-mfa">Set up authenticator MFA</button>'}<p class="security-note" style="text-align:left">This session expires ${new Date(security.sessionExpiresAt).toLocaleString()}.</p></div></section>
        <section class="panel"><div class="panel-header"><div><h2>Configuration protection</h2><p>Device-local trust boundary</p></div></div><div class="panel-body"><div class="activity-list"><div class="activity-item"><span class="activity-icon">✓</span><div><strong>AES-256-GCM secrets</strong><small>Database and cloud credentials are encrypted at rest</small></div></div><div class="activity-item"><span class="activity-icon">✓</span><div><strong>Private sessions</strong><small>HTTP-only, same-site cookies with twelve-hour expiry</small></div></div><div class="activity-item"><span class="activity-icon">✓</span><div><strong>Local audit trail</strong><small>Administrative actions are retained below</small></div></div></div></div></section></div>
        <section class="panel" style="margin-top:18px"><div class="panel-header"><div><h2>Recent audit events</h2><p>The latest 100 control-plane changes</p></div></div><div class="panel-body flush">${state.auditEvents.length ? `<table class="data-table"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead><tbody>${state.auditEvents.map((event) => `<tr><td>${relativeTime(event.created_at)}</td><td class="primary-cell">${escapeHtml(event.actor)}</td><td><code>${escapeHtml(event.action)}</code></td><td>${escapeHtml(event.target_type || 'instance')}${event.target_id ? ` · ${escapeHtml(event.target_id)}` : ''}</td></tr>`).join('')}</tbody></table>` : emptyState('✓', 'No audit events yet', 'Administrative changes will appear here.')}</div></section>`;
}

function bindPageActions() {
    $$('[data-action="add-source"]').forEach((el) => el.onclick = openSourceModal);
    $$('[data-action="add-destination"]').forEach((el) => el.onclick = openDestinationModal);
    $$('[data-action="add-policy"]').forEach((el) => el.onclick = openPolicyModal);
    $$('[data-action="add-target"]').forEach((el) => el.onclick = openRestoreTargetModal);
    $$('[data-action="run"]').forEach((el) => el.onclick = openRunModal);
    $$('[data-page-jump]').forEach((el) => el.onclick = () => navigate(el.dataset.pageJump));
    $$('[data-test-source]').forEach((el) => el.onclick = () => testResource(`/api/sources/${el.dataset.testSource}/test`, el));
    $$('[data-test-destination]').forEach((el) => el.onclick = () => testResource(`/api/destinations/${el.dataset.testDestination}/test`, el));
    $$('[data-toggle-source]').forEach((el) => el.onclick = () => toggleResource(`/api/sources/${el.dataset.toggleSource}`, el.dataset.enabled !== 'true', 'Source'));
    $$('[data-toggle-destination]').forEach((el) => el.onclick = () => toggleResource(`/api/destinations/${el.dataset.toggleDestination}`, el.dataset.enabled !== 'true', 'Destination'));
    $$('[data-toggle-policy]').forEach((el) => el.onclick = () => toggleResource(`/api/policies/${el.dataset.togglePolicy}`, el.dataset.enabled !== 'true', 'Policy'));
    $$('[data-toggle-target]').forEach((el) => el.onclick = () => toggleResource(`/api/restore-targets/${el.dataset.toggleTarget}`, el.dataset.enabled !== 'true', 'Restore target'));
    $$('[data-delete-policy]').forEach((el) => el.onclick = () => deletePolicy(el.dataset.deletePolicy));
    $$('[data-restore-artifact]').forEach((el) => el.onclick = () => openRestoreModal(el.dataset.restoreArtifact));
    $$('[data-view-job]').forEach((el) => el.onclick = () => openJobDetails(el.dataset.viewJob));
    $$('[data-delete-source]').forEach((el) => el.onclick = () => deleteResource(`/api/sources/${el.dataset.deleteSource}`, 'source'));
    $$('[data-delete-destination]').forEach((el) => el.onclick = () => deleteResource(`/api/destinations/${el.dataset.deleteDestination}`, 'destination'));
    $$('[data-action="setup-mfa"]').forEach((el) => el.onclick = openMfaSetupModal);
    $$('[data-action="disable-mfa"]').forEach((el) => el.onclick = openMfaDisableModal);
}

async function openMfaSetupModal() {
    try {
        const setup = await api('/api/security/mfa/setup', { method: 'POST' });
        showModal(`<p class="eyebrow dark">SIGN-IN SECURITY</p><h2>Connect an authenticator</h2><p>Add a new time-based account in your authenticator app. Enter this secret manually or paste the setup URI into an app that supports it.</p><form id="mfa-enable-form"><label>Setup secret<input value="${escapeHtml(setup.secret)}" readonly></label><label>Authenticator URI<textarea readonly>${escapeHtml(setup.otpAuthUri)}</textarea></label><label>Six-digit code<input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autocomplete="one-time-code" placeholder="000000"></label><div class="modal-actions"><button type="button" class="button secondary" data-close-modal>Cancel</button><button class="button primary" type="submit">Verify and enable</button></div></form>`);
        $('[data-close-modal]', $('#modal-content')).onclick = closeModal;
        $('#mfa-enable-form').onsubmit = async (event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            await submitModalRequest(event.currentTarget, '/api/security/mfa/enable', { code: form.get('code') }, 'Authenticator MFA enabled');
        };
    } catch (error) { toast(error.message, 'error'); }
}

function openMfaDisableModal() {
    showModal(`<p class="eyebrow dark">SIGN-IN SECURITY</p><h2>Disable authenticator MFA</h2><p>Your account will return to password-only sign-in. Enter your current password to confirm.</p><form id="mfa-disable-form"><label>Current password<input name="password" type="password" required autocomplete="current-password"></label><div class="modal-actions"><button type="button" class="button secondary" data-close-modal>Cancel</button><button class="button danger" type="submit">Disable MFA</button></div></form>`);
    $('[data-close-modal]', $('#modal-content')).onclick = closeModal;
    $('#mfa-disable-form').onsubmit = async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        await submitModalRequest(event.currentTarget, '/api/security/mfa/disable', { password: form.get('password') }, 'Authenticator MFA disabled');
    };
}

async function toggleResource(url, enabled, label) {
    try { await api(url, { method: 'PATCH', body: { enabled } }); toast(`${label} ${enabled ? 'enabled' : 'disabled'}`); await navigate(state.page); }
    catch (error) { toast(error.message, 'error'); }
}

async function deletePolicy(id) {
    if (!window.confirm('Delete this backup policy? Existing jobs and recovery points are kept.')) return;
    try { await api(`/api/policies/${id}`, { method: 'DELETE' }); toast('Policy deleted'); await navigate(state.page); }
    catch (error) { toast(error.message, 'error'); }
}

async function deleteResource(url, label) {
    const warning = label === 'destination'
        ? 'Delete this destination? It will disappear from configuration, but Spencer will retain the encrypted connection internally when existing recovery points still depend on it.'
        : 'Delete this source? Its credentials will be erased, linked policies will stop, and historical jobs will remain visible.';
    if (!window.confirm(warning)) return;
    try {
        await api(url, { method: 'DELETE' });
        toast(`${label[0].toUpperCase()}${label.slice(1)} deleted`);
        await navigate(state.page);
    } catch (error) { toast(error.message, 'error'); }
}

function renderJobDetails({ job, logs }) {
    const destinations = job.destinations?.map((item) => item.name).join(', ') || 'Unavailable';
    const logLines = logs.length ? logs.map((entry) => `<div class="job-log-line ${escapeHtml(entry.level)}"><time>${escapeHtml(new Date(entry.created_at).toLocaleTimeString())}</time><b>${escapeHtml(entry.level)}</b><span>${escapeHtml(entry.message)}</span></div>`).join('') : '<div class="job-log-empty">Waiting for job output…</div>';
    $('#modal-content').innerHTML = `<p class="eyebrow dark">RUN DETAILS · ${escapeHtml(job.type.toUpperCase())}</p><div class="job-detail-title"><div><h2>${escapeHtml(job.source_name || 'Deleted source')}</h2><p>${escapeHtml(job.id)}</p></div>${jobStatus(job)}</div>
        <div class="job-detail-grid"><div><small>Trigger</small><strong>${escapeHtml(job.trigger)}</strong></div><div><small>Phase</small><strong>${escapeHtml(job.phase || '—')}</strong></div><div><small>Destination</small><strong>${escapeHtml(destinations)}</strong></div><div><small>Started</small><strong>${job.started_at ? new Date(job.started_at).toLocaleString() : 'Not started'}</strong></div><div><small>Finished</small><strong>${job.finished_at ? new Date(job.finished_at).toLocaleString() : 'In progress'}</strong></div><div><small>Artifact</small><strong>${job.artifact_size ? formatBytes(job.artifact_size) : '—'}</strong></div></div>
        <div class="job-detail-progress"><div><span>${escapeHtml(job.message || job.phase || 'Waiting')}</span><b>${Number(job.progress || 0)}%</b></div><div class="progress-track"><span style="width:${Number(job.progress || 0)}%"></span></div></div>
        ${job.error ? `<div class="job-error"><strong>Failure detail</strong><p>${escapeHtml(job.error)}</p></div>` : ''}
        <div class="job-log-heading"><div><h3>Execution log</h3><p>Updates automatically while this window is open.</p></div><span class="live-pill"><i></i>Live</span></div><div class="job-log" id="job-log-output">${logLines}</div>`;
    const output = $('#job-log-output');
    if (output) output.scrollTop = output.scrollHeight;
}

async function refreshJobDetails(id) {
    if (state.activeJobId !== id || $('#modal').classList.contains('hidden')) return;
    try { renderJobDetails(await api(`/api/jobs/${id}`)); }
    catch (error) { toast(error.message, 'error'); }
}

async function openJobDetails(id) {
    state.activeJobId = id;
    showModal('<p class="eyebrow dark">RUN DETAILS</p><h2>Loading execution log…</h2>');
    await refreshJobDetails(id);
}

async function testResource(url, button) {
    const original = button.textContent;
    button.disabled = true; button.textContent = 'Testing…';
    try {
        const result = await api(url, { method: 'POST' });
        if (result.metrics) {
            showModal(`<p class="eyebrow dark">SOURCE HEALTH</p><h2>${escapeHtml(result.database || 'MongoDB')} is reachable</h2><p>Live statistics returned by MongoDB.</p><div class="metric-grid" style="grid-template-columns:1fr 1fr"><div class="metric-card"><div class="metric-label">Logical data</div><strong>${formatBytes(result.metrics.dataBytes)}</strong></div><div class="metric-card"><div class="metric-label">Allocated storage</div><strong>${formatBytes(result.metrics.storageBytes)}</strong></div><div class="metric-card"><div class="metric-label">Indexes</div><strong>${formatBytes(result.metrics.indexBytes)}</strong></div><div class="metric-card"><div class="metric-label">Collections</div><strong>${Number(result.metrics.collections || 0)}</strong></div></div><div class="modal-actions"><button class="button primary" data-close-modal>Done</button></div>`);
            $('[data-close-modal]', $('#modal-content')).onclick = closeModal;
        } else toast(result.detail || 'Connection successful');
    } catch (error) { toast(error.message, 'error'); }
    finally { button.disabled = false; button.textContent = original; }
}

function showModal(html) {
    $('#modal-content').innerHTML = html;
    $('#modal').classList.remove('hidden');
}
function closeModal() { state.activeJobId = null; $('#modal').classList.add('hidden'); $('#modal-content').innerHTML = ''; }
$$('[data-close-modal]').forEach((element) => element.addEventListener('click', closeModal));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeModal(); });

function openSourceModal() {
    showModal(`<p class="eyebrow dark">NEW SOURCE</p><h2>Connect MongoDB</h2><p>Paste your connection URI. Spencer will verify it and find the databases you can access automatically.</p><form id="source-form"><label>Display name<input name="name" required placeholder="Customer API production"></label><label>MongoDB connection URI<input name="uri" type="password" required placeholder="mongodb+srv://user:password@cluster…" autocomplete="off"></label><div class="connection-status idle" id="discovery-status">Waiting for a connection URI</div><div id="source-database-field"><label>Database<select disabled><option>Database will be detected automatically</option></select></label></div><details class="advanced-settings"><summary>Advanced connection settings</summary><div><label>Authentication database<input name="authDatabase" value="admin" required><small>Detected from authSource; otherwise admin</small></label></div></details><div class="modal-actions"><button type="button" class="button secondary" data-close-modal>Cancel</button><button class="button primary" type="submit">Test and save</button></div></form>`);
    $('[data-close-modal]', $('#modal-content')).onclick = closeModal;
    const form = $('#source-form');
    const databaseField = $('#source-database-field');
    const status = $('#discovery-status');
    let discoverySequence = 0;
    let discoveryTimer;
    let lastDiscoveryUri = '';
    const renderDatabaseField = (databases = [], selected = '') => {
        databaseField.innerHTML = databases.length
            ? `<label>Database<div class="select-shell"><select name="database" required><option value="" disabled ${selected ? '' : 'selected'}>Choose a database</option>${databases.map((name) => `<option value="${escapeHtml(name)}" ${name === selected ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select></div><small>Choose the database this source should protect</small></label>`
            : '<label>Database name<input name="database" required placeholder="Enter the database name"><small>Automatic discovery is unavailable for this database user</small></label>';
    };
    const discover = async () => {
        const uri = form.elements.uri.value.trim();
        if (!uri) {
            discoverySequence += 1;
            lastDiscoveryUri = '';
            status.className = 'connection-status idle'; status.textContent = 'Waiting for a connection URI';
            databaseField.innerHTML = '<label>Database<select disabled><option>Database will be detected automatically</option></select></label>';
            return;
        }
        if (uri === lastDiscoveryUri && !status.classList.contains('error')) return;
        lastDiscoveryUri = uri;
        const sequence = ++discoverySequence;
        status.className = 'connection-status loading'; status.textContent = 'Connecting securely and finding databases…';
        databaseField.innerHTML = '<label>Database<select disabled><option>Checking database access…</option></select></label>';
        try {
            const result = await api('/api/sources/discover', { method: 'POST', body: { uri, authDatabase: form.elements.authDatabase.value } });
            if (sequence !== discoverySequence) return;
            form.elements.authDatabase.value = result.authDatabase || 'admin';
            renderDatabaseField(result.databases, result.database);
            status.className = `connection-status ${result.databases.length ? 'success' : 'manual'}`;
            status.textContent = result.databases.length
                ? `Connected · ${result.databases.length} database${result.databases.length === 1 ? '' : 's'} available`
                : 'Connected · enter the database name below';
        } catch (error) {
            if (sequence !== discoverySequence) return;
            renderDatabaseField();
            status.className = 'connection-status error'; status.textContent = error.message;
        }
    };
    form.elements.uri.oninput = () => {
        discoverySequence += 1;
        clearTimeout(discoveryTimer);
        discoveryTimer = setTimeout(discover, 650);
    };
    form.elements.uri.onchange = () => { clearTimeout(discoveryTimer); discover(); };
    form.onsubmit = async (event) => submitModal(event, '/api/sources', 'MongoDB source connected');
}

function destinationFields(type) {
    if (type === 'local') return `<label>Directory path<input name="path" value="/data/backups" required></label>`;
    if (type === 'firebase') return `<label>Bucket name<input name="bucket" placeholder="project-id.appspot.com" required></label><div class="field-grid"><label>Object prefix<input name="prefix" value="backups"></label><label>Storage price / GB-month<input name="costPerGbMonth" type="number" min="0" step="0.0001" placeholder="Optional"></label></div><label>Firebase service account JSON<textarea name="serviceAccount" required placeholder='{"type":"service_account", …}'></textarea></label>`;
    return `<div class="field-grid"><label>Bucket<input name="bucket" required></label><label>Region<input name="region" value="us-east-1" required></label></div><div class="field-grid"><label>Object prefix<input name="prefix" value="backups"></label><label>Storage price / GB-month<input name="costPerGbMonth" type="number" min="0" step="0.0001" placeholder="Optional"></label></div><label>Custom endpoint <small>Optional, for MinIO/R2/etc.</small><input name="endpoint" placeholder="https://s3.example.com"></label><div class="field-grid"><label>Access key ID<input name="accessKeyId" required autocomplete="off"></label><label>Secret access key<input type="password" name="secretAccessKey" required autocomplete="off"></label></div>`;
}

function openDestinationModal() {
    showModal(`<p class="eyebrow dark">NEW DESTINATION</p><h2>Add storage</h2><p>Cloud objects remain private. Spencer verifies access before saving credentials.</p><div class="choice-grid"><button class="choice-card active" data-destination-type="local"><b>Local disk</b><small>Mounted directory</small></button><button class="choice-card" data-destination-type="firebase"><b>Firebase</b><small>Google Cloud Storage</small></button><button class="choice-card" data-destination-type="s3"><b>S3</b><small>AWS or compatible</small></button></div><form id="destination-form"><input type="hidden" name="type" value="local"><label>Display name<input name="name" value="Local storage" required></label><div id="destination-fields">${destinationFields('local')}</div><div class="modal-actions"><button type="button" class="button secondary" data-close-modal>Cancel</button><button class="button primary" type="submit">Test and save</button></div></form>`);
    $('[data-close-modal]', $('#modal-content')).onclick = closeModal;
    $$('[data-destination-type]', $('#modal-content')).forEach((button) => button.onclick = () => {
        $$('[data-destination-type]', $('#modal-content')).forEach((item) => item.classList.toggle('active', item === button));
        $('#destination-form [name="type"]').value = button.dataset.destinationType;
        $('#destination-fields').innerHTML = destinationFields(button.dataset.destinationType);
        $('#destination-form [name="name"]').value = ({ local: 'Local storage', firebase: 'Firebase Storage', s3: 'Amazon S3' })[button.dataset.destinationType];
    });
    $('#destination-form').onsubmit = async (event) => {
        event.preventDefault();
        const values = Object.fromEntries(new FormData(event.currentTarget));
        const type = values.type;
        const body = { name: values.name, type, config: {}, secret: {} };
        if (type === 'local') body.config = { path: values.path };
        if (type === 'firebase') { body.config = { bucket: values.bucket, prefix: values.prefix, costPerGbMonth: Number(values.costPerGbMonth) || 0 }; body.secret = { serviceAccount: values.serviceAccount }; }
        if (type === 's3') { body.config = { bucket: values.bucket, region: values.region, prefix: values.prefix, endpoint: values.endpoint || undefined, forcePathStyle: Boolean(values.endpoint), costPerGbMonth: Number(values.costPerGbMonth) || 0 }; body.secret = { accessKeyId: values.accessKeyId, secretAccessKey: values.secretAccessKey }; }
        await submitModalRequest(event.currentTarget, '/api/destinations', body, 'Storage destination connected');
    };
}

function openRestoreTargetModal() {
    showModal(`<p class="eyebrow dark">RESTORE TARGET</p><h2>Add a recovery database</h2><p>Use an isolated MongoDB database for recovery drills. Spencer encrypts the connection URI and tests access before saving.</p><form id="target-form"><label>Display name<input name="name" required placeholder="Staging recovery database"></label><label>MongoDB connection URI<input name="uri" type="password" required placeholder="mongodb+srv://user:password@cluster…" autocomplete="off"></label><div class="field-grid"><label>Target database name<input name="database" required placeholder="application_recovery"></label><label>Authentication database<input name="authDatabase" value="admin" required><small>Usually admin for Atlas and root users</small></label></div><div class="modal-actions"><button type="button" class="button secondary" data-close-modal>Cancel</button><button class="button primary" type="submit">Test and save</button></div></form>`);
    $('[data-close-modal]', $('#modal-content')).onclick = closeModal;
    $('#target-form').onsubmit = async (event) => submitModal(event, '/api/restore-targets', 'Restore target connected');
}

function openRestoreModal(artifactId) {
    const artifact = state.artifacts.find((item) => item.id === artifactId);
    const targets = state.restoreTargets.filter((item) => item.enabled);
    if (!artifact) return toast('Recovery point not found.', 'error');
    if (!targets.length) return toast('Add and enable a restore target first.', 'error');
    showModal(`<p class="eyebrow dark">GUARDED RESTORE</p><h2>Restore recovery point</h2><p>Spencer will download and checksum the artifact before connecting to the target. This operation writes database data.</p><form id="restore-form"><input type="hidden" name="artifactId" value="${artifact.id}"><label>Recovery point<input value="${escapeHtml(artifact.name)} · ${formatBytes(artifact.size)}" disabled></label><label>Restore target<select name="targetId" id="restore-target-select">${targets.map((item) => `<option value="${item.id}" data-database="${escapeHtml(item.database)}">${escapeHtml(item.name)} · ${escapeHtml(item.database)}</option>`).join('')}</select></label><label class="checkbox-item"><input type="checkbox" name="dropExisting"><span>Drop matching collections before restore</span></label><label>Type <strong id="confirmation-database">${escapeHtml(targets[0].database)}</strong> to confirm<input name="confirmation" required autocomplete="off"></label><div class="form-error">Restores cannot be undone. Prefer an isolated recovery database.</div><div class="modal-actions"><button type="button" class="button secondary" data-close-modal>Cancel</button><button class="button danger" type="submit">Queue restore</button></div></form>`);
    $('[data-close-modal]', $('#modal-content')).onclick = closeModal;
    $('#restore-target-select').onchange = (event) => {
        $('#confirmation-database').textContent = event.target.selectedOptions[0].dataset.database;
    };
    $('#restore-form').onsubmit = async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        await submitModalRequest(event.currentTarget, '/api/restores', {
            artifactId: form.get('artifactId'), targetId: form.get('targetId'),
            dropExisting: form.get('dropExisting') === 'on', confirmation: form.get('confirmation')
        }, 'Restore queued');
    };
}

function openPolicyModal() {
    const sources = state.sources.filter((item) => item.enabled);
    const destinations = state.destinations.filter((item) => item.enabled);
    if (!sources.length || !destinations.length) return toast('Add and enable a source and destination first.', 'error');
    showModal(`<p class="eyebrow dark">NEW POLICY</p><h2>Schedule protection</h2><p>Use a five-field cron expression. The selected time zone is applied by the persistent scheduler.</p><form id="policy-form"><label>Policy name<input name="name" value="Daily backup" required></label><label>Source<select name="sourceId">${sources.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('')}</select></label><label>Destinations<div class="checkbox-list">${destinations.map((item) => `<label class="checkbox-item"><input type="checkbox" name="destinationIds" value="${item.id}" checked><span>${escapeHtml(item.name)} · ${escapeHtml(item.type)}</span></label>`).join('')}</div></label><div class="field-grid"><label>Cron schedule<input name="schedule" value="0 2 * * *" required><small>Daily at 02:00</small></label><label>Time zone<input name="timezone" value="Africa/Lagos" required></label></div><label>Retention days<input name="retentionDays" type="number" min="1" value="30"></label><div class="modal-actions"><button type="button" class="button secondary" data-close-modal>Cancel</button><button class="button primary" type="submit">Create policy</button></div></form>`);
    $('[data-close-modal]', $('#modal-content')).onclick = closeModal;
    $('#policy-form').onsubmit = async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const body = Object.fromEntries(form);
        body.destinationIds = form.getAll('destinationIds');
        body.retentionDays = Number(body.retentionDays);
        await submitModalRequest(event.currentTarget, '/api/policies', body, 'Backup policy created');
    };
}

function openRunModal() {
    const sources = state.sources.filter((item) => item.enabled);
    const destinations = state.destinations.filter((item) => item.enabled);
    if (!sources.length || !destinations.length) return toast('Add and enable a source and destination before running a backup.', 'error');
    showModal(`<p class="eyebrow dark">ON-DEMAND BACKUP</p><h2>Create a recovery point</h2><p>The job continues safely in the background if you close this page.</p><form id="run-form"><label>Source<select name="sourceId">${sources.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('')}</select></label><label>Destinations<div class="checkbox-list">${destinations.map((item) => `<label class="checkbox-item"><input type="checkbox" name="destinationIds" value="${item.id}" checked><span>${escapeHtml(item.name)} · ${escapeHtml(item.type)}</span></label>`).join('')}</div></label><div class="modal-actions"><button type="button" class="button secondary" data-close-modal>Cancel</button><button class="button primary" type="submit">Queue backup</button></div></form>`);
    $('[data-close-modal]', $('#modal-content')).onclick = closeModal;
    $('#run-form').onsubmit = async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        await submitModalRequest(event.currentTarget, '/api/jobs', { sourceId: form.get('sourceId'), destinationIds: form.getAll('destinationIds') }, 'Backup queued');
    };
}

async function submitModal(event, url, success) {
    event.preventDefault();
    await submitModalRequest(event.currentTarget, url, Object.fromEntries(new FormData(event.currentTarget)), success);
}

async function submitModalRequest(form, url, body, success) {
    const button = $('button[type="submit"]', form);
    const original = button.textContent;
    button.disabled = true; button.textContent = 'Working…';
    try {
        await api(url, { method: 'POST', body });
        closeModal(); toast(success); await navigate(state.page);
    } catch (error) { toast(error.message, 'error'); }
    finally { button.disabled = false; button.textContent = original; }
}

function connectEvents() {
    if (window.spencerEvents) window.spencerEvents.close();
    const source = new EventSource('/api/events');
    window.spencerEvents = source;
    source.addEventListener('job.updated', async (event) => {
        const payload = JSON.parse(event.data || '{}').payload || {};
        if (state.activeJobId === payload.id) await refreshJobDetails(payload.id);
        if (['overview', 'jobs', 'storage'].includes(state.page)) {
            await loadData(); render();
        }
    });
    source.addEventListener('job.log', async (event) => {
        const payload = JSON.parse(event.data || '{}').payload || {};
        if (state.activeJobId === payload.id) await refreshJobDetails(payload.id);
    });
    source.onerror = () => $('#live-indicator').classList.add('offline');
    source.onopen = () => $('#live-indicator').classList.remove('offline');
}

initialize().catch((error) => {
    document.body.innerHTML = `<main class="centered-view">${emptyState('!', 'Spencer could not start', escapeHtml(error.message))}</main>`;
});
