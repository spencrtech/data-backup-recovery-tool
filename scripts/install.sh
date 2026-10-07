#!/usr/bin/env sh
set -eu

IMAGE="${SPENCER_IMAGE:-${DISPENSER_IMAGE:-ghcr.io/spencertech/spencer-data-backup:latest}}"
PORT="${SPENCER_PORT:-${DISPENSER_PORT:-7480}}"
CONTAINER="spencer-data-backup"
VOLUME="spencer-data"

if command -v docker >/dev/null 2>&1; then
    ENGINE=docker
elif command -v podman >/dev/null 2>&1; then
    ENGINE=podman
else
    echo "Docker or Podman is required. Install one, then run this installer again." >&2
    exit 1
fi

if "$ENGINE" ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    echo "Spencer is already installed as container '$CONTAINER'." >&2
    echo "Remove or rename that container before reinstalling." >&2
    exit 1
fi

echo "Pulling $IMAGE with $ENGINE..."
"$ENGINE" pull "$IMAGE"
"$ENGINE" volume create "$VOLUME" >/dev/null
"$ENGINE" run -d \
    --name "$CONTAINER" \
    --init \
    --restart unless-stopped \
    --security-opt no-new-privileges \
    -p "$PORT:7480" \
    -v "$VOLUME:/data" \
    "$IMAGE" >/dev/null

echo "Waiting for Spencer to become ready..."
attempt=0
until curl -fsS "http://127.0.0.1:$PORT/health/ready" >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 30 ]; then
        echo "Spencer did not become ready. Inspect it with: $ENGINE logs $CONTAINER" >&2
        exit 1
    fi
    sleep 1
done

echo ""
echo "Spencer Data Backup is ready."
echo "Local:   http://localhost:$PORT"
if command -v hostname >/dev/null 2>&1; then
    for address in $(hostname -I 2>/dev/null || true); do
        echo "Network: http://$address:$PORT"
    done
fi
echo "Data is stored in the '$VOLUME' container volume."
echo "Open the URL to complete first-run setup."
