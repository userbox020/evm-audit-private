$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0
. "$PSScriptRoot\issue-morpho-pt-27aug2026-post-expiry-r2-production-permit-once-win32.ps1"
$script:Assertions = 0
function Assert([bool]$Value, [string]$Message) { $script:Assertions++; if (-not $Value) { throw "ASSERT:$Message" } }
function Quote([string]$Value) { return '"' + $Value.Replace('"','\"') + '"' }

$root = Join-Path ([IO.Path]::GetTempPath()) ("opencode\r2-permit-conductor-unit-" + [Guid]::NewGuid().ToString("N"))
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
 if(behavior==="output"){process.stdout.write("x".repeat(8192));setTimeout(()=>{},10000);return;}
 if(behavior==="timeout"){setTimeout(()=>{},10000);return;}
 process.exitCode=92;
});
'@
[IO.File]::WriteAllText($helper, $helperSource, [Text.UTF8Encoding]::new($false))
$node = $env:R2_TEST_NODE
if (-not [IO.Path]::IsPathRooted($node) -or -not (Test-Path -LiteralPath $node -PathType Leaf)) { throw "TEST_NODE" }

function Config([string]$Name, [string]$Behavior, [int]$Timeout = 5000, [int]$Limit = 4096) {
  $nonce = Join-Path $root ($Name + "-nonce.txt"); $permit = Join-Path $root ($Name + "-permit.json"); $obs = Join-Path $root ($Name + "-observation.json"); $events = Join-Path $root ($Name + "-events.txt")
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
  Assert ($script:Production.SelfPath -eq "C:\_Work\__EVM_AUDIT\.runtime\morpho-pt-post-expiry-r2-production\issue-morpho-pt-27aug2026-post-expiry-r2-production-permit-once.ps1") "self path"
  Assert ($script:Production.NoncePath -eq "C:\_Work\__EVM_AUDIT\.runtime\morpho-pt-post-expiry-r2-production\morpho-pt-27aug2026-post-expiry-r2-production-nonce.txt") "nonce path"
  Assert ($script:Production.WslPath -eq "C:\Windows\System32\wsl.exe") "wsl path"
  Assert ($script:Production.LinuxEnvPath -eq "/usr/bin/env") "env path"
  Assert ($script:Production.LinuxTestPath -eq "/usr/bin/test") "test path"
  Assert ($script:Production.LinuxTimeoutPath -eq "/usr/bin/timeout") "timeout path"
  Assert ($script:Production.LinuxNodePath -eq "/home/mruserbox/.local/share/evm-audit/morpho-pt-post-expiry-r2/runtime/bin/node") "node path"
  Assert ($script:Production.LinuxIssuerPath -eq "/home/mruserbox/.local/share/evm-audit/morpho-pt-post-expiry-r2/tools/issue-morpho-pt-27aug2026-post-expiry-r2-production-permit.js") "issuer path"
  Assert ($script:Production.PrecheckArguments -eq "--distribution Ubuntu-22.04 --user mruserbox --exec /usr/bin/test ! -e /home/mruserbox/.local/share/evm-audit/morpho-pt-post-expiry-r2/permits/morpho-pt-27aug2026-post-expiry-r2-production.json") "precheck argv"
  Assert ($script:Production.PostcheckArguments -eq "--distribution Ubuntu-22.04 --user mruserbox --exec /usr/bin/test -e /home/mruserbox/.local/share/evm-audit/morpho-pt-post-expiry-r2/permits/morpho-pt-27aug2026-post-expiry-r2-production.json") "postcheck argv"
  Assert ($script:Production.IssuerArguments -eq "--distribution Ubuntu-22.04 --user mruserbox --exec /usr/bin/timeout --signal=TERM --kill-after=5s 25s /usr/bin/env -i LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC /home/mruserbox/.local/share/evm-audit/morpho-pt-post-expiry-r2/runtime/bin/node /home/mruserbox/.local/share/evm-audit/morpho-pt-post-expiry-r2/tools/issue-morpho-pt-27aug2026-post-expiry-r2-production-permit.js") "issuer argv"
  Assert ($script:Production.IssuerTimeoutMs -gt 30000) "outer deadline"

  $c=Config "success" "success"; $r=Invoke-R2PermitConductor $c
  Assert ($r.ExitCode -eq 0 -and $r.PermitState -eq "PRESENT") "success result"
  Assert ((Test-Path -LiteralPath $c.Nonce) -and (Test-ExactAcl $c.Nonce $false)) "retained nonce authority"
  Assert ((Get-Item -LiteralPath $c.Nonce).Length -eq 65) "nonce length"
  $o=Get-Content -LiteralPath $c.Observation -Raw|ConvertFrom-Json
  Assert ($o.stdinEqualsHeldNonce -and $o.framing -and $o.sealed -and $o.argvExact -and $o.bytes -eq 65) "framing argv env"
  $ev=@(Get-Content -LiteralPath $c.Events); Assert (@($ev|Where-Object{$_-eq"issuer"}).Count -eq 1 -and $ev[0] -eq "precheck" -and $ev[-1] -eq "postcheck") "one issuer and distinct checks"

  $c=Config "exclusive" "success"; [IO.File]::WriteAllText($c.Nonce,"existing",[Text.UTF8Encoding]::new($false)); $r=Invoke-R2PermitConductor $c
  Assert ($r.ExitCode -eq 22 -and (Test-Path -LiteralPath $c.Nonce) -and -not (Test-Path -LiteralPath $c.Permit)) "exclusive create"

  $c=Config "present" "success"; [IO.File]::WriteAllText($c.Permit,"synthetic",[Text.UTF8Encoding]::new($false)); $r=Invoke-R2PermitConductor $c
  Assert ($r.ExitCode -eq 20 -and $r.PermitState -eq "PRESENT" -and -not (Test-Path -LiteralPath $c.Nonce)) "preexisting permit"

  $c=Config "failure" "failure"; $r=Invoke-R2PermitConductor $c
  Assert ($r.ExitCode -eq 23 -and $r.PermitState -eq "ABSENT" -and -not (Test-Path -LiteralPath $c.Nonce) -and -not (Test-Path -LiteralPath $c.Permit)) "failure absent reconcile"

  $c=Config "partial" "partial"; $r=Invoke-R2PermitConductor $c
  Assert ($r.ExitCode -eq 23 -and $r.PermitState -eq "PRESENT" -and (Test-Path -LiteralPath $c.Nonce) -and (Test-Path -LiteralPath $c.Permit)) "partial state"

  $c=Config "timeout" "timeout" 250; $r=Invoke-R2PermitConductor $c
  Assert ($r.ExitCode -eq 124 -and $r.PermitState -eq "UNKNOWN" -and (Test-Path -LiteralPath $c.Nonce)) "outer timeout retains"

  $c=Config "output" "output" 3000 128; $r=Invoke-R2PermitConductor $c
  Assert ($r.ExitCode -eq 125 -and $r.PermitState -eq "UNKNOWN" -and (Test-Path -LiteralPath $c.Nonce)) "output retains"

  $c=Config "inner-timeout" "innerTimeout"; $r=Invoke-R2PermitConductor $c
  Assert ($r.ExitCode -eq 124 -and $r.PermitState -eq "ABSENT" -and -not (Test-Path -LiteralPath $c.Nonce)) "inner timeout terminated"

  foreach($fault in @("POST_START","STDIN_WRITE","READ")) { $c=Config ("fault-"+$fault) "timeout" 3000; $c.IssuerFault=$fault; $r=Invoke-R2PermitConductor $c; Assert ($r.ExitCode -eq 27 -and $r.PermitState -eq "UNKNOWN" -and (Test-Path -LiteralPath $c.Nonce)) ("post-start "+$fault) }

  $c=Config "post-unknown" "failure"; $c.PostcheckExe=Join-Path $root "missing.exe"; $r=Invoke-R2PermitConductor $c
  Assert ($r.ExitCode -eq 26 -and $r.PermitState -eq "UNKNOWN" -and (Test-Path -LiteralPath $c.Nonce)) "post unknown retains"

  $c=Config "delayed-tree" "delayedTree" 250; $r=Invoke-R2PermitConductor $c; Start-Sleep -Milliseconds 1500
  Assert ($r.PermitState -eq "UNKNOWN" -and (Test-Path -LiteralPath $c.Nonce) -and -not (Test-Path -LiteralPath $c.Permit)) "job prevents delayed permit"

  $source=Get-Content -LiteralPath "$PSScriptRoot\issue-morpho-pt-27aug2026-post-expiry-r2-production-permit-once-win32.ps1" -Raw
  Assert ($source -notmatch "rpc_endpoints|node:dns|node:https|Start-Job|Invoke-Expression") "offline source"
  Assert ($source -notmatch "Write-Output.*nonce|Write-Host.*nonce") "no nonce output"
  Write-Output "R2_PERMIT_CONDUCTOR_OFFLINE_SUMMARY assertions=$script:Assertions tests=16 productionIssuerExecutions=0 network=0"
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
