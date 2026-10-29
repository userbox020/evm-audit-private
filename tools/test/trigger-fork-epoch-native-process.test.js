"use strict";
// N1 actual native processes/storage, not JOB containment or epoch qualification.
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),{spawn}=require("node:child_process");
const native=require("../lib/trigger-fork-epoch-native-adapter.js"),bridge=require("../lib/trigger-fork-epoch-native-bridge.js");
const base=path.join(process.env.LOCALAPPDATA,"Temp","opencode"),ps=path.join(process.env.SystemRoot,"System32","WindowsPowerShell","v1.0","powershell.exe"),host=path.resolve(__dirname,"..","trigger-fork-epoch-native-host.ps1");
const dispositions=[],roots=[];
function env(root){return {SystemRoot:process.env.SystemRoot,WINDIR:process.env.SystemRoot,ComSpec:path.join(process.env.SystemRoot,"System32","cmd.exe"),LOCALAPPDATA:process.env.LOCALAPPDATA,TEMP:root,TMP:root};}
function directory(t){const root=fs.mkdtempSync(path.join(base,"native-n1-"));roots.push(root);return root;}
function storage(t,root=directory(t),changes={}){
  const start=performance.now(),made=native.createNativeStorageAdapter({root,timeoutMs:2500,startupTimeoutMs:30000,qualificationDelayMs:0,...changes});
  if(!made.ok){t.after(async()=>{const r=await made.cleanup();assert.equal(r.ok,true);});assert.fail(JSON.stringify({code:made.code,startup:made.nativeStartup}));}
  const a=made.adapter,initial=a.supervision(),startupElapsedMs=Math.round(performance.now()-start);
  t.after(async()=>{const r=await a.dispose(),s=a.supervision();dispositions.push({kind:"N1_HOST",pid:initial.ownedHelperPid,creationTime100ns:initial.nativeStartup.helper.creationTime100ns,startupElapsedMs,helperExited:s.helperExited,helperExitCode:s.helperExitCode,workerExited:s.workerExited,disposition:r.code});assert.equal(r.ok,true);assert.equal(s.helperExited,true);assert.equal(s.workerExited,true);});
  return a;
}
function waitExit(child,ms=6000){return new Promise((resolve,reject)=>{if(child.exitCode!==null||child.signalCode!==null){resolve({code:child.exitCode,signal:child.signalCode});return;}const timer=setTimeout(()=>{child.kill();reject(new Error("OWNED_PROCESS_EXIT_TIMEOUT"));},ms);child.once("exit",(code,signal)=>{clearTimeout(timer);resolve({code,signal});});child.once("error",()=>{clearTimeout(timer);reject(new Error("OWNED_PROCESS_START_FAILED"));});});}
function firstFrame(child){return new Promise((resolve,reject)=>{let bytes=Buffer.alloc(0),settled=false;const timer=setTimeout(()=>{child.kill();reject(new Error("START_FRAME_TIMEOUT"));},30000);child.stdout.on("data",chunk=>{if(settled)return;bytes=Buffer.concat([bytes,chunk]);if(bytes.length>8192){settled=true;clearTimeout(timer);reject(new Error("START_FRAME_BOUND"));return;}if(bytes.length>=4&&bytes.length>=bytes.readUInt32LE(0)+4){settled=true;clearTimeout(timer);try{resolve(JSON.parse(bytes.subarray(4).toString("utf8")));}catch{reject(new Error("START_FRAME_INVALID"));}}});child.on("error",()=>{clearTimeout(timer);reject(new Error("OWNED_PROCESS_START_FAILED"));});});}
function lines(child){let pending="",values=[],waiters=[];child.stdout.on("data",chunk=>{pending+=chunk.toString("utf8");if(pending.length>8192){child.kill();return;}for(let i;(i=pending.indexOf("\n"))>=0;){const line=pending.slice(0,i);pending=pending.slice(i+1);let v;try{v=JSON.parse(line);}catch{continue;}if(waiters.length)waiters.shift()(v);else values.push(v);}});return ()=>values.length?Promise.resolve(values.shift()):new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error("OWNED_LINE_TIMEOUT"));},15000);waiters.push(v=>{clearTimeout(timer);resolve(v);});});}
async function observer(t,root,identity){
  const script=path.join(root,"process-observer.ps1");fs.writeFileSync(script,String.raw`
param([int]$ObservedPid,[string]$ExpectedCreation)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
try {
$src=@'
using System;using System.Runtime.InteropServices;
public static class N1Observer {
 [StructLayout(LayoutKind.Sequential)] struct T { public uint Low,High; public ulong Value {get{return ((ulong)High<<32)|Low;}} }
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint a,bool i,uint p);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr h,out T c,out T e,out T k,out T u);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h,uint n);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 public static int Watch(uint pid,string expected){IntPtr h=OpenProcess(0x101000,false,pid);if(h==IntPtr.Zero)return 2;try{T c,e,k,u;if(!GetProcessTimes(h,out c,out e,out k,out u)||c.Value.ToString()!=expected)return 3;Console.WriteLine("{\"ready\":true}");Console.Out.Flush();bool ended=WaitForSingleObject(h,10000)==0;Console.WriteLine(ended?"{\"exited\":true}":"{\"exited\":false}");return ended?0:4;}finally{CloseHandle(h);}}
}
'@
$cp=New-Object System.CodeDom.Compiler.CompilerParameters
$cp.GenerateInMemory=$true;$cp.TempFiles=New-Object System.CodeDom.Compiler.TempFileCollection($env:TEMP,$false)
$cp.ReferencedAssemblies.Add('System.dll')|Out-Null
Add-Type -TypeDefinition $src -CompilerParameters $cp -ErrorAction Stop|Out-Null
exit ([N1Observer]::Watch($ObservedPid,$ExpectedCreation))
} catch { [Console]::WriteLine('{"observerError":true}');exit 5 }
`);
  const child=spawn(ps,["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",script,"-ObservedPid",String(identity.pid),"-ExpectedCreation",identity.creationTime100ns],{env:env(root),windowsHide:true,stdio:["ignore","pipe","pipe"]});child.stderr.resume();const next=lines(child);t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();const e=await waitExit(child);dispositions.push({kind:"PROCESS_HANDLE_OBSERVER",pid:child.pid,exit:e.code});});assert.equal((await next()).ready,true);return {next,child};
}
function dummy(t,mode="EXIT",budget=10000,fault="NONE"){
  const root=directory(t),a=storage(t,root),d=a.describeDummy();assert.equal(d.ok,true);
  fs.writeFileSync(path.join(root,d.filename),d.source);fs.writeFileSync(path.join(root,d.companion.filename),d.companion.source);
  const s=a.sampleClock(),options={mode,scriptPath:path.join(root,d.filename),scriptDigest:d.digest,deadlineUtcMs:s.nowUtcMs+budget,deadlineMonotonicMs:s.monotonicNowMs+budget,cleanupBudgetMs:1000,fault};
  return {root,a,d,options,establish:()=>a.establishDummy(options)};
}
function treeUntil(a,cap,predicate,bound=3000){const start=performance.now();let v;do{v=a.waitDummy(cap,100);assert.equal(v.ok,true,JSON.stringify(v));if(predicate(v))return v;}while(performance.now()-start<bound);assert.fail(JSON.stringify({code:"DUMMY_TREE_BOUND",last:v}));}
async function observeMembers(t,h,members){const observed=[];for(const m of members)observed.push({identity:m,observer:await observer(t,h.root,m)});return observed;}
async function exitedMembers(observed,checkpoint){for(const m of observed){assert.equal((await m.observer.next()).exited,true);assert.equal((await waitExit(m.observer.child)).code,0);dispositions.push({kind:"N2_DUMMY_PROCESS",checkpoint,pid:m.identity.pid,creationTime100ns:m.identity.creationTime100ns,processHandleObservedExit:true,observerHeldJobHandle:false});}}
test.after(()=>{console.log("N1_OWNED_PROCESS_DISPOSITIONS "+JSON.stringify(dispositions));console.log("N2_OWNED_TEMP_ROOTS "+JSON.stringify(roots));for(const root of roots){fs.rmSync(root,{recursive:true,force:true});assert.equal(fs.existsSync(root),false);}});
test("N1 actual native dual identity and persistent QPC/UTC owner",async t=>{
  const a=storage(t),s=a.supervision();assert.equal(s.helperIdentityVerified,true);assert.equal(s.nativeStartup.helper.pid,s.ownedHelperPid);assert.equal(s.nativeStartup.parent.pid,process.pid);assert.match(s.nativeStartup.helper.creationTime100ns,/^\d{15,20}$/);assert.equal(s.hello.helper.creationTime100ns,s.nativeStartup.helper.creationTime100ns);assert.equal(s.nativeStartup.peerEvidence,"NATIVE_FIRST_INSTANCE_SERVER_PID_AND_CREATION_ATTESTED");
  const before=a.sampleClock();await new Promise(r=>setTimeout(r,40));const after=a.sampleClock();assert.equal(before.ok,true);assert.equal(after.ok,true);assert.ok(after.nowUtcMs>=before.nowUtcMs);assert.ok(after.monotonicNowMs>=before.monotonicNowMs);assert.ok(after.monotonicNowMs-before.monotonicNowMs>=20);assert.ok(Math.abs(after.nowUtcMs-Date.now())<2000);assert.equal(a.supervision().ownedHelperPid,s.ownedHelperPid);
  assert.equal(a.containment().code,"NATIVE_CONTAINMENT_UNIMPLEMENTED");assert.equal(a.sampleClock().ok,true);assert.equal(native.isNativeStorageAdapter({...a}),false);
  assert.equal(native.isNativeStorageAdapter(a),true);assert.equal(require("../lib/trigger-fork-epoch-platform.js").isRegisteredEpochPlatformAdapter(a),true);assert.equal(require("../lib/trigger-fork-epoch-platform.js").isRegisteredTestAdapter(a),false);
});
test("N1 real eight journal primitives: exclusive handles, readback, native file/path/link identity",t=>{
  const root=directory(t),a=storage(t,root),file=path.join(root,"journal.jsonl"),opened=a.createExclusiveFile(file);assert.equal(opened.ok,true,JSON.stringify(opened));assert.deepEqual(Object.keys(opened.fd),[]);
  assert.equal(a.readAll(opened.fd,1).bytes.length,0);
  assert.equal(a.append(opened.fd,Buffer.from("SYNTHETIC_N1_ONLY\n")).written,18);assert.equal(a.flush(opened.fd).ok,true);const read=a.readAll(opened.fd,1024);assert.equal(read.ok,true);assert.equal(read.bytes.toString(),"SYNTHETIC_N1_ONLY\n");
  const handle=a.statIdentity(opened.fd),byPath=a.statIdentityByPath(file);assert.equal(handle.ok,true);assert.equal(handle.nlink,1);for(const k of ["dev","ino","size","nlink","path"])assert.equal(handle[k],byPath[k]);assert.match(handle.ino,/^\d+$/);
  assert.throws(()=>fs.readFileSync(file));assert.throws(()=>fs.writeFileSync(file,"rollback"));assert.throws(()=>fs.appendFileSync(file,"extra"));assert.throws(()=>fs.renameSync(file,path.join(root,"replaced")));
  const again=a.createExclusiveFile(file);assert.equal(again.ok,false);assert.equal(again.code,"NATIVE_FILE_OPEN_FAILED");assert.ok([32,80,183].includes(again.nativeError));
  assert.equal(a.readAll(opened.fd,1).code,"NATIVE_READ_BOUND");assert.equal(a.statIdentity({}).code,"NATIVE_LEASE_INVALID");assert.equal(a.closeFile(opened.fd).ok,true);assert.equal(a.statIdentity(opened.fd).code,"NATIVE_LEASE_INVALID");assert.equal(a.createExclusiveFile(file).ok,false);
  const old=a.openReadonlyExisting(file);assert.equal(old.ok,true);assert.equal(a.readAll(old.fd,1024).bytes.toString(),"SYNTHETIC_N1_ONLY\n");assert.equal(a.closeFile(old.fd).ok,true);assert.equal(fs.readFileSync(file,"utf8"),"SYNTHETIC_N1_ONLY\n");
});
test("N1 second actual helper cannot open exclusive file; root rename is held by native directory handle",t=>{
  const root=directory(t),a=storage(t,root),b=storage(t,root),file=path.join(root,"exclusive.jsonl"),o=a.createExclusiveFile(file);assert.equal(o.ok,true);assert.equal(b.openReadonlyExisting(file).ok,false);assert.throws(()=>fs.renameSync(root,root+"-moved"));assert.equal(a.closeFile(o.fd).ok,true);const r=b.openReadonlyExisting(file);assert.equal(r.ok,true);assert.equal(b.closeFile(r.fd).ok,true);
});
test("N1 readonly import rejects multiple links and enforces native read bound",t=>{
  const root=directory(t),a=storage(t,root),file=path.join(root,"import.jsonl"),link=path.join(root,"hardlink.jsonl");fs.writeFileSync(file,"SYNTHETIC_IMPORT_ONLY");fs.linkSync(file,link);const refused=a.openReadonlyExisting(file);assert.equal(refused.ok,false);assert.equal(refused.code,"NATIVE_FILE_BINDING_CHANGED");fs.unlinkSync(link);
  const ok=a.openReadonlyExisting(file);assert.equal(ok.ok,true);assert.equal(a.statIdentity(ok.fd).nlink,1);assert.equal(a.closeFile(ok.fd).ok,true);
  const large=path.join(root,"large.jsonl");fs.writeFileSync(large,Buffer.alloc(786433));const r=a.openReadonlyExisting(large);assert.equal(r.ok,true);assert.equal(a.readAll(r.fd,786432).code,"NATIVE_READ_BOUND");assert.equal(a.closeFile(r.fd).ok,true);
});
test("N1 actual host command schemas reject caller clocks; containment creates nothing",async t=>{
  const root=directory(t),made=bridge.createNativeStorageTransport({root,timeoutMs:2000,startupTimeoutMs:30000,qualificationDelayMs:0});assert.equal(made.ok,true);const transport=made.transport;t.after(async()=>{const r=await transport.stop();assert.equal(r.ok,true);dispositions.push({kind:"RAW_SCHEMA_HOST",pid:transport.snapshot().ownedHelperPid,helperExited:transport.snapshot().helperExited,workerExited:transport.snapshot().workerExited});});
  const before=fs.readdirSync(root);assert.equal(transport.command("CLOCK_SAMPLE",{nowUtcMs:1}).code,"NATIVE_COMMAND_INVALID");assert.equal(transport.command("HELLO",{nativeReady:true}).code,"NATIVE_COMMAND_INVALID");for(const command of ["ESTABLISH","RESUME","WAIT","CANCEL","TREE_VERIFY","JOB_CLOSE"])assert.equal(transport.command(command,{}).code,"NATIVE_CONTAINMENT_UNIMPLEMENTED");assert.deepEqual(fs.readdirSync(root),before);assert.equal(transport.command("CLOCK_SAMPLE",{}).status,"RESPONSE");
});
test("N1 native temporary path/reparse refusal without redirect or truncate",async t=>{
  const root=directory(t),a=storage(t,root);assert.equal(a.createExclusiveFile(path.join(root,"..","not-owned.jsonl")).code,"NATIVE_PATH_REFUSED");assert.equal(a.createExclusiveFile(path.join(root,"subdir","not-owned.jsonl")).code,"NATIVE_PATH_REFUSED");
  for(const name of ["NUL","CON.txt","file.jsonl.","file.jsonl:stream"]){assert.equal(a.createExclusiveFile(path.join(root,name)).code,"NATIVE_PATH_REFUSED");}
  const target=directory(t),junction=path.join(root,"junction");fs.symlinkSync(target,junction,"junction");t.after(()=>{try{fs.rmdirSync(junction);}catch{}});
  const made=native.createNativeStorageAdapter({root:junction,timeoutMs:2000,startupTimeoutMs:30000,qualificationDelayMs:0});assert.equal(made.ok,false);assert.equal(made.nativeStartup.code,"NATIVE_REPARSE_ANCESTOR");assert.equal((await made.cleanup()).ok,true);const s=made.supervision();dispositions.push({kind:"REPARSE_REFUSAL_HOST",pid:s.ownedHelperPid,helperExited:s.helperExited,helperExitCode:s.helperExitCode,workerExited:s.workerExited});
});
test("N1 mutex concurrent exclusion and normal release",t=>{const root=directory(t),a=storage(t,root),b=storage(t,root);assert.equal(a.acquireMutex().acquired,true);assert.equal(b.acquireMutex().acquired,false);assert.equal(a.releaseMutex().released,true);assert.equal(b.acquireMutex().acquired,true);assert.equal(b.releaseMutex().released,true);});
test("N1 real helper death abandons retained mutex; surviving latch never grants recovery",async t=>{
  const root=directory(t),a=storage(t,root),b=storage(t,root);assert.equal(a.acquireMutex().acquired,true);assert.equal(b.acquireMutex().acquired,false);a.terminateOwnedHelper(0);await new Promise(r=>setTimeout(r,180));assert.equal(a.sampleClock().ok,false);assert.equal(a.supervision().helperExited,true);
  const abandoned=b.acquireMutex();assert.equal(abandoned.ok,false);assert.equal(abandoned.code,"ABANDONED_OWNER_MUTEX");assert.equal(b.acquireMutex().code,"ABANDONED_OWNER_MUTEX");
  assert.equal(b.createExclusiveFile(path.join(root,"blocked-after-abandon.jsonl")).code,"ABANDONED_OWNER_MUTEX");assert.equal(fs.existsSync(path.join(root,"blocked-after-abandon.jsonl")),false);
  const c=storage(t,root);assert.equal(c.acquireMutex().acquired,true);assert.equal(c.releaseMutex().released,true); // Non-sticky kernel limitation, not new-epoch recovery authority.
});
for(const inflight of [false,true])test("N1 actual helper death "+(inflight?"inflight":"idle")+" terminal, no restart",async t=>{
  const a=storage(t,undefined,{qualificationDelayMs:inflight?600:0}),pid=a.supervision().ownedHelperPid;a.terminateOwnedHelper(inflight?50:0);
  if(!inflight)await new Promise(r=>setTimeout(r,180));const start=performance.now(),r=a.sampleClock();assert.equal(r.code,"HELPER_LOST");assert.ok(performance.now()-start<2000);assert.equal(a.sampleClock().code,"HELPER_LOST");assert.equal(a.supervision().ownedHelperPid,pid);assert.equal(a.supervision().helperExited,true);
});
test("N1 injected clock response delay makes timeout terminal and exact helper exit bounded",async t=>{
  const a=storage(t,undefined,{timeoutMs:100,qualificationDelayMs:600}),start=performance.now(),r=a.sampleClock();assert.equal(r.code,"TIMEOUT");assert.ok(performance.now()-start<1000);assert.equal(a.sampleClock().code,"TIMEOUT");await new Promise(r=>setTimeout(r,180));assert.equal(a.supervision().helperExited,true);
});
test("N1 actual parent spoof rejected by native inherited parent check",async t=>{
  const root=directory(t),pipe="\\\\.\\pipe\\evm-epoch-native-"+require("node:crypto").randomBytes(16).toString("hex"),child=spawn(ps,["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",host,"-Root",root,"-PipeName",pipe,"-ParentPid",String(process.pid+100000)],{env:env(root),windowsHide:true,stdio:["ignore","pipe","pipe"]});child.stderr.resume();const frame=await firstFrame(child),exit=await waitExit(child);assert.equal(frame.code,"NATIVE_PARENT_MISMATCH");assert.notEqual(exit.code,0);dispositions.push({kind:"SPOOF_REFUSAL_HOST",pid:child.pid,exit:exit.code});
});
test("N1 pre-existing fake pipe cannot impersonate owned native FIRST_INSTANCE server",async t=>{
  const root=directory(t),pipe="\\\\.\\pipe\\evm-epoch-native-"+require("node:crypto").randomBytes(16).toString("hex");let connections=0;const server=require("node:net").createServer(s=>{++connections;s.destroy();});await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(pipe,resolve);});t.after(()=>new Promise(resolve=>server.close(resolve)));
  const child=spawn(ps,["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",host,"-Root",root,"-PipeName",pipe,"-ParentPid",String(process.pid)],{env:env(root),windowsHide:true,stdio:["ignore","pipe","pipe"]});child.stderr.resume();const frame=await firstFrame(child),e=await waitExit(child);assert.equal(frame.code,"NATIVE_PIPE_CREATE_FAILED");assert.equal(frame.nativeError,5);assert.equal(connections,0);assert.notEqual(e.code,0);dispositions.push({kind:"FAKE_PIPE_REFUSAL_HOST",pid:child.pid,exit:e.code,nativeError:frame.nativeError});
});
test("N1 native client PID check refuses a foreign same-user Node process before commands",async t=>{
  const root=directory(t),pipe="\\\\.\\pipe\\evm-epoch-native-"+require("node:crypto").randomBytes(16).toString("hex"),helper=spawn(ps,["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",host,"-Root",root,"-PipeName",pipe,"-ParentPid",String(process.pid)],{env:env(root),windowsHide:true,stdio:["ignore","pipe","pipe"]});helper.stderr.resume();const frame=await firstFrame(helper);assert.equal(frame.schema,"trigger-fork-native-startup/v1");
  const script=path.join(root,"foreign-client.js");fs.writeFileSync(script,`const s=require('net').createConnection(${JSON.stringify(pipe)});s.on('error',()=>{});s.on('close',()=>process.exit(0));setTimeout(()=>process.exit(2),4000);`);const client=spawn(process.execPath,[script],{env:env(root),windowsHide:true,stdio:"ignore"});const a=await waitExit(helper),b=await waitExit(client);assert.equal(a.code,3);assert.equal(b.code,0);dispositions.push({kind:"FOREIGN_CLIENT_REFUSAL_HOST",pid:helper.pid,creationTime100ns:frame.helper.creationTime100ns,exit:a.code});dispositions.push({kind:"OWNED_FOREIGN_TEST_CLIENT",pid:client.pid,exit:b.code});
});
for(const kind of ["duplicate","unsafe","unknown-field"])test("N1 actual native framed parser rejects "+kind+" without raw echo",async t=>{
  const root=directory(t),pipe="\\\\.\\pipe\\evm-epoch-native-"+require("node:crypto").randomBytes(16).toString("hex"),child=spawn(ps,["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",host,"-Root",root,"-PipeName",pipe,"-ParentPid",String(process.pid)],{env:env(root),windowsHide:true,stdio:["ignore","pipe","pipe"]});child.stderr.resume();const startup=await firstFrame(child);assert.equal(startup.schema,"trigger-fork-native-startup/v1");const socket=require("node:net").createConnection(pipe);socket.on("error",()=>{});await new Promise(resolve=>socket.once("connect",resolve));
  const text=kind==="duplicate"?'{"command":"HELLO","id":1,"id":1,"payload":{},"schema":"trigger-fork-native-request/v1"}':kind==="unsafe"?'{"command":"HELLO","id":9007199254740993,"payload":{},"schema":"trigger-fork-native-request/v1"}':'{"command":"HELLO","extra":0,"id":1,"payload":{},"schema":"trigger-fork-native-request/v1"}';
  const body=Buffer.from(text),frame=Buffer.alloc(body.length+4);frame.writeUInt32LE(body.length);body.copy(frame,4);let output=0;socket.on("data",b=>{output+=b.length;});socket.write(frame);const e=await waitExit(child);socket.destroy();assert.equal(e.code,3);assert.equal(output,0);dispositions.push({kind:"NATIVE_PROTOCOL_REFUSAL_HOST",case:kind,pid:child.pid,creationTime100ns:startup.helper.creationTime100ns,exit:e.code});
});
test("N1 native parent-handle death releases actual service; observer holds process handle only",async t=>{
  const root=directory(t),script=path.join(root,"node-owner.js");fs.writeFileSync(script,`"use strict";const n=require(${JSON.stringify(require.resolve("../lib/trigger-fork-epoch-native-adapter.js"))});const r=n.createNativeStorageAdapter({root:__dirname,timeoutMs:2000,startupTimeoutMs:30000,qualificationDelayMs:0});if(!r.ok){console.log(JSON.stringify({error:r.code}));process.exit(2);}const a=r.adapter;const o=a.createExclusiveFile(require('path').join(__dirname,'parent-owned.jsonl'));if(!o.ok)process.exit(3);console.log(JSON.stringify({helper:a.supervision().nativeStartup.helper}));setInterval(()=>{},1000);`);
  const child=spawn(process.execPath,[script],{env:env(root),windowsHide:true,stdio:["ignore","pipe","pipe"]});child.stderr.resume();const next=lines(child);t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();const e=await waitExit(child);dispositions.push({kind:"NODE_PARENT",pid:child.pid,exit:e.code,signal:e.signal});});
  const first=await next();assert.ok(first.helper,JSON.stringify(first));const observed=await observer(t,root,first.helper),start=performance.now();child.kill();await waitExit(child);assert.equal((await observed.next()).exited,true);assert.ok(performance.now()-start<5000);assert.equal((await waitExit(observed.child)).code,0);assert.doesNotThrow(()=>fs.readFileSync(path.join(root,"parent-owned.jsonl")));
  dispositions.push({kind:"PARENT_DEATH_NATIVE_HOST",pid:first.helper.pid,creationTime100ns:first.helper.creationTime100ns,processHandleObservedExit:true});
});
test("N1 actual transport-worker loss releases native handles, but API retains HELD uncertainty",async t=>{
  const root=directory(t),made=native.createNativeStorageAdapter({root,timeoutMs:2000,startupTimeoutMs:30000,qualificationDelayMs:0});assert.equal(made.ok,true);const a=made.adapter,s=a.supervision(),file=path.join(root,"worker-owned.jsonl");assert.equal(a.createExclusiveFile(file).ok,true);const observed=await observer(t,root,s.nativeStartup.helper);
  await a.loseTransportForQualification();assert.equal(a.sampleClock().code,"WORKER_LOST");assert.equal((await observed.next()).exited,true);assert.equal((await waitExit(observed.child)).code,0);assert.doesNotThrow(()=>fs.readFileSync(file));
  const stopped=await a.dispose();assert.equal(stopped.ok,false);assert.equal(stopped.code,"HELPER_EXIT_UNCONFIRMED");assert.equal(a.supervision().state,"TERMINAL");
  dispositions.push({kind:"WORKER_LOSS_NATIVE_HOST",pid:s.ownedHelperPid,creationTime100ns:s.nativeStartup.helper.creationTime100ns,processHandleObservedExit:true,apiDisposition:"HELD_HELPER_EXIT_UNCONFIRMED"});
});
test("N2 JOB_LIST creates suspended exact dummy, source pinned, resume then true tree0",t=>{
  const h=dummy(t),r=h.establish();assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.creationAssociation,"PROC_THREAD_ATTRIBUTE_JOB_LIST");assert.equal(r.phase,"SUSPENDED");assert.deepEqual(Object.keys(r.containment),[]);assert.equal(fs.existsSync(r.markerPath),false);assert.throws(()=>fs.writeFileSync(h.options.scriptPath,"swap"));assert.throws(()=>fs.renameSync(h.options.scriptPath,h.options.scriptPath+".old"));
  assert.equal(h.a.resumeDummy(r.containment).ok,true);const v=treeUntil(h.a,r.containment,v=>v.treeZero);assert.equal(v.phase,"COMPLETED_DUMMY_ONLY");assert.equal(v.rootExitCode,0);assert.equal(v.activeProcesses,0);assert.equal(v.uncertain,false);assert.equal(fs.existsSync(r.markerPath),true);assert.equal(h.a.closeDummy(r.containment).treeZero,true);dispositions.push({kind:"N2_DUMMY_PROCESS",checkpoint:"NORMAL_EXIT",...r.root,treeZero:true});
});
test("N2 copied/foreign token, duplicate resume and second in-flight creation refuse",t=>{
  const h=dummy(t,"STUCK"),r=h.establish(),other=storage(t);assert.equal(r.ok,true);assert.equal(h.a.resumeDummy({...r.containment}).code,"NATIVE_CONTAINMENT_TOKEN_INVALID");assert.equal(other.resumeDummy(r.containment).code,"NATIVE_CONTAINMENT_TOKEN_INVALID");assert.equal(h.establish().ok,false);assert.equal(h.a.resumeDummy(r.containment).ok,true);assert.equal(h.a.resumeDummy(r.containment).ok,false);assert.equal(h.a.cancelDummy(r.containment).treeZero,true);assert.equal(h.a.closeDummy(r.containment).treeZero,true);
});
for(const fault of ["JOB_CREATE","LIMITS","JOB_LIST","CREATE","RESUME"])test("N2 controlled INJECTED "+fault+" cannot run marker",t=>{
  const h=dummy(t,"EXIT",10000,fault),r=h.establish();if(fault==="RESUME"){assert.equal(r.ok,true);assert.equal(h.a.resumeDummy(r.containment).code,"INJECTED_N2_RESUME");assert.equal(fs.existsSync(r.markerPath),false);assert.equal(h.a.cancelDummy(r.containment).treeZero,true);h.a.closeDummy(r.containment);}else{assert.equal(r.ok,false);assert.equal(r.code,"INJECTED_N2_"+fault);assert.deepEqual(fs.readdirSync(h.root).filter(n=>n.startsWith("n2-marker-")),[]);}
});
test("N2 shape/digest/source/path/executable swaps refuse before dummy side effects",t=>{
  const h=dummy(t);for(const patch of [{scope:"REAL_EVM"},{executable:process.execPath},{sourceQualified:true},{scriptDigest:"0".repeat(64)},{scriptPath:path.join(h.root,"..","n2-dummy.js")},{mode:"REAL_FORK"}]){const r=h.a.establishDummy({...h.options,...patch});assert.equal(r.ok,false);}
  fs.writeFileSync(h.options.scriptPath,h.d.source.replace('use strict','USE strict'));assert.equal(h.establish().code,"NATIVE_DUMMY_DIGEST");assert.deepEqual(fs.readdirSync(h.root).filter(n=>n.startsWith("n2-marker-")),[]);
});
test("N2 expired establishment/resume never executes marker and cannot rearm",async t=>{
  const h=dummy(t,"EXIT",250),s=h.a.sampleClock();assert.equal(h.a.establishDummy({...h.options,deadlineUtcMs:s.nowUtcMs-1}).code,"NATIVE_DUMMY_DEADLINE_INVALID");const r=h.establish();assert.equal(r.ok,true);await new Promise(resolve=>setTimeout(resolve,400));assert.equal(h.a.resumeDummy(r.containment).ok,false);assert.equal(fs.existsSync(r.markerPath),false);const v=h.a.treeDummy(r.containment);assert.equal(v.expired,true);assert.equal(v.uncertain,true);assert.equal(v.treeZero,true);assert.equal(h.establish().ok,false);
});
test("N2 independent watchdog terminates stuck child while main thread idle in IPC wait",async t=>{
  const h=dummy(t,"STUCK",300),r=h.establish();assert.equal(r.ok,true);h.a.resumeDummy(r.containment);await new Promise(resolve=>setTimeout(resolve,650));const v=h.a.treeDummy(r.containment);assert.equal(v.treeZero,true);assert.equal(v.expired,true);assert.equal(v.phase,"EXPIRED_HELD");assert.equal(v.rootExited,true);assert.equal(v.uncertain,true);dispositions.push({kind:"N2_DUMMY_PROCESS",checkpoint:"NATIVE_DEADLINE",...r.root,treeZero:true,expired:true});
});
test("N2 exit0 parent is not tree0; grandchild inherits job and CANCEL verifies whole tree",t=>{
  const h=dummy(t,"ORPHAN"),r=h.establish();assert.equal(r.ok,true);h.a.resumeDummy(r.containment);const v=treeUntil(h.a,r.containment,v=>v.rootExited&&v.activeProcesses>0);assert.equal(v.rootExitCode,0);assert.equal(v.treeZero,false);assert.equal(h.a.closeDummy(r.containment).code,"NATIVE_TREE_NOT_ZERO");const cancelled=h.a.cancelDummy(r.containment);assert.equal(cancelled.treeZero,true);assert.equal(cancelled.uncertain,true);assert.ok(cancelled.members.length>=2);assert.equal(h.a.closeDummy(r.containment).treeZero,true);for(const m of cancelled.members)dispositions.push({kind:"N2_DUMMY_PROCESS",checkpoint:"ORPHAN_CANCEL",pid:m.pid,creationTime100ns:m.creationTime100ns,treeZero:true,exited:m.exited});
});
test("N2 native breakaway attempt cannot escape actual job (including nested Node job)",t=>{
  const h=dummy(t,"BREAKAWAY",15000),r=h.establish();assert.equal(r.ok,true);h.a.resumeDummy(r.containment);const proof=treeUntil(h.a,r.containment,v=>!!v.breakawayEvidence,6000).breakawayEvidence;assert.equal(proof.escaped,false);assert.ok(["CREATE_PROCESS_REFUSED","FLAG_ACCEPTED_OUTER_JOB_RETAINED"].includes(proof.classification));assert.equal(fs.existsSync(r.markerPath+".escaped"),false);const v=treeUntil(h.a,r.containment,v=>v.treeZero,6000);assert.equal(v.rootExitCode,0);h.a.closeDummy(r.containment);dispositions.push({kind:"N2_BREAKAWAY_OBSERVATION",...proof,treeZero:true});
});
for(const resumed of [false,true])test("N2 helper kill "+(resumed?"after resume":"after creation before resume")+" kills exact dummy tree",async t=>{
  const h=dummy(t,resumed?"TREE":"STUCK",15000),r=h.establish();assert.equal(r.ok,true);let members=[r.root];if(resumed){h.a.resumeDummy(r.containment);members=treeUntil(h.a,r.containment,v=>v.members.length>=2).members;}
  const watched=await observeMembers(t,h,members);if(!resumed)assert.equal(fs.existsSync(r.markerPath),false);h.a.terminateOwnedHelper(0);await exitedMembers(watched,resumed?"HELPER_LOSS_RUNNING":"HELPER_LOSS_SUSPENDED");assert.equal(h.a.sampleClock().code,"HELPER_LOST");if(!resumed)assert.equal(fs.existsSync(r.markerPath),false);
});
test("N2 pure LAST job-handle close is separate from CANCEL and remains API HELD",async t=>{
  const h=dummy(t,"TREE",15000),r=h.establish();h.a.resumeDummy(r.containment);const members=treeUntil(h.a,r.containment,v=>v.members.length>=2).members,watched=await observeMembers(t,h,members);const closed=h.a.closeDummy(r.containment,"PURE_LAST_HANDLE");assert.equal(closed.ok,true);assert.equal(closed.treeZero,false);assert.equal(closed.phase,"LAST_HANDLE_CLOSED_HELD");assert.equal(closed.uncertain,true);await exitedMembers(watched,"PURE_LAST_JOB_HANDLE");const v=h.a.treeDummy(r.containment);assert.equal(v.observedHandlesExited,true);assert.equal(v.treeZero,false);assert.equal(h.establish().ok,false);
});
test("N2 unrelated same-image owned decoy survives exact job cancellation",async t=>{
  const h=dummy(t,"TREE"),script=path.join(h.root,"decoy.js");fs.writeFileSync(script,"setInterval(()=>{},1000);\n");const decoy=spawn(process.execPath,[script],{env:env(h.root),windowsHide:true,stdio:"ignore"});t.after(async()=>{decoy.kill();const e=await waitExit(decoy);dispositions.push({kind:"N2_UNRELATED_OWNED_DECOY",pid:decoy.pid,exit:e.code,signal:e.signal});});
  const r=h.establish();h.a.resumeDummy(r.containment);treeUntil(h.a,r.containment,v=>v.members.length>=2);assert.equal(h.a.cancelDummy(r.containment).treeZero,true);assert.equal(decoy.exitCode,null);assert.equal(decoy.signalCode,null);h.a.closeDummy(r.containment);
});
test("N2 actual Node parent death during work kills root and grandchild via sole job handle",async t=>{
  const root=directory(t),script=path.join(root,"n2-node-owner.js"),modulePath=require.resolve("../lib/trigger-fork-epoch-native-adapter.js");
  fs.writeFileSync(script,`const fs=require('fs'),p=require('path'),n=require(${JSON.stringify(modulePath)});const made=n.createNativeStorageAdapter({root:__dirname,timeoutMs:2500,startupTimeoutMs:30000,qualificationDelayMs:0});if(!made.ok)process.exit(2);const a=made.adapter,d=a.describeDummy();fs.writeFileSync(p.join(__dirname,d.filename),d.source);fs.writeFileSync(p.join(__dirname,d.companion.filename),d.companion.source);const s=a.sampleClock(),r=a.establishDummy({mode:'TREE',scriptPath:p.join(__dirname,d.filename),scriptDigest:d.digest,deadlineUtcMs:s.nowUtcMs+15000,deadlineMonotonicMs:s.monotonicNowMs+15000,cleanupBudgetMs:1000,fault:'NONE'});if(!r.ok)process.exit(3);a.resumeDummy(r.containment);let v;for(let i=0;i<20;i++){v=a.waitDummy(r.containment,100);if(v.members.length>=2)break;}console.log(JSON.stringify({helper:a.supervision().nativeStartup.helper,members:v.members}));setInterval(()=>{},1000);`);
  const child=spawn(process.execPath,[script],{env:env(root),windowsHide:true,stdio:["ignore","pipe","pipe"]});child.stderr.resume();const next=lines(child);t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();const e=await waitExit(child);dispositions.push({kind:"N2_NODE_PARENT",pid:child.pid,exit:e.code,signal:e.signal});});
  const first=await next();assert.ok(first.members.length>=2);const watched=await observeMembers(t,{root},[first.helper,...first.members]);child.kill();await waitExit(child);await exitedMembers(watched,"NODE_PARENT_DEATH_WORKING");
});
test("N2 actual worker loss during work cleans tree but cannot clear API HELD",async t=>{
  const root=directory(t),made=native.createNativeStorageAdapter({root,timeoutMs:2500,startupTimeoutMs:30000,qualificationDelayMs:0});assert.equal(made.ok,true);const a=made.adapter;let lost=false;t.after(async()=>{const r=await a.dispose();assert.equal(r.ok,!lost);});
  const d=a.describeDummy();fs.writeFileSync(path.join(root,d.filename),d.source);fs.writeFileSync(path.join(root,d.companion.filename),d.companion.source);const s=a.sampleClock(),r=a.establishDummy({mode:"TREE",scriptPath:path.join(root,d.filename),scriptDigest:d.digest,deadlineUtcMs:s.nowUtcMs+15000,deadlineMonotonicMs:s.monotonicNowMs+15000,cleanupBudgetMs:1000,fault:"NONE"});assert.equal(r.ok,true);a.resumeDummy(r.containment);const members=treeUntil(a,r.containment,v=>v.members.length>=2).members,watched=await observeMembers(t,{root},[a.supervision().nativeStartup.helper,...members]);lost=true;await a.loseTransportForQualification();assert.equal(a.sampleClock().code,"WORKER_LOST");await exitedMembers(watched,"WORKER_DEATH_WORKING");const result=await a.dispose();assert.equal(result.ok,false);assert.equal(result.code,"HELPER_EXIT_UNCONFIRMED");
});
