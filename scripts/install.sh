#!/usr/bin/env sh
set -eu

COMMAND="${1:-install}"
ARGUMENT="${2:-}"
IMAGE="${SPENCER_IMAGE:-${DISPENSER_IMAGE:-ghcr.io/spencrtech/spencer-data-backup:latest}}"
PORT="${SPENCER_PORT:-${DISPENSER_PORT:-7480}}"
BIND="${SPENCER_BIND:-127.0.0.1}"
CONTAINER="${SPENCER_CONTAINER:-spencer-data-backup}"
VOLUME="${SPENCER_DATA_VOLUME:-spencer-data}"

if command -v docker >/dev/null 2>&1; then
    ENGINE=docker
elif command -v podman >/dev/null 2>&1; then
    ENGINE=podman
else
    echo "Docker or Podman is required. Install one, then run this command again." >&2
    exit 1
fi

container_exists() {
    "$ENGINE" ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"
}

container_running() {
    [ "$("$ENGINE" inspect "$CONTAINER" --format '{{.State.Running}}' 2>/dev/null || true)" = "true" ]
}

wait_until_ready() {
    echo "Waiting for Spencer to become ready..."
    attempt=0
    until curl -fsS "http://127.0.0.1:$PORT/health/ready" >/dev/null 2>&1; do
        attempt=$((attempt + 1))
        if [ "$attempt" -ge 45 ]; then return 1; fi
        sleep 1
    done
}

start_container() {
    image_name="$1"
    "$ENGINE" run -d \
        --name "$CONTAINER" \
        --init \
        --restart unless-stopped \
        --security-opt no-new-privileges \
        -p "$BIND:$PORT:7480" \
        -v "$VOLUME:/data" \
        "$image_name" >/dev/null
}

pull_image() {
    if [ "${SPENCER_SKIP_PULL:-0}" = "1" ]; then
        "$ENGINE" image inspect "$IMAGE" >/dev/null
    else
        "$ENGINE" pull "$IMAGE"
    fi
}

print_urls() {
    echo ""
    echo "Spencer Data Backup is ready."
    echo "Local:   http://localhost:$PORT"
    if [ "$BIND" != "127.0.0.1" ] && command -v hostname >/dev/null 2>&1; then
        for address in $(hostname -I 2>/dev/null || true); do
            echo "Network: http://$address:$PORT"
        done
    fi
    echo "Data:    $VOLUME"
}

install_spencer() {
    if container_exists; then
        if ! container_running; then "$ENGINE" start "$CONTAINER" >/dev/null; fi
        if ! wait_until_ready; then
            echo "Spencer did not become ready. Inspect it with: $ENGINE logs $CONTAINER" >&2
            exit 1
        fi
        echo "Spencer is already installed."
        print_urls
        return
    fi

    echo "Pulling $IMAGE with $ENGINE..."
    pull_image
    "$ENGINE" volume create "$VOLUME" >/dev/null
    start_container "$IMAGE"
    if ! wait_until_ready; then
        echo "Spencer did not become ready. Inspect it with: $ENGINE logs $CONTAINER" >&2
        exit 1
    fi
    print_urls
    echo "Open the local URL to complete first-run setup."
}

update_spencer() {
    if ! container_exists; then
        echo "Spencer is not installed. Run this script with 'install' first." >&2
        exit 1
    fi

    previous_image="$("$ENGINE" inspect "$CONTAINER" --format '{{.Config.Image}}')"
    published="$("$ENGINE" port "$CONTAINER" 7480/tcp 2>/dev/null | head -n 1 || true)"
    if [ -n "$published" ]; then
        [ -n "${SPENCER_PORT:-}" ] || PORT="${published##*:}"
        if [ -z "${SPENCER_BIND:-}" ]; then
            BIND="${published%:*}"
            [ "$BIND" = "[::]" ] && BIND="0.0.0.0"
        fi
    fi

    echo "Pulling $IMAGE..."
    pull_image
    "$ENGINE" stop "$CONTAINER" >/dev/null
    "$ENGINE" rm "$CONTAINER" >/dev/null
    start_container "$IMAGE"
    if wait_until_ready; then
        echo "Spencer was updated successfully."
        print_urls
        return
    fi

    echo "The update failed its readiness check; rolling back to $previous_image..." >&2
    "$ENGINE" stop "$CONTAINER" >/dev/null 2>&1 || true
    "$ENGINE" rm "$CONTAINER" >/dev/null 2>&1 || true
    start_container "$previous_image"
    wait_until_ready || true
    echo "Rollback completed. Inspect logs with: $ENGINE logs $CONTAINER" >&2
    exit 1
}

export_spencer() {
    if ! container_exists; then
        echo "Spencer is not installed." >&2
        exit 1
    fi
    output="${ARGUMENT:-spencer-data-$(date +%Y%m%d-%H%M%S).tar.gz}"
    export_dir="$(cd "$(dirname "$output")" && pwd)"
    output="$export_dir/$(basename "$output")"
    helper="${CONTAINER}-export"
    image_name="$("$ENGINE" inspect "$CONTAINER" --format '{{.Config.Image}}')"
    was_running=false
    cleanup_export() {
        "$ENGINE" rm -f "$helper" >/dev/null 2>&1 || true
        if [ "$was_running" = true ] && ! container_running; then "$ENGINE" start "$CONTAINER" >/dev/null 2>&1 || true; fi
    }
    trap cleanup_export 0 1 2 15
    if container_running; then
        was_running=true
        "$ENGINE" stop "$CONTAINER" >/dev/null
    fi
    "$ENGINE" rm -f "$helper" >/dev/null 2>&1 || true
    "$ENGINE" create --name "$helper" -v "$VOLUME:/data:ro" "$image_name" \
        sh -c 'tar -czf /tmp/spencer-data.tar.gz -C /data .' >/dev/null
    "$ENGINE" start -a "$helper" >/dev/null
    "$ENGINE" cp "$helper:/tmp/spencer-data.tar.gz" "$output"
    cleanup_export
    trap - 0 1 2 15
    echo "Spencer configuration and encryption key exported to: $output"
    echo "Keep this archive private; it contains the encrypted control-plane state and master key."
}

uninstall_spencer() {
    if container_exists; then
        "$ENGINE" stop "$CONTAINER" >/dev/null 2>&1 || true
        "$ENGINE" rm "$CONTAINER" >/dev/null
    fi
    if [ "$ARGUMENT" = "--purge" ]; then
        "$ENGINE" volume rm "$VOLUME" >/dev/null 2>&1 || true
        echo "Spencer and its data volume were removed permanently."
    else
        echo "Spencer was removed. Its data remains in volume '$VOLUME'."
        echo "Run uninstall --purge only when you intentionally want to delete that data."
    fi
}

case "$COMMAND" in
    install) install_spencer ;;
    update) update_spencer ;;
    status)
        if container_exists; then "$ENGINE" ps -a --filter "name=^${CONTAINER}$"; else echo "Spencer is not installed."; fi
        ;;
    logs)
        container_exists || { echo "Spencer is not installed." >&2; exit 1; }
        "$ENGINE" logs --tail 200 -f "$CONTAINER"
        ;;
    export) export_spencer ;;
    uninstall) uninstall_spencer ;;
    *)
        echo "Usage: spencer {install|update|status|logs|export [file]|uninstall [--purge]}" >&2
        exit 2
        ;;
esac
