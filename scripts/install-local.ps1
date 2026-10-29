param(
    [string]$ToolsDir = ".audit-tools",
    [switch]$All,
    [switch]$Python,
    [switch]$Node,
    [switch]$Rust,
    [switch]$Solana,
    [switch]$Go,
    [switch]$Foundry
)

if (-not ($All -or $Python -or $Node -or $Rust -or $Solana -or $Go -or $Foundry)) {
    $All = $true
}

New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null
$ToolsPath = (Resolve-Path -LiteralPath $ToolsDir).Path
$PythonVenv = Join-Path $ToolsPath "python"
$VenvRoot = Join-Path $ToolsPath "venvs"
$NodePrefix = Join-Path $ToolsPath "node"
$CargoHome = Join-Path $ToolsPath "cargo"
$GoBin = Join-Path $ToolsPath "go/bin"
$FoundryDir = Join-Path $ToolsPath "foundry"

New-Item -ItemType Directory -Force -Path (Join-Path $ToolsPath "bin") | Out-Null
New-Item -ItemType Directory -Force -Path $VenvRoot | Out-Null
New-Item -ItemType Directory -Force -Path $NodePrefix | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $CargoHome "bin") | Out-Null
New-Item -ItemType Directory -Force -Path $GoBin | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $FoundryDir "bin") | Out-Null

$env:CARGO_HOME = $CargoHome
$env:GOBIN = $GoBin
$env:FOUNDRY_DIR = $FoundryDir
$env:npm_config_prefix = $NodePrefix
$env:PATH = "$(Join-Path $ToolsPath 'bin');$(Join-Path $PythonVenv 'Scripts');$(Join-Path $NodePrefix 'node_modules/.bin');$(Join-Path $CargoHome 'bin');$GoBin;$(Join-Path $FoundryDir 'bin');$env:PATH"

function Invoke-Optional {
    param(
        [string]$Name,
        [scriptblock]$Script
    )
    try {
        Write-Host "==> $Name"
        & $Script
    } catch {
        Write-Warning "$Name failed: $($_.Exception.Message)"
    }
}

function Install-PythonTool {
    param(
        [string]$Name,
        [string]$Package,
        [string]$Executable
    )
    $ToolName = $Name
    $PackageName = $Package
    $ExecutableName = $Executable
    Invoke-Optional "pip install $ToolName" {
        $Venv = Join-Path $VenvRoot $ToolName
        python -m venv $Venv
        $PythonExe = Join-Path $Venv "Scripts/python.exe"
        & $PythonExe -m pip install --upgrade pip wheel setuptools
        & $PythonExe -m pip install --upgrade $PackageName

        $ExePath = Join-Path $Venv "Scripts/$ExecutableName.exe"
        if (-not (Test-Path -LiteralPath $ExePath)) {
            $ExePath = Join-Path $Venv "Scripts/$ExecutableName"
        }
        if (-not (Test-Path -LiteralPath $ExePath)) {
            throw "Installed executable not found: $ExecutableName"
        }

        $Wrapper = Join-Path $ToolsPath "bin/$ExecutableName.cmd"
        $WrapperContent = "@echo off`r`n`"$ExePath`" %*`r`n"
        Set-Content -LiteralPath $Wrapper -Encoding ASCII -Value $WrapperContent
    }
}

if ($All -or $Python) {
    Install-PythonTool "slither" "slither-analyzer" "slither"
    Install-PythonTool "semgrep" "semgrep" "semgrep"
    Install-PythonTool "mythril" "mythril" "myth"
    Install-PythonTool "manticore" "manticore" "manticore"
    Install-PythonTool "wake" "eth-wake" "wake"
    Install-PythonTool "halmos" "halmos" "halmos"
    Install-PythonTool "certora" "certora-cli" "certoraRun"
    Install-PythonTool "solc-select" "solc-select" "solc-select"
}

if ($All -or $Node) {
    $NodePackages = @(
        "solhint",
        "eth-scribble",
        "@remix-project/remix-analyzer",
        "forta-agent"
    )
    foreach ($Package in $NodePackages) {
        Invoke-Optional "npm install $Package" {
            npm.cmd install --prefix $NodePrefix $Package
        }
    }
}

if ($All -or $Rust) {
    $RustPackages = @("aderyn", "heimdall-rs", "cargo-audit", "cargo-geiger")
    foreach ($Package in $RustPackages) {
        Invoke-Optional "cargo install $Package" {
            cargo install --root $CargoHome $Package
        }
    }
}

if ($All -or $Solana) {
    Invoke-Optional "cargo install trident" {
        cargo install --root $CargoHome trident-cli
    }
    Write-Host "Trident installed. Initialize per-project with: trident init"
}

if ($All -or $Go) {
    if ($env:OS -eq "Windows_NT") {
        Write-Warning "Skipping local Medusa on Windows; use the Docker medusa service instead."
    } else {
        Invoke-Optional "go install medusa" {
            go install github.com/crytic/medusa@latest
        }
    }
}

if ($All -or $Foundry) {
    Invoke-Optional "install Foundry" {
        Invoke-RestMethod https://foundry.paradigm.xyz | Invoke-Expression
        foundryup
    }
}

Write-Host ""
Write-Host "Project-local audit tools were installed under: $ToolsPath"
Write-Host "Activate them with: . $ToolsPath/env.ps1"
