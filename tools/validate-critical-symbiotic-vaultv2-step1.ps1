param(
    [ValidateSet("Capture", "Parse", "Validate")]
    [string]$Mode = "Validate"
)

$ErrorActionPreference = "Stop"
$workspace = Split-Path -Parent $PSScriptRoot
$target = Join-Path $workspace "targets\symbiotic-core-83a3a9ab"
$rawDir = Join-Path $workspace "reports\raw\fast\critical-symbiotic-vaultv2-withdrawalqueue-step1"
$report = Join-Path $workspace "reports\critical-symbiotic-vaultv2-withdrawalqueue-step1.md"
$inbox = Join-Path $workspace "coordination\inbox\critical\2026-07-31-critical-symbiotic-vaultv2-step1.json"
$handoff = Join-Path $workspace "coordination\handoffs\2026-07-31-critical-symbiotic-vaultv2-step1-stage3.md"
$seed = "0x53594d42494f544943"
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-Utf8([string]$Path, [string]$Content) {
    [System.IO.File]::WriteAllText($Path, $Content, $utf8)
}

function Get-Sha256([string]$Path) {
    return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Get-Text([string]$Name, [string]$Stream = "stdout") {
    return [System.IO.File]::ReadAllText((Join-Path $rawDir ("{0}.{1}.txt" -f $Name, $Stream)))
}

function Get-RegexInt([string]$Text, [string]$Pattern) {
    $match = [regex]::Match($Text, $Pattern, [System.Text.RegularExpressions.RegexOptions]::Multiline)
    if (-not $match.Success) { throw "Missing pattern: $Pattern" }
    return [int64]$match.Groups[1].Value
}

function Get-LogInt([string]$Text, [string]$Label) {
    $escaped = [regex]::Escape($Label)
    $match = [regex]::Match($Text, "(?m)^\s*$escaped`:\s*(-?\d+)\s*$")
    if (-not $match.Success) { throw "Missing log commitment: $Label" }
    return [int64]$match.Groups[1].Value
}

function Get-PassNames([string]$Text) {
    return @([regex]::Matches($Text, '(?m)^\[PASS\]\s+([A-Za-z0-9_]+)\(') | ForEach-Object { $_.Groups[1].Value })
}

function Get-InvariantRows([string]$Text) {
    $rows = @()
    foreach ($match in [regex]::Matches($Text, '(?m)^\[PASS\]\s+(invariant_[A-Za-z0-9_]+)\(\)\s+\(runs:\s*(\d+),\s*calls:\s*(\d+),\s*reverts:\s*(\d+)\)')) {
        $rows += [ordered]@{ name = $match.Groups[1].Value; runs = [int64]$match.Groups[2].Value; calls = [int64]$match.Groups[3].Value; reverts = [int64]$match.Groups[4].Value }
    }
    return $rows
}

function Get-FuzzRows([string]$Text) {
    $rows = @()
    foreach ($match in [regex]::Matches($Text, '(?m)^\[PASS\]\s+(testFuzz_[A-Za-z0-9_]+)\([^\r\n]*\)\s+\(runs:\s*(\d+),')) {
        $rows += [ordered]@{ name = $match.Groups[1].Value; runs = [int64]$match.Groups[2].Value }
    }
    return $rows
}

function Get-SourceTestNames([string]$RelativePath) {
    $text = [System.IO.File]::ReadAllText((Join-Path $target $RelativePath))
    return @([regex]::Matches($text, 'function\s+((?:test|invariant_)[A-Za-z0-9_]+)\s*\(') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
}

function Test-SameNames([object[]]$Left, [object[]]$Right) {
    $a = @(($Left | Sort-Object) -join "`n")
    $b = @(($Right | Sort-Object) -join "`n")
    return $a[0] -eq $b[0]
}

function Quote-Argument([string]$Value) {
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Invoke-Captured(
    [string]$Name,
    [string]$Executable,
    [string[]]$Arguments,
    [string]$WorkingDirectory,
    [hashtable]$Environment = @{}
) {
    $resolved = (Get-Command $Executable -ErrorAction Stop).Source
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $resolved
    $psi.Arguments = (($Arguments | ForEach-Object { Quote-Argument $_ }) -join " ")
    $psi.WorkingDirectory = $WorkingDirectory
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    foreach ($key in $Environment.Keys) { $psi.EnvironmentVariables[$key] = [string]$Environment[$key] }
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $psi
    [void]$process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $stdout = $stdoutTask.Result
    $stderr = $stderrTask.Result
    $stdoutPath = Join-Path $rawDir "$Name.stdout.txt"
    $stderrPath = Join-Path $rawDir "$Name.stderr.txt"
    Write-Utf8 $stdoutPath $stdout
    Write-Utf8 $stderrPath $stderr
    $record = [ordered]@{
        name = $Name
        executable = [System.IO.Path]::GetFileName($resolved)
        arguments = $Arguments
        workingDirectory = "targets/symbiotic-core-83a3a9ab"
        environment = $Environment
        exitCode = $process.ExitCode
        stdout = [ordered]@{ path = "reports/raw/fast/critical-symbiotic-vaultv2-withdrawalqueue-step1/$Name.stdout.txt"; sha256 = Get-Sha256 $stdoutPath; bytes = (Get-Item $stdoutPath).Length }
        stderr = [ordered]@{ path = "reports/raw/fast/critical-symbiotic-vaultv2-withdrawalqueue-step1/$Name.stderr.txt"; sha256 = Get-Sha256 $stderrPath; bytes = (Get-Item $stderrPath).Length }
    }
    if ($process.ExitCode -ne 0) { throw "$Name failed with exit code $($process.ExitCode)" }
    return $record
}

function New-SourceManifest {
    $cachePath = Join-Path $target "cache\solidity-files-cache.json"
    $cache = [System.IO.File]::ReadAllText($cachePath) | ConvertFrom-Json
    $properties = @($cache.files.PSObject.Properties | Where-Object { $_.Value.seenByCompiler -eq $true } | Sort-Object Name)
    $entries = @()
    foreach ($property in $properties) {
        $relative = ($property.Name -replace '\\', '/')
        $full = Join-Path $target $property.Name
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "Manifest source missing: $relative" }
        $entries += [ordered]@{
            path = $relative
            sha256 = Get-Sha256 $full
            compilerSeen = $true
            namespacedStageTest = $relative.StartsWith("test/critical-symbiotic-vaultv2-step1/")
        }
    }
    $head = (Get-Text "git-head").Trim()
    $submodules = @((Get-Text "git-submodules") -split "`r?`n" | Where-Object { $_.Trim().Length -gt 0 })
    $foundryPath = Join-Path $target "foundry.toml"
    $foundryText = [System.IO.File]::ReadAllText($foundryPath)
    $manifest = [ordered]@{
        schema = "symbiotic-vaultv2-step1-source-closure-v1"
        generatedAt = [DateTime]::UtcNow.ToString("o")
        checkout = [ordered]@{ path = "targets/symbiotic-core-83a3a9ab"; commit = $head; recursiveSubmodules = $submodules }
        compiler = [ordered]@{
            forgeVersionSha256 = (Get-Sha256 (Join-Path $rawDir "forge-version.stdout.txt"))
            solc = ([regex]::Match($foundryText, 'solc\s*=\s*"([^"]+)"')).Groups[1].Value
            evmVersion = ([regex]::Match($foundryText, 'evm_version\s*=\s*"([^"]+)"')).Groups[1].Value
            optimizer = $foundryText -match 'optimizer\s*=\s*true'
            optimizerRuns = [int]([regex]::Match($foundryText, 'optimizer_runs\s*=\s*(\d+)')).Groups[1].Value
            viaIR = $foundryText -match 'via_ir\s*=\s*true'
            bytecodeHash = ([regex]::Match($foundryText, 'bytecode_hash\s*=\s*"([^"]+)"')).Groups[1].Value
            foundryTomlSha256 = Get-Sha256 $foundryPath
        }
        build = [ordered]@{ compilerSeenFiles = $entries.Count; originalClosureFiles = @($entries | Where-Object { -not $_.namespacedStageTest }).Count; namespacedStageFiles = @($entries | Where-Object { $_.namespacedStageTest }).Count }
        entries = $entries
    }
    $manifestPath = Join-Path $rawDir "source-closure-manifest.json"
    Write-Utf8 $manifestPath (($manifest | ConvertTo-Json -Depth 8) + "`n")
    return $manifest
}

function Parse-Results {
    $queue = Get-Text "focused-queue"
    $donation = Get-Text "focused-donation"
    $stateful = Get-Text "focused-stateful"
    $upstreamUnits = Get-Text "upstream-queue-units"
    $upstreamClaim = Get-Text "upstream-claim"
    $upstreamPending = Get-Text "upstream-pending"
    $build = Get-Text "build"
    $queueNames = Get-PassNames $queue
    $donationNames = Get-PassNames $donation
    $statefulNames = Get-PassNames $stateful
    $donationFuzzRows = @(Get-FuzzRows $donation)
    $statefulInvariantRows = @(Get-InvariantRows $stateful)
    $claimInvariantRows = @(Get-InvariantRows $upstreamClaim)
    $pendingInvariantRows = @(Get-InvariantRows $upstreamPending)
    $donationFuzzCases = 0
    foreach ($row in $donationFuzzRows) { $donationFuzzCases += [int64]$row["runs"] }
    $statefulCallsTotal = 0
    foreach ($row in $statefulInvariantRows) { $statefulCallsTotal += [int64]$row["calls"] }
    $claimCallsTotal = 0
    foreach ($row in $claimInvariantRows) { $claimCallsTotal += [int64]$row["calls"] }
    $pendingCallsTotal = 0
    foreach ($row in $pendingInvariantRows) { $pendingCallsTotal += [int64]$row["calls"] }
    $queueFixedNames = @($queueNames | Where-Object { -not $_.StartsWith("testFuzz_") -and -not $_.StartsWith("invariant_") })
    $donationFixedNames = @($donationNames | Where-Object { -not $_.StartsWith("testFuzz_") -and -not $_.StartsWith("invariant_") })
    $statefulFixedNames = @($statefulNames | Where-Object { -not $_.StartsWith("testFuzz_") -and -not $_.StartsWith("invariant_") })
    $counterLabels = @("deposit", "mint", "shareTransfer", "donate", "request", "fill", "nftTransfer", "claim", "accrue", "warp")
    $counters = [ordered]@{}
    foreach ($label in $counterLabels) {
        $counters[$label] = [ordered]@{
            attempts = Get-RegexInt $stateful ("{0}\.attempts:\s+(\d+)" -f $label)
            successes = Get-RegexInt $stateful ("{0}\.successes:\s+(\d+)" -f $label)
            reverts = Get-RegexInt $stateful ("{0}\.reverts:\s+(\d+)" -f $label)
            skips = Get-RegexInt $stateful ("{0}\.skips:\s+(\d+)" -f $label)
        }
    }
    $candidate = [ordered]@{
        attackerSeed = Get-LogInt $queue "candidate.seed"
        donation = Get-LogInt $queue "candidate.donation"
        victimDepositEach = Get-LogInt $queue "candidate.victimDepositEach"
        victimCount = Get-LogInt $queue "candidate.victimCount"
        victimSharesTotal = Get-LogInt $queue "candidate.victimSharesTotal"
        chargedInputs = Get-LogInt $queue "candidate.chargedInputs"
        payout = Get-LogInt $queue "candidate.payout"
        attackerNet = Get-LogInt $queue "candidate.net"
        residual = Get-LogInt $queue "candidate.residual"
        baselineNet = Get-LogInt $queue "candidate.baselineNet"
    }
    $feeCounterexample = [ordered]@{
        attackerSeed = Get-LogInt $donation "feeCounter.seed"
        virtualShares = Get-LogInt $donation "feeCounter.virtualShares"
        victimAssets = Get-LogInt $donation "feeCounter.victimAssets"
        donation = Get-LogInt $donation "feeCounter.donation"
        performanceFee = Get-LogInt $donation "feeCounter.performanceFee"
        pendingFeeAssets = Get-LogInt $donation "feeCounter.pendingFeeAssets"
        pendingFeeShares = Get-LogInt $donation "feeCounter.pendingFeeShares"
        feeFreeVictimShares = Get-LogInt $donation "feeCounter.feeFreeVictimShares"
        productionVictimShares = Get-LogInt $donation "feeCounter.productionVictimShares"
    }
    $manifest = [System.IO.File]::ReadAllText((Join-Path $rawDir "source-closure-manifest.json")) | ConvertFrom-Json
    return [ordered]@{
        schema = "symbiotic-vaultv2-step1-results-v1"
        generatedAt = [DateTime]::UtcNow.ToString("o")
        seed = $seed
        classification = "CONDITIONAL_MEDIUM_SOURCE_LOCAL_ROUTE_POSITIVE_DEPLOYMENT_ECONOMICS_UNBOUND"
        gates = [ordered]@{ sourcePrimitive = 1; localRoutePositive = 1; operationalRoutePositive = 0; executableNow = 0; signedActionJustified = $false; fork = $false }
        focused = [ordered]@{
            fixedTests = $queueFixedNames.Count + $donationFixedNames.Count + $statefulFixedNames.Count
            fixedTestNames = @($queueFixedNames + $donationFixedNames + $statefulFixedNames)
            queue = [ordered]@{ suiteTotal = Get-RegexInt $queue 'Ran (\d+) tests for'; passNames = $queueNames }
            donation = [ordered]@{ suiteTotal = Get-RegexInt $donation 'Ran (\d+) tests for'; passNames = $donationNames; fuzzRows = $donationFuzzRows }
            fuzzFunctions = $donationFuzzRows.Count
            fuzzCases = $donationFuzzCases
            stateful = [ordered]@{ suiteTotal = Get-RegexInt $stateful 'Ran (\d+) tests for'; passNames = $statefulNames; invariantRows = $statefulInvariantRows }
            statefulInvariantFunctions = $statefulInvariantRows.Count
            statefulCallsTotal = $statefulCallsTotal
            deterministicCounters = $counters
            rollbackAssertions = Get-RegexInt $stateful 'rollbackAssertions:\s+(\d+)'
        }
        upstream = [ordered]@{
            queue = [ordered]@{ suiteTotal = Get-RegexInt $upstreamUnits 'Ran (\d+) tests for'; passNames = Get-PassNames $upstreamUnits }
            claim = [ordered]@{ suiteTotal = Get-RegexInt $upstreamClaim 'Ran (\d+) tests for'; passNames = Get-PassNames $upstreamClaim; invariantRows = $claimInvariantRows; invariantCallsTotal = $claimCallsTotal }
            pending = [ordered]@{ suiteTotal = Get-RegexInt $upstreamPending 'Ran (\d+) tests for'; passNames = Get-PassNames $upstreamPending; invariantRows = $pendingInvariantRows; invariantCallsTotal = $pendingCallsTotal }
        }
        build = [ordered]@{ compiledFiles = Get-RegexInt $build 'Compiling\s+(\d+) files'; originalClosureFiles = $manifest.build.originalClosureFiles; namespacedFiles = $manifest.build.namespacedStageFiles }
        candidate = $candidate
        feeCounterexample = $feeCounterexample
        network = [ordered]@{ rpc = $false; fork = $false; signedTransactions = $false; deploymentQueries = $false }
    }
}

if ($Mode -eq "Capture") {
    if (-not (Test-Path -LiteralPath (Split-Path -Parent $rawDir) -PathType Container)) { throw "Raw parent missing" }
    if (-not (Test-Path -LiteralPath $rawDir)) { [void][System.IO.Directory]::CreateDirectory($rawDir) }
    $commands = @()
    $commands += Invoke-Captured "forge-version" "forge" @("--version") $target
    $commands += Invoke-Captured "git-head" "git" @("rev-parse", "HEAD") $target
    $commands += Invoke-Captured "git-submodules" "git" @("submodule", "status", "--recursive") $target
    $commands += Invoke-Captured "focused-queue" "forge" @("test", "--offline", "--match-path", "test/critical-symbiotic-vaultv2-step1/VaultV2WithdrawalQueueStep1.t.sol", "--fuzz-seed", $seed, "--no-cache", "-vv") $target
    $commands += Invoke-Captured "focused-donation" "forge" @("test", "--offline", "--match-path", "test/critical-symbiotic-vaultv2-step1/VaultV2DonationCharacterization.t.sol", "--fuzz-seed", $seed, "--fuzz-runs", "512", "--no-cache", "-vv") $target
    $commands += Invoke-Captured "focused-stateful" "forge" @("test", "--offline", "--match-path", "test/critical-symbiotic-vaultv2-step1/VaultV2QueueStatefulInvariants.t.sol", "--fuzz-seed", $seed, "--no-cache", "-vv") $target @{ FOUNDRY_INVARIANT_RUNS = "128"; FOUNDRY_INVARIANT_DEPTH = "256" }
    $commands += Invoke-Captured "upstream-queue-units" "forge" @("test", "--offline", "--match-path", "test/vault/WithdrawalQueueFill.t.sol", "--fuzz-seed", $seed, "--no-cache", "-vv") $target
    $commands += Invoke-Captured "upstream-claim" "forge" @("test", "--offline", "--match-path", "test/invariant/WithdrawalQueueClaimInvariants.t.sol", "--fuzz-seed", $seed, "--no-cache", "-vv") $target @{ FOUNDRY_INVARIANT_RUNS = "64"; FOUNDRY_INVARIANT_DEPTH = "128" }
    $commands += Invoke-Captured "upstream-pending" "forge" @("test", "--offline", "--match-path", "test/invariant/PendingWithdrawalQueueInvariants.t.sol", "--fuzz-seed", $seed, "--no-cache", "-vv") $target @{ FOUNDRY_INVARIANT_RUNS = "32"; FOUNDRY_INVARIANT_DEPTH = "128" }
    $commands += Invoke-Captured "build" "forge" @("build", "--offline", "--force") $target
    $testFiles = @(
        "test/critical-symbiotic-vaultv2-step1/VaultV2WithdrawalQueueStep1Harness.sol",
        "test/critical-symbiotic-vaultv2-step1/VaultV2WithdrawalQueueStep1.t.sol",
        "test/critical-symbiotic-vaultv2-step1/VaultV2DonationCharacterization.t.sol",
        "test/critical-symbiotic-vaultv2-step1/VaultV2QueueStatefulHandler.sol",
        "test/critical-symbiotic-vaultv2-step1/VaultV2QueueStatefulInvariants.t.sol"
    )
    $commands += Invoke-Captured "format" "forge" (@("fmt", "--check") + $testFiles) $target
    $commands += Invoke-Captured "production-diff" "git" @("diff", "--", "src", "test/vault", "test/invariant") $target
    $commands += Invoke-Captured "status" "git" @("status", "--short") $target
    Write-Utf8 (Join-Path $rawDir "commands.json") (([ordered]@{ schema = "symbiotic-vaultv2-step1-commands-v1"; generatedAt = [DateTime]::UtcNow.ToString("o"); records = $commands } | ConvertTo-Json -Depth 8) + "`n")
    [void](New-SourceManifest)
    $results = Parse-Results
    Write-Utf8 (Join-Path $rawDir "results.json") (($results | ConvertTo-Json -Depth 10) + "`n")
    $results | ConvertTo-Json -Depth 10
    exit 0
}

if ($Mode -eq "Parse") {
    [void](New-SourceManifest)
    $results = Parse-Results
    Write-Utf8 (Join-Path $rawDir "results.json") (($results | ConvertTo-Json -Depth 10) + "`n")
    $results | ConvertTo-Json -Depth 10
    exit 0
}

$checks = New-Object System.Collections.Generic.List[object]
$failures = New-Object System.Collections.Generic.List[string]
function Add-Check([string]$Name, [bool]$Passed, [string]$Detail) {
    $checks.Add([ordered]@{ name = $Name; passed = $Passed; detail = $Detail })
    if (-not $Passed) { $failures.Add("$Name`: $Detail") }
}

$results = Parse-Results
$commandsPath = Join-Path $rawDir "commands.json"
$commandDocument = [System.IO.File]::ReadAllText($commandsPath) | ConvertFrom-Json
$requiredCommandNames = @("forge-version", "git-head", "git-submodules", "focused-queue", "focused-donation", "focused-stateful", "upstream-queue-units", "upstream-claim", "upstream-pending", "build", "format", "production-diff", "status")
$actualCommandNames = @($commandDocument.records | ForEach-Object { $_.name })
Add-Check "command-name-set" (Test-SameNames $requiredCommandNames $actualCommandNames) (($actualCommandNames | Sort-Object) -join ",")
foreach ($record in $commandDocument.records) {
    Add-Check "command-exit:$($record.name)" ($record.exitCode -eq 0) ([string]$record.exitCode)
    foreach ($streamName in @("stdout", "stderr")) {
        $stream = $record.$streamName
        $full = Join-Path $workspace ($stream.path -replace '/', '\')
        $valid = (Test-Path -LiteralPath $full -PathType Leaf) -and (Get-Sha256 $full) -eq $stream.sha256 -and (Get-Item $full).Length -eq $stream.bytes
        Add-Check "command-$streamName`:$($record.name)" $valid "$($stream.sha256):$($stream.bytes)"
    }
    $args = @($record.arguments)
    $isForgeTestOrBuild = $record.executable -like "forge*" -and $args.Count -gt 0 -and $args[0] -in @("test", "build")
    if ($isForgeTestOrBuild) {
        Add-Check "command-offline:$($record.name)" ($args -contains "--offline") ($args -join " ")
        if ($args[0] -eq "test") { Add-Check "command-no-cache:$($record.name)" ($args -contains "--no-cache") ($args -join " ") }
        if ($args[0] -eq "build") { Add-Check "command-force:$($record.name)" ($args -contains "--force") ($args -join " ") }
    }
    $forbiddenFlag = @($args | Where-Object { $_ -match '(?i)(fork|rpc|broadcast|etherscan|endpoint|private-key)' })
    Add-Check "command-no-network-flag:$($record.name)" ($forbiddenFlag.Count -eq 0) ($forbiddenFlag -join ",")
    foreach ($property in $record.environment.PSObject.Properties) {
        $entry = "$($property.Name)=$($property.Value)"
        Add-Check "command-env:$($record.name):$($property.Name)" ($entry -notmatch '(?i)(rpc|url|endpoint|secret|token|private|mnemonic|api.?key)') "sanitized"
    }
}

$suiteBindings = @(
    [ordered]@{ name = "focused-queue"; raw = $results.focused.queue; source = "test/critical-symbiotic-vaultv2-step1/VaultV2WithdrawalQueueStep1.t.sol" },
    [ordered]@{ name = "focused-donation"; raw = $results.focused.donation; source = "test/critical-symbiotic-vaultv2-step1/VaultV2DonationCharacterization.t.sol" },
    [ordered]@{ name = "focused-stateful"; raw = $results.focused.stateful; source = "test/critical-symbiotic-vaultv2-step1/VaultV2QueueStatefulInvariants.t.sol" },
    [ordered]@{ name = "upstream-units"; raw = $results.upstream.queue; source = "test/vault/WithdrawalQueueFill.t.sol" },
    [ordered]@{ name = "upstream-claim"; raw = $results.upstream.claim; source = "test/invariant/WithdrawalQueueClaimInvariants.t.sol" },
    [ordered]@{ name = "upstream-pending"; raw = $results.upstream.pending; source = "test/invariant/PendingWithdrawalQueueInvariants.t.sol" }
)
foreach ($binding in $suiteBindings) {
    $sourceNames = Get-SourceTestNames $binding.source
    $rawNames = @($binding.raw.passNames)
    Add-Check "suite-total:$($binding.name)" ($binding.raw.suiteTotal -eq $rawNames.Count) "total=$($binding.raw.suiteTotal),passes=$($rawNames.Count)"
    Add-Check "suite-names:$($binding.name)" (Test-SameNames $sourceNames $rawNames) (($rawNames | Sort-Object) -join ",")
}

$donationCommand = $commandDocument.records | Where-Object { $_.name -eq "focused-donation" }
$fuzzRunsIndex = [Array]::IndexOf([object[]]$donationCommand.arguments, "--fuzz-runs")
$commandFuzzRuns = [int64]$donationCommand.arguments[$fuzzRunsIndex + 1]
foreach ($row in $results.focused.donation.fuzzRows) {
    Add-Check "fuzz-row:$($row.name)" ($row.runs -eq $commandFuzzRuns) "runs=$($row.runs)"
}

$invariantCampaigns = @(
    [ordered]@{ name = "focused-stateful"; rows = @($results.focused.stateful.invariantRows) },
    [ordered]@{ name = "upstream-claim"; rows = @($results.upstream.claim.invariantRows) },
    [ordered]@{ name = "upstream-pending"; rows = @($results.upstream.pending.invariantRows) }
)
foreach ($campaign in $invariantCampaigns) {
    $command = $commandDocument.records | Where-Object { $_.name -eq $campaign.name }
    $expectedRuns = [int64]$command.environment.FOUNDRY_INVARIANT_RUNS
    $expectedDepth = [int64]$command.environment.FOUNDRY_INVARIANT_DEPTH
    foreach ($row in $campaign.rows) {
        Add-Check "invariant-row:$($campaign.name):$($row.name)" ($row.runs -eq $expectedRuns -and $row.calls -eq $expectedRuns * $expectedDepth -and $row.reverts -eq 0) "runs=$($row.runs),calls=$($row.calls),reverts=$($row.reverts)"
    }
}

$derivedFixedNames = @($results.focused.queue.passNames + $results.focused.donation.passNames + $results.focused.stateful.passNames | Where-Object { -not $_.StartsWith("testFuzz_") -and -not $_.StartsWith("invariant_") })
Add-Check "focused-fixed-derived" ($results.focused.fixedTests -eq $derivedFixedNames.Count) "fixed=$($results.focused.fixedTests)"
foreach ($label in @("deposit", "mint", "shareTransfer", "donate", "request", "fill", "nftTransfer", "claim", "accrue", "warp")) {
    $value = $results.focused.deterministicCounters[$label]
    Add-Check "counter-$label" ($value.attempts -gt 0 -and $value.attempts -eq $value.successes + $value.reverts + $value.skips -and $value.successes -gt 0 -and $value.reverts -eq 0 -and $value.skips -eq 0) ($value | ConvertTo-Json -Compress)
}
Add-Check "rollback" ($results.focused.rollbackAssertions -gt 0) ([string]$results.focused.rollbackAssertions)

$candidate = $results.candidate
$victimTotal = [int64]$candidate.victimDepositEach * [int64]$candidate.victimCount
$candidatePayout = [math]::Floor(([decimal]$candidate.attackerSeed * ([decimal]$candidate.attackerSeed + $candidate.donation + $victimTotal + 1)) / ([decimal]$candidate.attackerSeed + 1))
Add-Check "candidate-zero-shares" ($candidate.victimSharesTotal -eq 0) ([string]$candidate.victimSharesTotal)
Add-Check "candidate-charged-inputs" ($candidate.chargedInputs -eq $candidate.attackerSeed + $candidate.donation) ([string]$candidate.chargedInputs)
Add-Check "candidate-payout-formula" ($candidate.payout -eq $candidatePayout) ([string]$candidate.payout)
Add-Check "candidate-net" ($candidate.attackerNet -eq $candidate.payout - $candidate.chargedInputs) ([string]$candidate.attackerNet)
Add-Check "candidate-conservation" ($candidate.chargedInputs + $victimTotal -eq $candidate.payout + $candidate.residual) "inputs=$($candidate.chargedInputs + $victimTotal),outputs=$($candidate.payout + $candidate.residual)"

$fee = $results.feeCounterexample
$calculatedFeeAssets = [math]::Floor(([decimal]$fee.donation * $fee.performanceFee) / 1000000000000000000)
$assetsWithoutFees = $fee.attackerSeed + $fee.donation - $calculatedFeeAssets
$calculatedFeeShares = [math]::Floor(([decimal]$calculatedFeeAssets * ($fee.attackerSeed * $fee.virtualShares + $fee.virtualShares)) / ($assetsWithoutFees + 1))
$feeFreeShares = [math]::Floor(([decimal]$fee.victimAssets * ($fee.virtualShares * ($fee.attackerSeed + 1))) / ($fee.attackerSeed + $fee.donation + 1))
$feeAwareShares = [math]::Floor(([decimal]$fee.victimAssets * ($fee.virtualShares * ($fee.attackerSeed + 1) + $calculatedFeeShares)) / ($fee.attackerSeed + $fee.donation + 1))
Add-Check "fee-counter-assets" ($fee.pendingFeeAssets -eq $calculatedFeeAssets) ([string]$fee.pendingFeeAssets)
Add-Check "fee-counter-shares" ($fee.pendingFeeShares -eq $calculatedFeeShares) ([string]$fee.pendingFeeShares)
Add-Check "fee-counter-fee-free" ($fee.feeFreeVictimShares -eq $feeFreeShares) ([string]$fee.feeFreeVictimShares)
Add-Check "fee-counter-production" ($fee.productionVictimShares -eq $feeAwareShares -and $fee.productionVictimShares -ne $fee.feeFreeVictimShares) ([string]$fee.productionVictimShares)

$manifestPath = Join-Path $rawDir "source-closure-manifest.json"
$manifest = [System.IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
$derivedNamespaced = @($manifest.entries | Where-Object { $_.path.StartsWith("test/critical-symbiotic-vaultv2-step1/") }).Count
$derivedOriginal = $manifest.entries.Count - $derivedNamespaced
Add-Check "manifest-count" ($manifest.build.compilerSeenFiles -eq $manifest.entries.Count -and $results.build.compiledFiles -eq $manifest.entries.Count) "manifest=$($manifest.entries.Count),build=$($results.build.compiledFiles)"
Add-Check "manifest-original" ($manifest.build.originalClosureFiles -eq $derivedOriginal -and $results.build.originalClosureFiles -eq $derivedOriginal) ([string]$derivedOriginal)
Add-Check "manifest-namespaced" ($manifest.build.namespacedStageFiles -eq $derivedNamespaced -and $results.build.namespacedFiles -eq $derivedNamespaced) ([string]$derivedNamespaced)
Add-Check "commit" ($manifest.checkout.commit -eq "83a3a9ab8febe868896780a68345dbf820d843ff") $manifest.checkout.commit
Add-Check "compiler-settings" ($manifest.compiler.solc -eq "0.8.28" -and $manifest.compiler.evmVersion -eq "osaka" -and $manifest.compiler.optimizer -and $manifest.compiler.optimizerRuns -eq 200 -and -not $manifest.compiler.viaIR -and $manifest.compiler.bytecodeHash -eq "none") ($manifest.compiler | ConvertTo-Json -Compress)
foreach ($entry in $manifest.entries) {
    $full = Join-Path $target $entry.path
    Add-Check "source:$($entry.path)" ((Test-Path -LiteralPath $full -PathType Leaf) -and (Get-Sha256 $full) -eq $entry.sha256) $entry.sha256
}

$productionDiff = Get-Text "production-diff"
Add-Check "production-upstream-no-diff" ([string]::IsNullOrWhiteSpace($productionDiff)) "bytes=$([Text.Encoding]::UTF8.GetByteCount($productionDiff))"
$status = Get-Text "status"
$badStatus = @($status -split "`r?`n" | Where-Object { $_ -and $_ -notmatch '^\?\? test/critical-symbiotic-vaultv2-step1/' })
Add-Check "target-write-boundary" ($badStatus.Count -eq 0) ($status.Trim())

$jsonPaths = @(
    (Join-Path $rawDir "commands.json"),
    (Join-Path $rawDir "results.json"),
    $manifestPath,
    $inbox
)
foreach ($path in $jsonPaths) {
    $valid = $true
    try { [void]([System.IO.File]::ReadAllText($path) | ConvertFrom-Json) } catch { $valid = $false }
    Add-Check "json:$([System.IO.Path]::GetFileName($path))" $valid (Get-Sha256 $path)
}

$requiredReportTokens = @(
    "CONDITIONAL MEDIUM",
    "sourcePrimitive=1",
    "localRoutePositive=1",
    "operationalRoutePositive=0",
    "1 / 1,999 / 3 x 1,000",
    "q_i = floor(v_i * (V(a + 1) + F_i)",
    "21/21",
    "65,536",
    "deployed source, runtime and current configuration are unverified",
    "not queue interpolation dust",
    "cannot span independent victim transactions"
)
$reportText = [System.IO.File]::ReadAllText($report)
foreach ($token in $requiredReportTokens) { Add-Check "report-token:$token" ($reportText.Contains($token)) $token }

$artifactFiles = New-Object System.Collections.Generic.List[string]
$artifactFiles.Add($report)
$artifactFiles.Add($inbox)
$artifactFiles.Add($handoff)
$artifactFiles.Add($PSCommandPath)
Get-ChildItem -LiteralPath $rawDir -File | Where-Object { $_.Name -notin @("package-hashes.json", "validator-output.json") } | ForEach-Object { $artifactFiles.Add($_.FullName) }
Get-ChildItem -LiteralPath (Join-Path $target "test\critical-symbiotic-vaultv2-step1") -File | ForEach-Object { $artifactFiles.Add($_.FullName) }
$leakPatterns = @('https?://', 'wss?://', 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY', 'PRIVATE_KEY\s*=', 'RPC_URL\s*=')
foreach ($path in $artifactFiles) {
    $text = [System.IO.File]::ReadAllText($path)
    $leak = $false
    foreach ($pattern in $leakPatterns) { if ($text -match $pattern) { $leak = $true; break } }
    Add-Check "leak:$([System.IO.Path]::GetFileName($path))" (-not $leak) "scanned"
    $trailing = @($text -split "`r?`n" | Where-Object { $_ -match '[ \t]+$' }).Count
    Add-Check "whitespace:$([System.IO.Path]::GetFileName($path))" ($trailing -eq 0 -and ($text.Length -eq 0 -or $text.EndsWith("`n"))) "trailing=$trailing"
}

$hashEntries = @()
foreach ($path in ($artifactFiles | Sort-Object -Unique)) {
    $relative = $path.Substring($workspace.Length + 1).Replace('\', '/')
    $hashEntries += [ordered]@{ path = $relative; sha256 = Get-Sha256 $path; bytes = (Get-Item $path).Length }
}
$aggregateInput = (($hashEntries | ForEach-Object { "$($_.path):$($_.sha256)" }) -join "`n") + "`n"
$sha = [System.Security.Cryptography.SHA256]::Create()
$aggregate = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($aggregateInput)))).Replace("-", "").ToLowerInvariant()
$package = [ordered]@{ schema = "symbiotic-vaultv2-step1-package-hashes-v1"; aggregateSha256 = $aggregate; entries = $hashEntries }
Write-Utf8 (Join-Path $rawDir "package-hashes.json") (($package | ConvertTo-Json -Depth 6) + "`n")

$output = [ordered]@{
    schema = "symbiotic-vaultv2-step1-validator-v1"
    generatedAt = [DateTime]::UtcNow.ToString("o")
    status = if ($failures.Count -eq 0) { "PASS" } else { "FAIL" }
    checks = $checks.Count
    passed = @($checks | Where-Object { $_.passed }).Count
    failed = $failures.Count
    failures = $failures
    packageAggregateSha256 = $aggregate
    network = [ordered]@{ rpc = $false; fork = $false; signedTransactions = $false }
    details = $checks
}
Write-Utf8 (Join-Path $rawDir "validator-output.json") (($output | ConvertTo-Json -Depth 8) + "`n")
$output | ConvertTo-Json -Depth 5
if ($failures.Count -ne 0) { exit 1 }
