#Requires -Version 7.4
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
if (-not (Get-Command go -ErrorAction SilentlyContinue)) { throw 'Go toolchain is needed for source build; end users use the included EXE. No installation attempted.' }
$oldProxy=$env:GOPROXY; $oldToolchain=$env:GOTOOLCHAIN; $oldCgo=$env:CGO_ENABLED; $oldOs=$env:GOOS; $oldArch=$env:GOARCH
Push-Location (Join-Path $root 'native\tools\economy')
try {
    $env:GOPROXY='off'; $env:GOTOOLCHAIN='local'; $env:CGO_ENABLED='0'
    & go test ./...
    if ($LASTEXITCODE -ne 0) { throw 'Local tests failed' }
    & go vet ./...
    if ($LASTEXITCODE -ne 0) { throw 'Vet failed' }
    $out=Join-Path $root 'release\economy'
    New-Item -ItemType Directory -Force $out | Out-Null
    $env:GOOS='windows'; $env:GOARCH='amd64'
    & go build -buildvcs=false -trimpath -ldflags='-s -w' -o (Join-Path $out 'studio-economy.exe') .
    if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
    Get-FileHash (Join-Path $out 'studio-economy.exe') -Algorithm SHA256
} finally {
    Pop-Location
    $env:GOPROXY=$oldProxy; $env:GOTOOLCHAIN=$oldToolchain; $env:CGO_ENABLED=$oldCgo; $env:GOOS=$oldOs; $env:GOARCH=$oldArch
}
