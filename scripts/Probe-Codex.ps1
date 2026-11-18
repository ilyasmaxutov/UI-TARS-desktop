#Requires -Version 7.4
# Development/CI only. Does not install Codex, run a model, or modify its owner profile.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$CodexExe,
    [string]$OutDirectory = (Join-Path (Split-Path $PSScriptRoot -Parent) 'verification\codex-protocol'),
    [string]$ExpectedVersion
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node is required only to run this development/CI probe. Nothing is installed automatically.' }
$resolved = (Resolve-Path -LiteralPath $CodexExe).Path
if ($IsWindows -and [IO.Path]::GetExtension($resolved) -ine '.exe') { throw 'Select the native codex.exe, not a CMD/PowerShell shim.' }
$arguments = @((Join-Path $PSScriptRoot 'probe-codex.mjs'), '--codex', $resolved, '--out', $OutDirectory)
if ($ExpectedVersion) { $arguments += @('--expect-version', $ExpectedVersion) }
& node @arguments
exit $LASTEXITCODE
