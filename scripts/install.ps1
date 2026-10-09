param(
    [ValidateSet("install", "update", "status", "logs", "export", "uninstall")]
    [string]$Command = "install",
    [string]$Output = "",
    [switch]$Purge
)

$ErrorActionPreference = "Stop"
$Image = if ($env:SPENCER_IMAGE) { $env:SPENCER_IMAGE } elseif ($env:DISPENSER_IMAGE) { $env:DISPENSER_IMAGE } else { "ghcr.io/spencrtech/spencer-data-backup:latest" }
$Port = if ($env:SPENCER_PORT) { $env:SPENCER_PORT } elseif ($env:DISPENSER_PORT) { $env:DISPENSER_PORT } else { "7480" }
$Bind = if ($env:SPENCER_BIND) { $env:SPENCER_BIND } else { "127.0.0.1" }
$Container = if ($env:SPENCER_CONTAINER) { $env:SPENCER_CONTAINER } else { "spencer-data-backup" }
$Volume = if ($env:SPENCER_DATA_VOLUME) { $env:SPENCER_DATA_VOLUME } else { "spencer-data" }

if (Get-Command docker -ErrorAction SilentlyContinue) {
    $Engine = "docker"
} elseif (Get-Command podman -ErrorAction SilentlyContinue) {
    $Engine = "podman"
} else {
    throw "Docker Desktop or Podman Desktop is required. Install one, then run this command again."
}

function Test-ContainerExists {
    $Names = & $Engine ps -a --format "{{.Names}}"
    return $Names -contains $Container
}

function Test-ContainerRunning {
    if (-not (Test-ContainerExists)) { return $false }
    return (& $Engine inspect $Container --format "{{.State.Running}}") -eq "true"
}

function Wait-SpencerReady {
    Write-Host "Waiting for Spencer to become ready..."
    for ($Attempt = 0; $Attempt -lt 45; $Attempt++) {
        try {
            Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health/ready" -TimeoutSec 2 | Out-Null
            return $true
        } catch {
            Start-Sleep -Seconds 1
        }
    }
    return $false
}

function Start-SpencerContainer([string]$ImageName) {
    & $Engine run -d `
        --name $Container `
        --init `
        --restart unless-stopped `
        --security-opt no-new-privileges `
        -p "${Bind}:${Port}:7480" `
        -v "${Volume}:/data" `
        $ImageName | Out-Null
}

function Get-SpencerImage {
    if ($env:SPENCER_SKIP_PULL -eq "1") {
        & $Engine image inspect $Image | Out-Null
    } else {
        & $Engine pull $Image
    }
}

function Show-SpencerUrls {
    Write-Host ""
    Write-Host "Spencer Data Backup is ready." -ForegroundColor Green
    Write-Host "Local:   http://localhost:$Port"
    if ($Bind -ne "127.0.0.1") {
        Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { -not $_.IPAddress.StartsWith("127.") -and $_.AddressState -eq "Preferred" } |
            ForEach-Object { Write-Host "Network: http://$($_.IPAddress):$Port" }
    }
    Write-Host "Data:    $Volume"
}

switch ($Command) {
    "install" {
        if (Test-ContainerExists) {
            if (-not (Test-ContainerRunning)) { & $Engine start $Container | Out-Null }
            if (-not (Wait-SpencerReady)) { throw "Spencer did not become ready. Run: $Engine logs $Container" }
            Show-SpencerUrls
            break
        }
        Write-Host "Pulling $Image with $Engine..."
        Get-SpencerImage
        & $Engine volume create $Volume | Out-Null
        Start-SpencerContainer $Image
        if (-not (Wait-SpencerReady)) { throw "Spencer did not become ready. Run: $Engine logs $Container" }
        Show-SpencerUrls
        Write-Host "Open the local URL to complete first-run setup."
    }
    "update" {
        if (-not (Test-ContainerExists)) { throw "Spencer is not installed. Run install first." }
        $PreviousImage = & $Engine inspect $Container --format "{{.Config.Image}}"
        $BindingJson = & $Engine inspect $Container --format '{{json (index .HostConfig.PortBindings "7480/tcp")}}'
        if ($BindingJson) {
            $Binding = $BindingJson | ConvertFrom-Json
            if (-not $env:SPENCER_PORT) { $Port = $Binding[0].HostPort }
            if (-not $env:SPENCER_BIND) { $Bind = if ($Binding[0].HostIp) { $Binding[0].HostIp } else { "0.0.0.0" } }
        }
        Get-SpencerImage
        & $Engine stop $Container | Out-Null
        & $Engine rm $Container | Out-Null
        Start-SpencerContainer $Image
        if (Wait-SpencerReady) {
            Write-Host "Spencer was updated successfully." -ForegroundColor Green
            Show-SpencerUrls
            break
        }
        Write-Warning "Update failed its readiness check; rolling back to $PreviousImage."
        & $Engine stop $Container 2>$null | Out-Null
        & $Engine rm $Container 2>$null | Out-Null
        Start-SpencerContainer $PreviousImage
        Wait-SpencerReady | Out-Null
        throw "Rollback completed. Run: $Engine logs $Container"
    }
    "status" {
        if (Test-ContainerExists) { & $Engine ps -a --filter "name=^${Container}$" } else { Write-Host "Spencer is not installed." }
    }
    "logs" {
        if (-not (Test-ContainerExists)) { throw "Spencer is not installed." }
        & $Engine logs --tail 200 -f $Container
    }
    "export" {
        if (-not (Test-ContainerExists)) { throw "Spencer is not installed." }
        if (-not $Output) { $Output = Join-Path (Get-Location) "spencer-data-$(Get-Date -Format 'yyyyMMdd-HHmmss').tar.gz" }
        $Output = [System.IO.Path]::GetFullPath($Output)
        $Helper = "${Container}-export"
        $ImageName = & $Engine inspect $Container --format "{{.Config.Image}}"
        $WasRunning = Test-ContainerRunning
        try {
            if ($WasRunning) { & $Engine stop $Container | Out-Null }
            & $Engine rm -f $Helper 2>$null | Out-Null
            & $Engine create --name $Helper -v "${Volume}:/data:ro" $ImageName sh -c "tar -czf /tmp/spencer-data.tar.gz -C /data ." | Out-Null
            & $Engine start -a $Helper | Out-Null
            & $Engine cp "${Helper}:/tmp/spencer-data.tar.gz" $Output
        } finally {
            & $Engine rm -f $Helper 2>$null | Out-Null
            if ($WasRunning -and -not (Test-ContainerRunning)) { & $Engine start $Container | Out-Null }
        }
        Write-Host "Spencer configuration and encryption key exported to: $Output" -ForegroundColor Green
        Write-Host "Keep this archive private."
    }
    "uninstall" {
        if (Test-ContainerExists) {
            & $Engine stop $Container 2>$null | Out-Null
            & $Engine rm $Container | Out-Null
        }
        if ($Purge) {
            & $Engine volume rm $Volume 2>$null | Out-Null
            Write-Host "Spencer and its data volume were removed permanently."
        } else {
            Write-Host "Spencer was removed. Its data remains in volume '$Volume'."
            Write-Host "Use -Purge only when you intentionally want to delete that data."
        }
    }
}
