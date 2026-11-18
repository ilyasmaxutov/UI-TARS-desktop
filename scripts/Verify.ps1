#Requires -Version 7.4
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
    & npm run verify
    if ($LASTEXITCODE -ne 0) { throw 'Verification failed.' }
    Write-Output 'Only compilation and CLI tests were executed. No UI/server/provider was launched.'
} finally { Pop-Location }
