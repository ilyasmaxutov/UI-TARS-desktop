#Requires -Version 7.4
# One authorized publication, using Git's already configured authentication.
# Never requests tokens, launches a browser, touches main or uses force push.
[CmdletBinding()]
param([switch]$Publish)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
foreach ($tool in @('node','git')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "$tool is required by this developer command. Nothing has been installed or sent."
    }
}
$arguments = @((Join-Path $PSScriptRoot 'publish-github.mjs'))
if ($Publish) { $arguments += '--publish' }
& node @arguments
if ($LASTEXITCODE -ne 0) { throw 'Publication did not complete. The script never retries a push automatically.' }
