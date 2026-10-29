$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0
. "$PSScriptRoot\..\.runtime\morpho-pt-post-expiry-r3-production\issue-morpho-pt-27aug2026-post-expiry-r3-production-permit-once.ps1"
$script:Assertions = 0
$script:Tests = 0
function Assert([bool]$Value, [string]$Message) { $script:Assertions++; if (-not $Value) { throw "ASSERT:$Message" } }
function Begin-Test { $script:Tests++ }
function Quote([string]$Value) { return '"' + $Value.Replace('"','\"') + '"' }

$root = Join-Path ([IO.Path]::GetTempPath()) ("opencode\r3-permit-conductor-unit-" + [Guid]::NewGuid().ToString("N"))
[void][IO.Directory]::CreateDirectory($root)
Set-Acl -LiteralPath $root -AclObject (New-ExactAcl $true)
$helper = Join-Path $root "synthetic-helper.js"
$helperSource = @'
"use strict";
const fs=require("node:fs");
const cp=require("node:child_process");
const [mode,permit,nonce,observation,behavior,events]=process.argv.slice(2);
const sealed=Object.keys(process.env).sort().join(",")==="SystemRoot,WINDIR"&&process.env.SystemRoot==="C:\\Windows"&&process.env.WINDIR==="C:\\Windows";
fs.appendFileSync(events,mode+"\n");
if(mode==="precheck"){process.exit(fs.existsSync(permit)?10:0);}
if(mode==="postcheck"){process.exit(fs.existsSync(permit)?0:11);}
if(mode!=="issuer"||process.argv.length!==8)process.exit(91);
const chunks=[];process.stdin.on("data",x=>chunks.push(x));process.stdin.on("end",()=>{
 const input=Buffer.concat(chunks),expected=fs.readFileSync(nonce),framing=/^[0-9a-f]{64}\n$/.test(input.toString("ascii"));
 fs.writeFileSync(observation,JSON.stringify({stdinEqualsHeldNonce:input.equals(expected),framing,sealed,argvExact:process.argv.length===8,bytes:input.length}),{flag:"wx"});
 if(behavior==="success"){fs.writeFileSync(permit,"synthetic",{flag:"wx"});return;}
 if(behavior==="partial"){fs.writeFileSync(permit,"synthetic",{flag:"wx"});process.exitCode=7;return;}
 if(behavior==="failure"){process.exitCode=7;return;}
 if(behavior==="innerTimeout"){process.exitCode=124;return;}
 if(behavior==="delayedTree"){cp.spawn(process.execPath,["-e","setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'late'),1000)",permit],{stdio:"ignore"});setTimeout(()=>{},10000);return;}
 if(behavior==="output"){process.stdout.write("x".repeat(8192));process.stderr.write("y".repeat(8192));setTimeout(()=>{},10000);return;}
 if(behavior==="timeout"){setTimeout(()=>{},10000);return;}
 process.exitCode=92;
});
'@
[IO.File]::WriteAllText($helper, $helperSource, [Text.UTF8Encoding]::new($false))
$node = $env:R3_TEST_NODE
if (-not [IO.Path]::IsPathRooted($node) -or -not (Test-Path -LiteralPath $node -PathType Leaf)) { throw "TEST_NODE" }
$inventory=Join-Path $root "rpc_endpoints.txt"; $secrets=Join-Path $root ".env"; $capture=Join-Path $root "capture-output.json"; $output=Join-Path $root "production-output.json"
foreach($sentinel in @($inventory,$secrets,$capture,$output)){[IO.File]::WriteAllText($sentinel,"sentinel",[Text.UTF8Encoding]::new($false))}
$before=@{}; foreach($sentinel in @($inventory,$secrets,$capture,$output)){$before[$sentinel]=(Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash}

function Config([string]$Name, [string]$Behavior, [int]$Timeout = 5000, [int]$Limit = 4096) {
  $nonce = Join-Path $root ($Name + "-r3-nonce.txt"); $permit = Join-Path $root ($Name + "-active-r2-permit.json"); $obs = Join-Path $root ($Name + "-observation.json"); $events = Join-Path $root ($Name + "-events.txt")
  return @{
    SelfCheck=$false; NoncePath=$nonce
    PrecheckExe=$node; PrecheckArguments=((Quote $helper)+" precheck "+(Quote $permit)+" "+(Quote $nonce)+" "+(Quote $obs)+" none "+(Quote $events))
    PostcheckExe=$node; PostcheckArguments=((Quote $helper)+" postcheck "+(Quote $permit)+" "+(Quote $nonce)+" "+(Quote $obs)+" none "+(Quote $events))
    IssuerExe=$node; IssuerArguments=((Quote $helper)+" issuer "+(Quote $permit)+" "+(Quote $nonce)+" "+(Quote $obs)+" "+$Behavior+" "+(Quote $events))
    PrecheckPresentExit=10; PostcheckPresentExit=0; PostcheckAbsentExit=11; PrecheckTimeoutMs=2000; PostcheckTimeoutMs=2000; IssuerTimeoutMs=$Timeout; TerminationWaitMs=2000; MaxOutputBytes=$Limit
    Permit=$permit; Nonce=$nonce; Observation=$obs; Events=$events
  }
}

try {
  $r2Self = "C:\_Work\__EVM_AUDIT\.runtime\morpho-pt-post-expiry-r2-production\issue-morpho-pt-27aug2026-post-expiry-r2-production-permit-once.ps1"
  $r2Nonce = "C:\_Work\__EVM_AUDIT\.runtime\morpho-pt-post-expiry-r2-production\morpho-pt-27aug2026-post-expiry-r2-production-nonce.txt"
  $r3Self = "C:\_Work\__EVM_AUDIT\.runtime\morpho-pt-post-expiry-r3-production\issue-morpho-pt-27aug2026-post-expiry-r3-production-permit-once.ps1"
  $r3Nonce = "C:\_Work\__EVM_AUDIT\.runtime\morpho-pt-post-expiry-r3-production\morpho-pt-27aug2026-post-expiry-r3-production-nonce.txt"
  Begin-Test
  Assert ($script:Production.SelfPath -ceq $r3Self) "exact R3 self path"
  Assert ($script:Production.NoncePath -ceq $r3Nonce) "exact R3 nonce path"
  Assert ($script:Production.SelfPath -cne $r2Self -and $script:Production.NoncePath -cne $r2Nonce) "old R2 fixed paths rejected"
  Assert ((Test-Path -LiteralPath $r3Nonce) -eq $false) "production R3 nonce absent"
  Assert (Test-ExactAcl $r3Self $false) "production self exact DACL"
  Assert ($script:Production.PermitPath -eq "/home/mruserbox/.local/share/evm-audit/morpho-pt-post-expiry-r2/permits/morpho-pt-27aug2026-post-expiry-r2-production.json") "active R2 permit target"
  Assert ($script:Production.WslPath -eq "C:\Windows\System32\wsl.exe") "wsl path"
  Assert ($script:Production.LinuxEnvPath -eq "/usr/bin/env" -and $script:Production.LinuxTestPath -eq "/usr/bin/test" -and $script:Production.LinuxTimeoutPath -eq "/usr/bin/timeout") "Linux fixed binaries"
  Assert ($script:Production.LinuxNodePath -eq "/home/mruserbox/.local/share/evm-audit/morpho-pt-post-expiry-r2/runtime/bin/node") "node path"
  Assert ($script:Production.LinuxIssuerPath -eq "/home/mruserbox/.local/share/evm-audit/morpho-pt-post-expiry-r2/tools/issue-morpho-pt-27aug2026-post-expiry-r2-production-permit.js") "issuer path"
  Assert ($script:Production.PrecheckArguments -eq "--distribution Ubuntu-22.04 --user mruserbox --exec /usr/bin/test ! -e /home/mruserbox/.local/share/evm-audit/morpho-pt-post-expiry-r2/permits/morpho-pt-27aug2026-post-expiry-r2-production.json") "precheck identity and active target"
  Assert ($script:Production.PostcheckArguments -eq "--distribution Ubuntu-22.04 --user mruserbox --exec /usr/bin/test -e /home/mruserbox/.local/share/evm-audit/morpho-pt-post-expiry-r2/permits/morpho-pt-27aug2026-post-expiry-r2-production.json") "postcheck identity and active target"
  Assert ($script:Production.IssuerArguments -eq "--distribution Ubuntu-22.04 --user mruserbox --exec /usr/bin/timeout --signal=TERM --kill-after=5s 25s /usr/bin/env -i LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC /home/mruserbox/.local/share/evm-audit/morpho-pt-post-expiry-r2/runtime/bin/node /home/mruserbox/.local/share/evm-audit/morpho-pt-post-expiry-r2/tools/issue-morpho-pt-27aug2026-post-expiry-r2-production-permit.js") "issuer argv identity environment timeout"
  Assert ($script:Production.IssuerTimeoutMs -eq 40000 -and $script:Production.TerminationWaitMs -eq 10000 -and $script:Production.MaxOutputBytes -eq 4096) "outer bounds"
  $r2Source = Get-Content -LiteralPath $r2Self -Raw
  $r3Source = Get-Content -LiteralPath $r3Self -Raw
  $normalized = $r3Source.Replace($r3Self,$r2Self).Replace($r3Nonce,$r2Nonce)
  Assert ($normalized -ceq $r2Source) "exact hardened R2 clone except fixed self and nonce"

  Begin-Test
  $c=Config "success" "success"; $r=Invoke-R2PermitConductor $c
  Assert ($r.ExitCode -eq 0 -and $r.PermitState -eq "PRESENT") "active absent success result"
  Assert ((Test-Path -LiteralPath $c.Nonce) -and (Test-ExactAcl $c.Nonce $false)) "retained exact nonce DACL"
  $nonceText=[IO.File]::ReadAllText($c.Nonce,[Text.Encoding]::ASCII)
  Assert ((Get-Item -LiteralPath $c.Nonce).Length -eq 65 -and $nonceText -cmatch '^[0-9a-f]{64}\n$') "exact nonce framing"
  $o=Get-Content -LiteralPath $c.Observation -Raw|ConvertFrom-Json
  Assert ($o.stdinEqualsHeldNonce -and $o.framing -and $o.sealed -and $o.argvExact -and $o.bytes -eq 65) "held nonce argv and sealed environment"
  $ev=@(Get-Content -LiteralPath $c.Events); Assert (@($ev|Where-Object{$_-eq"issuer"}).Count -eq 1 -and $ev[0] -eq "precheck" -and $ev[-1] -eq "postcheck") "one issuer no retry and reconcile"

  Begin-Test
  $old=Join-Path $root "morpho-pt-27aug2026-post-expiry-r2-production-nonce.txt"; $oldBytes=("0"*64)+"`n"; [IO.File]::WriteAllText($old,$oldBytes,[Text.Encoding]::ASCII)
  $c=Config "old-r2-rejected" "success"; $r=Invoke-R2PermitConductor $c
  Assert ($r.ExitCode -eq 0 -and (Test-Path -LiteralPath $c.Nonce)) "fresh R3 nonce used with old R2 nonce present"
  Assert ([IO.File]::ReadAllText($old,[Text.Encoding]::ASCII) -ceq $oldBytes) "old R2 nonce ignored and unchanged"
  Assert ([IO.File]::ReadAllText($c.Nonce,[Text.Encoding]::ASCII) -cne $oldBytes) "old R2 nonce not accepted"

  Begin-Test
  $archive=Join-Path $root "expired-r2-permit-archived-evidence.json"; [IO.File]::WriteAllText($archive,"immutable-archive",[Text.UTF8Encoding]::new($false))
  $c=Config "archive-ignored" "success"; $r=Invoke-R2PermitConductor $c; $ev=@(Get-Content -LiteralPath $c.Events)
  Assert ($r.ExitCode -eq 0 -and $r.PermitState -eq "PRESENT" -and @($ev|Where-Object{$_-eq"issuer"}).Count -eq 1) "archived evidence is not active target"
  Assert ([IO.File]::ReadAllText($archive) -ceq "immutable-archive") "archived evidence unchanged"

  Begin-Test
  $c=Config "exclusive" "success"; [IO.File]::WriteAllText($c.Nonce,"existing",[Text.UTF8Encoding]::new($false)); $r=Invoke-R2PermitConductor $c
  Assert ($r.ExitCode -eq 22 -and (Test-Path -LiteralPath $c.Nonce) -and -not (Test-Path -LiteralPath $c.Permit)) "exclusive create no replace"

  Begin-Test
  $c=Config "present" "success"; [IO.File]::WriteAllText($c.Permit,"synthetic",[Text.UTF8Encoding]::new($false)); $r=Invoke-R2PermitConductor $c
  Assert ($r.ExitCode -eq 20 -and $r.PermitState -eq "PRESENT" -and -not (Test-Path -LiteralPath $c.Nonce)) "active target preexisting"

  Begin-Test
  $c=Config "failure" "failure"; $r=Invoke-R2PermitConductor $c; $ev=@(Get-Content -LiteralPath $c.Events)
  Assert ($r.ExitCode -eq 23 -and $r.PermitState -eq "ABSENT" -and -not (Test-Path -LiteralPath $c.Nonce) -and -not (Test-Path -LiteralPath $c.Permit)) "failure absent reconcile"
  Assert (@($ev|Where-Object{$_-eq"issuer"}).Count -eq 1) "failure has no retry"

  Begin-Test
  $c=Config "partial" "partial"; $r=Invoke-R2PermitConductor $c
  Assert ($r.ExitCode -eq 23 -and $r.PermitState -eq "PRESENT" -and (Test-Path -LiteralPath $c.Nonce) -and (Test-Path -LiteralPath $c.Permit)) "partial reconciles present"

  Begin-Test
  $c=Config "timeout" "timeout" 250; $r=Invoke-R2PermitConductor $c
  Assert ($r.ExitCode -eq 124 -and $r.PermitState -eq "UNKNOWN" -and (Test-Path -LiteralPath $c.Nonce)) "outer timeout retains"

  Begin-Test
  $c=Config "output" "output" 3000 128; $r=Invoke-R2PermitConductor $c
  Assert ($r.ExitCode -eq 125 -and $r.PermitState -eq "UNKNOWN" -and (Test-Path -LiteralPath $c.Nonce)) "output contained and not disclosed"

  Begin-Test
  $c=Config "inner-timeout" "innerTimeout"; $r=Invoke-R2PermitConductor $c
  Assert ($r.ExitCode -eq 124 -and $r.PermitState -eq "ABSENT" -and -not (Test-Path -LiteralPath $c.Nonce)) "inner timeout reconciles absent"

  foreach($fault in @("POST_START","STDIN_WRITE","READ")) {
    Begin-Test
    $c=Config ("fault-"+$fault) "timeout" 3000; $c.IssuerFault=$fault; $r=Invoke-R2PermitConductor $c
    Assert ($r.ExitCode -eq 27 -and $r.PermitState -eq "UNKNOWN" -and (Test-Path -LiteralPath $c.Nonce)) ("post-start containment "+$fault)
  }

  Begin-Test
  $c=Config "post-unknown" "failure"; $c.PostcheckExe=Join-Path $root "missing.exe"; $r=Invoke-R2PermitConductor $c
  Assert ($r.ExitCode -eq 26 -and $r.PermitState -eq "UNKNOWN" -and (Test-Path -LiteralPath $c.Nonce)) "postcheck unknown retains"

  Begin-Test
  $c=Config "delayed-tree" "delayedTree" 250; $r=Invoke-R2PermitConductor $c; Start-Sleep -Milliseconds 1500
  Assert ($r.PermitState -eq "UNKNOWN" -and (Test-Path -LiteralPath $c.Nonce) -and -not (Test-Path -LiteralPath $c.Permit)) "job prevents delayed descendant mutation"

  Begin-Test
  Assert ($r3Source -notmatch "rpc_endpoints|graphql_endpoints|node:dns|node:https|Invoke-WebRequest|Invoke-RestMethod|Start-Job|Invoke-Expression") "no inventory or network capability"
  Assert ($r3Source -notmatch "\.env(?:\W|$)|PRIVATE_KEY|MNEMONIC|capture-morpho|run-morpho") "no secrets or capture capability"
  Assert ($r3Source -notmatch "Write-Output.*nonce|Write-Host.*nonce|Write-Output.*IssuerArguments|Write-Host.*IssuerArguments") "no sensitive disclosure"
  foreach($sentinel in @($inventory,$secrets,$capture,$output)){Assert ((Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash -eq $before[$sentinel]) ("no mutation "+[IO.Path]::GetFileName($sentinel))}
  Assert (-not (Test-Path -LiteralPath $r3Nonce)) "no production nonce created"
  Write-Output "R3_PERMIT_CONDUCTOR_OFFLINE_SUMMARY assertions=$script:Assertions tests=$script:Tests productionIssuerExecutions=0 wsl=0 network=0 capture=0 outputMutations=0"
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
