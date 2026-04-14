param(
    [string]$WorkspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"

function Get-FreeSpaceBytes {
    param([string]$TargetPath)
    $resolved = Resolve-Path $TargetPath
    $qualifier = [System.IO.Path]::GetPathRoot($resolved.Path).TrimEnd('\', ':')
    $drive = Get-PSDrive -Name $qualifier
    return [int64]$drive.Free
}

function Remove-PathContentsSafe {
    param([string]$TargetPath)

    if (-not (Test-Path $TargetPath)) {
        return 0
    }

    $removedCount = 0
    Get-ChildItem -Path $TargetPath -Force -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            Remove-Item -Path $_.FullName -Recurse -Force -ErrorAction Stop
            $removedCount++
        } catch {
            Write-Host "  - Skip (locked/denied): $($_.FullName)" -ForegroundColor Yellow
        }
    }

    return $removedCount
}

function Get-DisplayName {
    param([object]$Item)
    if ($null -eq $Item) { return "<unknown>" }
    if ($Item.PSObject.Properties.Name -contains "FullName" -and -not [string]::IsNullOrWhiteSpace($Item.FullName)) {
        return $Item.FullName
    }
    if ($Item.PSObject.Properties.Name -contains "Name" -and -not [string]::IsNullOrWhiteSpace($Item.Name)) {
        return $Item.Name
    }
    return "<unknown>"
}

Write-Host ""
Write-Host "Workspace cleanup started: $WorkspaceRoot" -ForegroundColor Cyan
$beforeFree = Get-FreeSpaceBytes -TargetPath $WorkspaceRoot

# 2) 이전 빌드 잔재 삭제
Write-Host ""
Write-Host "[2/5] Remove previous build artifacts" -ForegroundColor Green
$buildTargets = @(
    (Join-Path $WorkspaceRoot "02_client_app"),
    (Join-Path $WorkspaceRoot "04_license_admin")
)

$removedBuildDirs = 0
foreach ($base in $buildTargets) {
    if (-not (Test-Path $base)) { continue }

    Get-ChildItem -Path $base -Directory -Recurse -Force -ErrorAction SilentlyContinue | Where-Object {
        ($_.Name -like "dist*" -or $_.Name -in @("build", "out")) -and
        ($_.FullName -notlike "*\node_modules\*")
    } | Sort-Object FullName -Descending | ForEach-Object {
        try {
            Remove-Item -Path $_.FullName -Recurse -Force -ErrorAction Stop
            $removedBuildDirs++
            Write-Host "  - Removed: $($_.FullName)"
        } catch {
            Write-Host "  - Skip (locked/denied): $(Get-DisplayName -Item $_)" -ForegroundColor Yellow
        }
    }
}
Write-Host "  -> Build directories removed: $removedBuildDirs"

# 3) node_modules 내 불필요 캐시
Write-Host ""
Write-Host "[3/5] Remove node_modules cache and npm cache" -ForegroundColor Green
$removedNodeCacheDirs = 0
Get-ChildItem -Path $WorkspaceRoot -Directory -Recurse -Force -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -eq ".cache" -and $_.FullName -like "*node_modules*"
} | ForEach-Object {
    try {
        Remove-Item -Path $_.FullName -Recurse -Force -ErrorAction Stop
        $removedNodeCacheDirs++
        Write-Host "  - Removed: $($_.FullName)"
    } catch {
        Write-Host "  - Skip (locked/denied): $(Get-DisplayName -Item $_)" -ForegroundColor Yellow
    }
}
Write-Host "  -> node_modules/.cache removed: $removedNodeCacheDirs"

if (Get-Command npm -ErrorAction SilentlyContinue) {
    try {
        npm cache clean --force | Out-Null
        Write-Host "  -> npm global cache cleaned."
    } catch {
        Write-Host "  - npm cache clean failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# 4) Windows 임시파일
Write-Host ""
Write-Host "[4/5] Remove Windows temporary files" -ForegroundColor Green
$tempTargets = @($env:TEMP, "C:\Windows\Temp") | Select-Object -Unique
$removedTempItems = 0
foreach ($tempPath in $tempTargets) {
    if (-not [string]::IsNullOrWhiteSpace($tempPath)) {
        Write-Host "  - Cleaning: $tempPath"
        $removedTempItems += Remove-PathContentsSafe -TargetPath $tempPath
    }
}
Write-Host "  -> Temp entries removed: $removedTempItems"

# 5) 정리 후 디스크 재확인
Write-Host ""
Write-Host "[5/5] Re-check disk free space" -ForegroundColor Green
$afterFree = Get-FreeSpaceBytes -TargetPath $WorkspaceRoot
$reclaimedBytes = $afterFree - $beforeFree
$reclaimedGB = [Math]::Round(($reclaimedBytes / 1GB), 2)
$beforeGB = [Math]::Round(($beforeFree / 1GB), 2)
$afterGB = [Math]::Round(($afterFree / 1GB), 2)

Write-Host "  - Free space before: $beforeGB GB"
Write-Host "  - Free space after : $afterGB GB"
Write-Host "  - Reclaimed        : $reclaimedGB GB" -ForegroundColor Cyan
Write-Host ""
Write-Host "Cleanup completed."
