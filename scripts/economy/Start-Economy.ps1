[CmdletBinding()]
param([string]$Project, [string]$Codex, [switch]$SelfTest)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$exe = Join-Path $PSScriptRoot 'studio-economy.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    $exe = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'release\economy\studio-economy.exe'
}
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'studio-economy.exe is missing. No download was attempted.' }
if ($SelfTest) { & $exe selftest; exit $LASTEXITCODE }
if (-not $Project) { $Project = Read-Host 'Project directory' }
if (-not (Test-Path -LiteralPath $Project -PathType Container)) { throw 'Project directory does not exist.' }
$argsList = @('launch', '--project', (Get-Item -LiteralPath $Project).FullName)
if ($Codex) { $argsList += @('--codex', $Codex) }
& $exe @argsList
exit $LASTEXITCODE
