$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$env:PORT = "3001"
$envFile = Join-Path $PSScriptRoot "..\.env"
if (Test-Path $envFile) {
    # Let the old version's dotenv read the parent .env; the key is not printed.
    $env:DOTENV_CONFIG_PATH = $envFile
}

$tsx = Join-Path $PSScriptRoot "..\node_modules\.bin\tsx.cmd"
if (-not (Test-Path $tsx)) {
    Write-Host "Parent node_modules not found. Run npm install in the project root or in old_version."
    exit 1
}

Write-Host "Starting old version: http://localhost:3001"
& $tsx (Join-Path $PSScriptRoot "src\server.ts")
