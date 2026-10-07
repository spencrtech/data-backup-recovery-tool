$ErrorActionPreference = "Stop"

$Image = if ($env:SPENCER_IMAGE) { $env:SPENCER_IMAGE } elseif ($env:DISPENSER_IMAGE) { $env:DISPENSER_IMAGE } else { "ghcr.io/spencertech/spencer-data-backup:latest" }
$Port = if ($env:SPENCER_PORT) { $env:SPENCER_PORT } elseif ($env:DISPENSER_PORT) { $env:DISPENSER_PORT } else { "7480" }
$Container = "spencer-data-backup"
$Volume = "spencer-data"

if (Get-Command docker -ErrorAction SilentlyContinue) {
    $Engine = "docker"
} elseif (Get-Command podman -ErrorAction SilentlyContinue) {
    $Engine = "podman"
} else {
    throw "Docker Desktop or Podman Desktop is required. Install one, then run this installer again."
}

$Existing = & $Engine ps -a --format "{{.Names}}"
if ($Existing -contains $Container) {
    throw "Spencer is already installed as container '$Container'. Remove or rename it before reinstalling."
}

Write-Host "Pulling $Image with $Engine..."
& $Engine pull $Image
& $Engine volume create $Volume | Out-Null
& $Engine run -d `
    --name $Container `
    --init `
    --restart unless-stopped `
    --security-opt no-new-privileges `
    -p "${Port}:7480" `
    -v "${Volume}:/data" `
    $Image | Out-Null

Write-Host "Waiting for Spencer to become ready..."
$Ready = $false
for ($Attempt = 0; $Attempt -lt 30; $Attempt++) {
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health/ready" -TimeoutSec 2 | Out-Null
        $Ready = $true
        break
    } catch {
        Start-Sleep -Seconds 1
    }
}
if (-not $Ready) {
    throw "Spencer did not become ready. Inspect it with: $Engine logs $Container"
}

Write-Host ""
Write-Host "Spencer Data Backup is ready." -ForegroundColor Green
Write-Host "Local:   http://localhost:$Port"
Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { -not $_.IPAddress.StartsWith("127.") -and $_.AddressState -eq "Preferred" } |
    ForEach-Object { Write-Host "Network: http://$($_.IPAddress):$Port" }
Write-Host "Data is stored in the '$Volume' container volume."
Write-Host "Open the URL to complete first-run setup."
