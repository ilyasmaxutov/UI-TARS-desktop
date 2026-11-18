#Requires -Version 7.4
# CLI tests and compile checks only. Does not install tools or launch the application.
[CmdletBinding()]
param([switch]$Offline)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $root 'verification\native-build'
New-Item -ItemType Directory -Path $out -Force | Out-Null
$report = [ordered]@{ release=(Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version; startedAt=[DateTimeOffset]::UtcNow.ToString('o'); status='blocked'; commands=@(); guiLaunched=$false; windowsIsolationAccepted=$false; gates=@{G1=$false;G2=$false;G3=$false} }
try {
    if (-not $IsWindows) { throw 'Native profile requires an actual Windows host. No emulator is substituted.' }
    $report.os = [System.Environment]::OSVersion.VersionString
    if (-not (Get-Command rustup -ErrorAction SilentlyContinue)) { throw 'rustup is missing; nothing will be installed automatically.' }
    $text = Get-Content (Join-Path $root 'native\rust-toolchain.toml') -Raw
    if ($text -notmatch 'channel\s*=\s*"([^"]+)"') { throw 'Cannot resolve the pinned toolchain.' }
    $channel = $Matches[1]
    # rustup run fails when the toolchain is absent; unlike rustup's proxy it does not auto-install.
    $available = & rustup toolchain list
    if ($LASTEXITCODE -ne 0 -or -not ($available | Where-Object { $_ -match ('^'+[regex]::Escape($channel)+'(-|\s|$)') })) { throw "Pinned Rust $channel is not installed. Review the pin and install separately." }
    if (-not (Test-Path (Join-Path $root 'native\Cargo.lock'))) { throw 'Audited Cargo.lock is absent. Dependency resolution and review are a separate step; tests are blocked.' }
    $report.toolchain = $channel
    $report.lockSha256 = (Get-FileHash (Join-Path $root 'native\Cargo.lock') -Algorithm SHA256).Hash
    $common = @('--locked'); if ($Offline) { $common += '--offline' }
    Push-Location (Join-Path $root 'native')
    try {
        foreach ($step in @(
            @{ Name='core-host-tests'; Arguments=@('test')+$common+@('-p','studio-core','-p','studio-host') },
            @{ Name='desktop-compile-check'; Arguments=@('check')+$common+@('-p','studio-desktop') }
        )) {
            $argsForCargo = @('run',$channel,'cargo') + $step.Arguments
            $lines = & rustup @argsForCargo 2>&1
            $exit = $LASTEXITCODE
            $lines | Set-Content (Join-Path $out ($step.Name+'.log')) -Encoding utf8
            $report.commands += @{name=$step.Name; exitCode=$exit; arguments=$argsForCargo}
            if ($exit -ne 0) { throw "$($step.Name) failed with exit code $exit. See saved log." }
        }
    } finally { Pop-Location }
    $report.status = 'cli-checks-passed-not-windows-acceptance'
} catch {
    $report.reason = $_.Exception.Message
    Write-Warning $report.reason
} finally {
    $report.finishedAt = [DateTimeOffset]::UtcNow.ToString('o')
    $report | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $out 'report.json') -Encoding utf8
}
if ($report.status -eq 'blocked') { exit 2 }
Write-Output "CLI evidence saved to $out. This does not pass K01-K15 or GUI acceptance."
