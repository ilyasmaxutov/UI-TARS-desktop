#Requires -Version 7.4
[CmdletBinding()]
param([switch]$ResolveDependencies, [switch]$SkipWebBuild)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path $PSScriptRoot -Parent
function Invoke-Checked([string]$program, [string[]]$arguments) {
    & $program @arguments
    if ($LASTEXITCODE -ne 0) { throw "$program failed with exit code $LASTEXITCODE" }
}
if (-not $IsWindows) { throw 'This script builds on an actual Windows host only.' }
foreach ($tool in @('cargo','go','node')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "$tool is missing. No toolchain is installed automatically."
    }
}
Push-Location $root
try {
    Invoke-Checked 'node' @('scripts/verify-source.mjs')
    if (-not $SkipWebBuild) { Invoke-Checked 'npm' @('run','verify') }
    # Resolve both the pinned frontend entrypoint and every local UI surface before Cargo.
    Invoke-Checked 'node' @('scripts/verify-desktop-inputs.mjs')
    Push-Location 'native'
    try {
        if (-not (Test-Path 'Cargo.lock')) {
            if (-not $ResolveDependencies) { throw 'No Cargo.lock. Use -ResolveDependencies for an explicit first resolution; review and commit the result before a reproducible build.' }
            Invoke-Checked 'cargo' @('generate-lockfile')
        }
        Invoke-Checked 'cargo' @('test','--locked','-p','studio-core','-p','studio-host')
        Invoke-Checked 'cargo' @('build','--locked','--release','-p','studio-host','-p','studio-desktop')
    } finally { Pop-Location }
    # The packaged host resolves the helper next to itself. It must be built and shipped too.
    & (Join-Path $PSScriptRoot 'economy\Build-Economy.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'Economy helper build failed' }
    $out = Join-Path $root 'release\PlatformStudio'
    New-Item -ItemType Directory -Force $out | Out-Null
    foreach ($name in @('studio-host.exe','studio-desktop.exe')) {
        Copy-Item (Join-Path $root ('native\target\release\'+$name)) $out -Force
    }
    Copy-Item (Join-Path $root 'release\economy\studio-economy.exe') $out -Force
    Invoke-Checked (Join-Path $out 'studio-host.exe') @('--selftest')
    Invoke-Checked (Join-Path $out 'studio-economy.exe') @('selftest')
    Copy-Item 'README.md','docs\STATUS.md' $out -Force
    $version = (Get-Content 'package.json' -Raw | ConvertFrom-Json).version
    $files = foreach ($name in @('studio-desktop.exe','studio-host.exe','studio-economy.exe')) {
        $path = Join-Path $out $name
        [ordered]@{name=$name; bytes=(Get-Item $path).Length; sha256=(Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant()}
    }
    $sourceRevision = (& git rev-parse HEAD 2>$null)
    if ($LASTEXITCODE -ne 0) { $sourceRevision = $null }
    $manifest = [ordered]@{
        schema=1; version=$version; sourceRevision=$sourceRevision; target='windows-x64';
        os=[Environment]::OSVersion.VersionString; frontend='assistant.html'; files=@($files);
        cargoLockSha256=(Get-FileHash 'native\Cargo.lock' -Algorithm SHA256).Hash.ToLowerInvariant();
        claims=[ordered]@{compiled=$true; offlineSelfTestsPassed=$true; guiExecuted=$false; liveCodexTested=$false; containmentAccepted=$false; signed=$false}
    }
    $manifest | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $out 'DELIVERY.json') -Encoding utf8
    Invoke-Checked 'node' @('scripts/verify-delivery.mjs',$out)
    Write-Output "Unsigned desktop, host and helper compiled into $out. GUI and model were not launched."
} finally { Pop-Location }
