# Spencer Data Backup

Spencer Data Backup is a self-hosted MongoDB backup control plane. Install it on a Linux server or Windows machine, finish setup in the browser, connect MongoDB sources, choose one or more storage destinations, and run or schedule verified backups.

## Current v2 capabilities

- Zero-config startup and browser-based first-run setup
- Embedded SQLite-compatible local database with no external control-plane dependency
- AES-256-GCM encryption for source and destination credentials
- Persistent administrator sessions, backup jobs, policies, artifacts, and audit events
- Optional authenticator-app MFA with encrypted enrollment secrets
- Role-aware sessions and an administrator-only audit log
- MongoDB source validation and database size metrics
- Local disk, private Firebase Storage, and S3-compatible destinations
- Manual and scheduled backups with time-zone aware cron policies
- Persistent background worker with restart recovery and live browser events
- SHA-256 checksums for every completed artifact
- Guarded restores to separately configured MongoDB recovery targets
- Provider-aware retention cleanup for local, Firebase, and S3 artifacts
- Pause/disable controls for sources, destinations, restore targets, and policies
- Local disk capacity and recorded backup storage metrics
- MongoDB logical data, allocated storage, index, and collection metrics
- Configurable per-destination storage-rate estimates
- Liveness and readiness endpoints
- Responsive operational dashboard

## Run locally

Requirements:

- Node.js 22+
- MongoDB Database Tools (`mongodump`) for actual backup jobs

```bash
npm ci
npm start
```

Open [http://localhost:7480](http://localhost:7480). On first launch, Spencer creates a machine-local `data/master.key` and `data/spencer.db`. Both must be protected and backed up together. Existing `dispenser.db` installations are migrated automatically.

Optional environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `7480` | HTTP port inside the process |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `./data` | SQLite database, encryption key, and work files |
| `BACKUP_DIR` | `$DATA_DIR/backups` | Default local backup directory |
| `MONGO_CONNECT_TIMEOUT_MS` | `15000` | MongoDB socket and TLS connection timeout |
| `MONGO_SERVER_SELECTION_TIMEOUT_MS` | `20000` | Total MongoDB cluster discovery timeout |

Database credentials, Firebase service accounts, S3 access keys, schedules, and application settings are configured in the UI—not environment variables.

## Docker Compose

```bash
docker compose up -d --build
```

Open `http://localhost:7480`. The named `spencer-data` volume contains all durable application state.

To expose a different host port:

```bash
SPENCER_PORT=8080 docker compose up -d
```

## Install Spencer

On Linux or macOS with Docker or Podman installed:

```bash
curl -fsSL https://github.com/spencrtech/data-backup-recovery-tool/releases/download/v2.0.0-beta.1/spencer | sh
```

On Windows with Docker Desktop or Podman Desktop installed, run in PowerShell:

```powershell
& ([scriptblock]::Create((irm 'https://github.com/spencrtech/data-backup-recovery-tool/releases/download/v2.0.0-beta.1/spencer.ps1'))) -Command install
```

The installer detects Docker or Podman, pulls the multi-architecture image, creates persistent storage, starts the service, waits for readiness, and prints the local URL. No repository clone or application configuration is required. New installations bind to `127.0.0.1` by default so they are not exposed to the local network or internet.

To install on a server that should accept network connections, explicitly choose a bind address and protect Spencer with a VPN or HTTPS reverse proxy:

```bash
curl -fsSL https://github.com/spencrtech/data-backup-recovery-tool/releases/download/v2.0.0-beta.1/spencer | SPENCER_BIND=0.0.0.0 sh
```

Do not expose port `7480` directly to the public internet.

## Manage an installation

Download the lifecycle command once:

```bash
curl -fsSL https://github.com/spencrtech/data-backup-recovery-tool/releases/download/v2.0.0-beta.1/spencer -o spencer
chmod +x spencer
```

Then use:

```bash
./spencer install
./spencer update
./spencer status
./spencer logs
./spencer export ./spencer-control-plane.tar.gz
./spencer uninstall
```

`update` preserves the existing port, bind address, and data volume, and automatically rolls back if the new container fails its readiness check. `export` briefly stops the service to create a consistent archive containing `spencer.db`, `master.key`, and related control-plane state. Store that archive securely. `uninstall` keeps the data volume by default; `uninstall --purge` permanently removes it.

On Windows, save `spencer.ps1` from the release and use `-Command update`, `-Command status`, `-Command logs`, `-Command export -Output <path>`, or `-Command uninstall`. Add `-Purge` only when the stored Spencer data should be permanently removed.

## Storage destinations

### Local disk

Enter a path visible inside the container. For a host directory, mount it into the container and select the mounted container path in Spencer.

### Firebase Storage

Provide the bucket name, optional prefix, and service-account JSON in the destination form. The credential is encrypted locally. Backup objects remain private; Spencer does not call `makePublic()`.

### S3-compatible storage

Provide the bucket, region, prefix, and credentials. An optional endpoint enables services such as MinIO, Cloudflare R2, and other S3-compatible providers.

## Recovery

Restore targets are configured separately from backup sources so production credentials are not implicitly treated as recovery destinations. A restore:

1. Downloads the selected artifact from local, Firebase, or S3 storage.
2. Recalculates and verifies its SHA-256 checksum.
3. Requires the operator to type the target database name exactly.
4. Restores namespaces into the configured target database.
5. Drops matching target collections only when the operator explicitly selects that option.

Scheduled destructive restores are intentionally unsupported.

## Retention

Scheduled policies apply their retention period after a successful new backup. Expired objects are removed from the configured provider and then removed from Spencer's artifact index. A failed backup never triggers retention cleanup.

## Health endpoints

- `GET /health/live` — process liveness
- `GET /health/ready` — data-directory readiness and first-run state

## Security model

- The machine-local master key is generated with mode `0600`.
- Secrets are encrypted before they enter the local database.
- API responses never include encrypted payloads, database URIs, or access keys.
- Mutating authenticated API calls require a same-origin verification header.
- Session cookies are HTTP-only and `SameSite=Strict`.
- Cloud backup objects are private.
- The production container runs as a non-root user with `no-new-privileges`.
- `.dockerignore` excludes local data, configuration secrets, Git history, and legacy files.

If the legacy repository previously contained live `.env`, `databases.json`, or Firebase service-account credentials, rotate them. Removing the files in a later commit does not invalidate secrets already present in Git history.

## Verification

```bash
npm test -- --test-concurrency=1
npm audit --audit-level=moderate
docker compose config
```

The container workflow builds and publishes Linux `amd64` and `arm64` images to GitHub Container Registry on `main` and version tags. Version tags also create a GitHub release containing the Linux/macOS lifecycle script, Windows PowerShell script, generated release notes, and SHA-256 checksums.

## Next milestones

- Alerting integrations and notification policies
- Multi-user management and fine-grained role-based access control
- Provider billing APIs and monthly cost forecasting
- Signed backup downloads and disaster-recovery export
- Native desktop installers that do not require Docker or Podman
