"use strict";
// Two separate paths: legacy unqualified pipe tests, and N1 actual persistent
// native storage bootstrap/supervision. Neither registers an epoch platform or
// authorizes source work/activation. Containment/controller follow separately.
const {Worker,isMainThread,parentPort,workerData}=require("node:worker_threads");
const {parseStrictJson,canonicalize}=require("./evm-call-inventory-v2/canonical.js");
const MAX_FRAME_BYTES=1100000,MAX_TIMEOUT_MS=30000,MAX_DEPTH=12;
const REQUEST_SCHEMA="trigger-fork-native-request/v1",RESPONSE_SCHEMA="trigger-fork-native-response/v1";
const COMMANDS=Object.freeze(["HELLO","JOURNAL_OPEN","JOURNAL_APPEND","JOURNAL_FLUSH","JOURNAL_READ","JOURNAL_IDENTITY","JOURNAL_PATH_IDENTITY","JOURNAL_CLOSE","MUTEX_ACQUIRE","MUTEX_RELEASE","CLOCK_SAMPLE","ESTABLISH","RESUME","WAIT","CANCEL","TREE_VERIFY","JOB_CLOSE","EXIT"]);
const CODES=Object.freeze(["NONE","PROTOCOL_INVALID","PROTOCOL_OVERSIZE","PROTOCOL_DESYNC","TIMEOUT","TRANSPORT_LOST","WORKER_LOST","CLOSED","HELPER_LOST","NATIVE_HOST_START_FAILED","PEER_IDENTITY_MISMATCH"]);
const INIT=0,READY=1,REQUEST=2,RESPONSE=3,TERMINAL=4;
const STATE=0,CODE=1,LENGTH=2;
const HELPER_EXITED=3,HELPER_EXIT_CODE=4,HELPER_PID=5;
function error(code){throw new Error(code);}
function exact(o,keys){
  if(!o||![Object.prototype,null].includes(Object.getPrototypeOf(o))||Reflect.ownKeys(o).length!==keys.length)error("PROTOCOL_INVALID");
  for(const k of Reflect.ownKeys(o)){const d=Object.getOwnPropertyDescriptor(o,k);if(!keys.includes(k)||!d.enumerable||!("value"in d))error("PROTOCOL_INVALID");}
}
function data(value,depth=0,budget={nodes:0}){
  if(depth>MAX_DEPTH||++budget.nodes>32768)error("PROTOCOL_INVALID");
  if(value===null||typeof value==="boolean")return;
  if(typeof value==="number"){if(!Number.isSafeInteger(value))error("PROTOCOL_INVALID");return;}
  if(typeof value==="string"){if(Buffer.byteLength(value)>MAX_FRAME_BYTES)error("PROTOCOL_OVERSIZE");return;}
  if(!value||typeof value!=="object"||(!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value))))error("PROTOCOL_INVALID");
  const keys=Reflect.ownKeys(value).filter(k=>!(Array.isArray(value)&&k==="length"));if(keys.length>4096)error("PROTOCOL_INVALID");
  if(Array.isArray(value)&&(keys.length!==value.length||keys.some((k,i)=>k!==String(i))))error("PROTOCOL_INVALID");
  for(const k of keys){const d=Object.getOwnPropertyDescriptor(value,k);if(typeof k!=="string"||!d.enumerable||!("value"in d)||["__proto__","constructor","prototype","toJSON"].includes(k))error("PROTOCOL_INVALID");data(d.value,depth+1,budget);}
}
function validate(value,kind){
  data(value);
  if(kind==="request"){
    exact(value,["schema","id","command","payload"]);
    if(value.schema!==REQUEST_SCHEMA||!COMMANDS.includes(value.command)||!value.payload||![Object.prototype,null].includes(Object.getPrototypeOf(value.payload)))error("PROTOCOL_INVALID");
  }else if(kind==="response"){
    exact(value,["schema","id","status","result","code","nativeError"]);
    if(value.schema!==RESPONSE_SCHEMA||!["RESPONSE","ERROR"].includes(value.status))error("PROTOCOL_INVALID");
    if(value.status==="RESPONSE"?(value.code!==null||value.nativeError!==null):(typeof value.code!=="string"||!/^[A-Z][A-Z0-9_]{0,63}$/.test(value.code)||value.result!==null))error("PROTOCOL_INVALID");
    if(value.nativeError!==null&&(!Number.isSafeInteger(value.nativeError)||value.nativeError<0||value.nativeError>4294967295))error("PROTOCOL_INVALID");
  }else error("PROTOCOL_INVALID");
  if(!Number.isSafeInteger(value.id)||value.id<1||value.id>1000000)error("PROTOCOL_INVALID");
  return value;
}
function encodeFrame(value,kind){
  validate(value,kind);const body=Buffer.from(canonicalize(value),"utf8");if(!body.length||body.length>MAX_FRAME_BYTES)error("PROTOCOL_OVERSIZE");
  const frame=Buffer.allocUnsafe(body.length+4);frame.writeUInt32LE(body.length);body.copy(frame,4);return frame;
}
function decodeFrame(frame,kind){
  if(!Buffer.isBuffer(frame)||frame.length<4)error("PROTOCOL_INVALID");const length=frame.readUInt32LE(0);
  if(!length||length>MAX_FRAME_BYTES)error("PROTOCOL_OVERSIZE");if(frame.length!==length+4)error("PROTOCOL_INVALID");
  const body=frame.subarray(4),text=body.toString("utf8");if(!Buffer.from(text,"utf8").equals(body))error("PROTOCOL_INVALID");
  // Bound nesting before recursive parsing; no getters/thenables are evaluated.
  let depth=0,quoted=false,escape=false;for(const c of text){if(quoted){if(escape)escape=false;else if(c==="\\")escape=true;else if(c==='"')quoted=false;}else if(c==='"')quoted=true;else if(c==="{"||c==="["){if(++depth>MAX_DEPTH)error("PROTOCOL_INVALID");}else if(c==="}"||c==="]")--depth;}
  let value;try{value=parseStrictJson(text);}catch{error("PROTOCOL_INVALID");}
  validate(value,kind);if(canonicalize(value)!==text)error("PROTOCOL_INVALID");return value;
}
function freeze(o){if(o&&typeof o==="object"){Object.values(o).forEach(freeze);Object.freeze(o);}return o;}
const nowNs=()=>process.hrtime.bigint();
function terminal(control,code){
  const n=CODES.indexOf(code);Atomics.compareExchange(control,CODE,0,n>0?n:CODES.indexOf("PROTOCOL_INVALID"));
  Atomics.store(control,STATE,TERMINAL);Atomics.notify(control,STATE);
}
function runWorker(){
  const net=require("node:net"),control=new Int32Array(workerData.control),bytes=new Uint8Array(workerData.bytes);
  let socket=null,pending=null,input=Buffer.alloc(0),timer=null,finished=false,child=null,expectedExit=false,killTimer=null,lossTimer=null;
  function end(code){
    if(finished)return;finished=true;clearTimeout(timer);if(pending)clearTimeout(pending.timer);pending=null;
    terminal(control,code);if(socket)socket.destroy();clearTimeout(killTimer);clearTimeout(lossTimer);
    if(child&&!Atomics.load(control,HELPER_EXITED))child.kill(); // exact owned libuv process handle, never PID sweep
    parentPort.close();
  }
  function arm(deadline,fn){const remaining=Number((deadline-nowNs()+999999n)/1000000n);return setTimeout(fn,Math.max(0,Math.min(MAX_TIMEOUT_MS,remaining)));}
  timer=arm(workerData.deadline,()=>end("TIMEOUT"));
  function connect(){socket=net.createConnection(workerData.pipeName);
  const lost=()=>{if(expectedExit||finished)return;if(child){if(!lossTimer)lossTimer=setTimeout(()=>end(Atomics.load(control,HELPER_EXITED)?"HELPER_LOST":"TRANSPORT_LOST"),100);}else end("TRANSPORT_LOST");};
  socket.on("error",lost);socket.on("close",lost);
  socket.on("connect",()=>{
    clearTimeout(timer);if(Atomics.load(control,STATE)===TERMINAL){end("TIMEOUT");return;}
    Atomics.store(control,STATE,READY);Atomics.notify(control,STATE);
  });
  socket.on("data",chunk=>{
    if(finished)return;if(!pending){end("PROTOCOL_DESYNC");return;}
    if(input.length+chunk.length>MAX_FRAME_BYTES+4){end("PROTOCOL_OVERSIZE");return;}
    input=Buffer.concat([input,chunk]);if(input.length<4)return;
    const n=input.readUInt32LE(0);if(!n||n>MAX_FRAME_BYTES){end("PROTOCOL_OVERSIZE");return;}if(input.length<n+4)return;
    // Multiple/coalesced responses are rejected before publishing the first.
    if(input.length!==n+4){end("PROTOCOL_DESYNC");return;}
    if(nowNs()>=pending.deadline){end("TIMEOUT");return;}
    try{
      const value=decodeFrame(input,"response");if(value.id!==pending.id){end("PROTOCOL_DESYNC");return;}
      bytes.set(input);Atomics.store(control,LENGTH,input.length);clearTimeout(pending.timer);pending=null;input=Buffer.alloc(0);
      if(Atomics.compareExchange(control,STATE,REQUEST,RESPONSE)!==REQUEST){end("TIMEOUT");return;}Atomics.notify(control,STATE);
    }catch(e){end(CODES.includes(e.message)?e.message:"PROTOCOL_INVALID");}
  });
  }
  if(workerData.nativeBootstrap){
    const path=require("node:path"),{spawn}=require("node:child_process"),b=workerData.nativeBootstrap;
    const env={SystemRoot:process.env.SystemRoot,WINDIR:process.env.SystemRoot,ComSpec:path.join(process.env.SystemRoot,"System32","cmd.exe"),LOCALAPPDATA:process.env.LOCALAPPDATA,TEMP:b.root,TMP:b.root};
    const executable=path.join(process.env.SystemRoot,"System32","WindowsPowerShell","v1.0","powershell.exe");
    const script=path.join(__dirname,"..","trigger-fork-epoch-native-host.ps1");
    child=spawn(executable,["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",script,"-Root",b.root,"-PipeName",workerData.pipeName,"-ParentPid",String(process.pid),"-QualificationDelayMs",String(b.qualificationDelayMs)],{env,windowsHide:true,stdio:[b.inheritConsole===true?0:"ignore","pipe","pipe"]});
    Atomics.store(control,HELPER_PID,child.pid||0);let startup=Buffer.alloc(0),attested=false,stderrBytes=0;
    child.on("error",()=>end("NATIVE_HOST_START_FAILED"));
    child.on("exit",(code)=>{Atomics.store(control,HELPER_EXIT_CODE,code===null?-1:code);Atomics.store(control,HELPER_EXITED,1);Atomics.notify(control,HELPER_EXITED);if(!expectedExit)end(attested?"HELPER_LOST":"NATIVE_HOST_START_FAILED");});
    child.stderr.on("data",chunk=>{stderrBytes+=chunk.length;if(stderrBytes>65536)end("NATIVE_HOST_START_FAILED");}); // discard, never echo compiler/environment text
    child.stdout.on("data",chunk=>{
      if(finished)return;if(attested||startup.length+chunk.length>8192){end("NATIVE_HOST_START_FAILED");return;}startup=Buffer.concat([startup,chunk]);if(startup.length<4)return;
      const n=startup.readUInt32LE(0);if(!n||n>8188){end("NATIVE_HOST_START_FAILED");return;}if(startup.length<n+4)return;if(startup.length!==n+4){end("NATIVE_HOST_START_FAILED");return;}
      try{
        const text=startup.subarray(4).toString("utf8"),value=parseStrictJson(text);data(value);if(canonicalize(value)!==text)error("PROTOCOL_INVALID");
        if(value.schema==="trigger-fork-native-startup-error/v1"){exact(value,["schema","code","nativeError"]);bytes.set(startup);Atomics.store(control,LENGTH,startup.length);end("NATIVE_HOST_START_FAILED");return;}
        exact(value,["schema","pipeName","helper","parent","pipeServerPid","peerEvidence","approvedBase"]);exact(value.helper,["pid","creationTime100ns"]);exact(value.parent,["pid","creationTime100ns"]);
        if(typeof value.approvedBase!=="string"||!path.isAbsolute(value.approvedBase)||!path.resolve(b.root).toLowerCase().startsWith(value.approvedBase.toLowerCase()+"\\"))error("PEER_IDENTITY_MISMATCH"); // trusted native KnownFolder attestation, never env authority
        if(value.schema!=="trigger-fork-native-startup/v1"||value.pipeName!==workerData.pipeName||value.helper.pid!==child.pid||value.parent.pid!==process.pid||value.pipeServerPid!==child.pid||value.peerEvidence!=="NATIVE_FIRST_INSTANCE_SERVER_PID_AND_CREATION_ATTESTED"||!/^\d{15,20}$/.test(value.helper.creationTime100ns)||!/^\d{15,20}$/.test(value.parent.creationTime100ns))error("PEER_IDENTITY_MISMATCH");
        bytes.set(startup);Atomics.store(control,LENGTH,startup.length);attested=true;connect();
      }catch(e){end(e.message==="PEER_IDENTITY_MISMATCH"?e.message:"NATIVE_HOST_START_FAILED");}
    });
  }else connect();
  parentPort.on("message",message=>{
    if(finished)return;if(message.kind==="close"){end("CLOSED");return;}
    if(message.kind==="terminate-helper"&&child){killTimer=setTimeout(()=>{if(!Atomics.load(control,HELPER_EXITED))child.kill();},message.delayMs);return;}
    if(message.kind!=="request"||pending||Atomics.load(control,STATE)!==REQUEST){end("PROTOCOL_DESYNC");return;}
    try{
      const length=Atomics.load(control,LENGTH);if(length<4||length>bytes.length)error("PROTOCOL_INVALID");
      const frame=Buffer.from(bytes.subarray(0,length)),value=decodeFrame(frame,"request");
      if(typeof message.deadline!=="bigint"||nowNs()>=message.deadline){end("TIMEOUT");return;}
      pending={id:value.id,deadline:message.deadline,timer:arm(message.deadline,()=>end("TIMEOUT"))};
      if(child&&value.command==="EXIT")expectedExit=true;
      socket.write(frame,error=>{if(error)end("TRANSPORT_LOST");}); // never retransmitted
    }catch(e){end(CODES.includes(e.message)?e.message:"PROTOCOL_INVALID");}
  });
}
function createTransport(options,nativeBootstrap=null){
  // Without private bootstrap this connects only to an unqualified peer. N1
  // bootstrap below binds the owned process/stdout and native pipe proof; no
  // branch can register an epoch platform or grant source/activation authority.
  exact(options,["pipeName","timeoutMs"]);
  if(typeof options.pipeName!=="string"||!/^\\\\\.\\pipe\\evm-epoch-native-[a-f0-9]{32}$/.test(options.pipeName)||!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<20||options.timeoutMs>MAX_TIMEOUT_MS)error("PROTOCOL_INVALID");
  const pipeName=options.pipeName,timeoutMs=options.timeoutMs,controlBuffer=new SharedArrayBuffer(32),dataBuffer=new SharedArrayBuffer(MAX_FRAME_BYTES+4),control=new Int32Array(controlBuffer),bytes=new Uint8Array(dataBuffer);
  const initialDeadline=nowNs()+BigInt(nativeBootstrap?nativeBootstrap.startupTimeoutMs:timeoutMs)*1000000n;
  const worker=new Worker(__filename,{workerData:{kind:"epoch-native-transport-worker/v1",pipeName,control:controlBuffer,bytes:dataBuffer,deadline:initialDeadline,nativeBootstrap}});
  let busy=false,id=0,workerExited=false,stopPromise=null;
  worker.on("error",()=>terminal(control,"WORKER_LOST"));worker.on("exit",()=>{workerExited=true;terminal(control,"WORKER_LOST");});
  worker.unref();
  function wait(state,deadline){while(Atomics.load(control,STATE)===state){const remaining=Number(deadline-nowNs())/1000000;if(remaining<=0){terminal(control,"TIMEOUT");worker.postMessage({kind:"close"});break;}Atomics.wait(control,STATE,state,remaining);}return Atomics.load(control,STATE);}
  const startup=wait(INIT,initialDeadline);
  let nativeStartup=null;
  if(nativeBootstrap&&Atomics.load(control,LENGTH)>4){try{nativeStartup=freeze(parseStrictJson(Buffer.from(bytes.subarray(4,Atomics.load(control,LENGTH))).toString("utf8")));}catch{terminal(control,"NATIVE_HOST_START_FAILED");}}
  function failure(){return freeze({status:CODES[Atomics.load(control,CODE)]||"TRANSPORT_LOST",result:null,code:null,nativeError:null,authority:nativeBootstrap?"NATIVE_STORAGE_N1_ONLY_NO_EPOCH_AUTHORITY":"TRANSPORT_ONLY_NOT_NATIVE_CAPABILITY"});}
  const api=Object.freeze({
    command(command,payload){
      if(busy)return freeze({status:"ERROR",code:"SINGLE_FLIGHT_REQUIRED",result:null,nativeError:null});
      if(Atomics.load(control,STATE)===TERMINAL)return failure();
      busy=true;
      try{
        const next=id+1,frame=encodeFrame({schema:REQUEST_SCHEMA,id:next,command,payload},"request");
        if(Atomics.load(control,STATE)!==READY){terminal(control,"PROTOCOL_DESYNC");return failure();}
        id=next;const deadline=nowNs()+BigInt(timeoutMs)*1000000n;bytes.set(frame);Atomics.store(control,LENGTH,frame.length);Atomics.store(control,STATE,REQUEST);worker.postMessage({kind:"request",deadline});
        if(wait(REQUEST,deadline)!==RESPONSE)return failure();
        if(nowNs()>=deadline){terminal(control,"TIMEOUT");worker.postMessage({kind:"close"});return failure();}
        const value=decodeFrame(Buffer.from(bytes.subarray(0,Atomics.load(control,LENGTH))),"response");if(value.id!==id){terminal(control,"PROTOCOL_DESYNC");return failure();}
        if(nowNs()>=deadline){terminal(control,"TIMEOUT");worker.postMessage({kind:"close"});return failure();}
        if(Atomics.compareExchange(control,STATE,RESPONSE,READY)!==RESPONSE)return failure();return freeze(value);
      }catch(e){terminal(control,CODES.includes(e.message)?e.message:"PROTOCOL_INVALID");worker.postMessage({kind:"close"});return failure();}
      finally{busy=false;}
    },
    snapshot:()=>freeze({state:Atomics.load(control,STATE)===TERMINAL?"TERMINAL":busy?"IN_FLIGHT":"CONNECTED",terminalCode:CODES[Atomics.load(control,CODE)],requests:id,workerExited,authority:nativeBootstrap?"NATIVE_STORAGE_N1_ONLY_NO_EPOCH_AUTHORITY":"TRANSPORT_ONLY_NOT_NATIVE_CAPABILITY",ownedHelperPid:Atomics.load(control,HELPER_PID),helperIdentityVerified:!!(nativeStartup&&nativeStartup.schema==="trigger-fork-native-startup/v1"),nativeStartup,helperExited:!!Atomics.load(control,HELPER_EXITED),helperExitCode:Atomics.load(control,HELPER_EXIT_CODE)}),
    terminateOwnedHelper(delayMs=0){if(!nativeBootstrap||!Number.isSafeInteger(delayMs)||delayMs<0||delayMs>2000)error("PROTOCOL_INVALID");worker.postMessage({kind:"terminate-helper",delayMs});return freeze({scheduled:true});},
    loseTransportForQualification(){if(!nativeBootstrap)error("PROTOCOL_INVALID");return worker.terminate();},
    stop(ownerLease=null){
      if(stopPromise)return stopPromise;
      if(nativeBootstrap){
        if(Atomics.load(control,STATE)===READY)api.command("EXIT",ownerLease?{__nativeOwnerLease:ownerLease}:{});
        if(!Atomics.load(control,HELPER_EXITED))Atomics.wait(control,HELPER_EXITED,0,2000);
        if(!Atomics.load(control,HELPER_EXITED)){worker.postMessage({kind:"close"});Atomics.wait(control,HELPER_EXITED,0,1000);}
      }
      terminal(control,"CLOSED");
      // Bounded asynchronous resource disposal, not synchronous native teardown
      // proof and never an execution/disposition callback result.
      stopPromise=new Promise(resolve=>{
        const timer=setTimeout(()=>resolve(freeze({ok:false,code:"WORKER_EXIT_UNCONFIRMED"})),1000);
        worker.terminate().then(()=>{clearTimeout(timer);workerExited=true;const released=!nativeBootstrap||!!Atomics.load(control,HELPER_EXITED);resolve(freeze({ok:released,code:released?"WORKER_EXIT_CONFIRMED":"HELPER_EXIT_UNCONFIRMED",helperExited:!!Atomics.load(control,HELPER_EXITED)}));},()=>{clearTimeout(timer);resolve(freeze({ok:false,code:"WORKER_EXIT_UNCONFIRMED"}));});
      });return stopPromise;
    }
  });
  return Object.freeze({ok:startup===READY,code:startup===READY?"CONNECTED_UNQUALIFIED":CODES[Atomics.load(control,CODE)],transport:api});
}
function createBoundedPipeTransport(options){return createTransport(options);}
function createNativeStorageTransport(options,inheritConsole=false){
  exact(options,["root","timeoutMs","startupTimeoutMs","qualificationDelayMs"]);
  if(process.platform!=="win32"||typeof options.root!=="string"||options.root.length>1000||!Number.isSafeInteger(options.startupTimeoutMs)||options.startupTimeoutMs<1000||options.startupTimeoutMs>30000||!Number.isSafeInteger(options.qualificationDelayMs)||options.qualificationDelayMs<0||options.qualificationDelayMs>2000)error("PROTOCOL_INVALID");
  const pipeName="\\\\.\\pipe\\evm-epoch-native-"+require("node:crypto").randomBytes(16).toString("hex");
  return createTransport({pipeName,timeoutMs:options.timeoutMs},{root:options.root,startupTimeoutMs:options.startupTimeoutMs,qualificationDelayMs:options.qualificationDelayMs,inheritConsole:inheritConsole===true});
}
if(!isMainThread&&workerData&&workerData.kind==="epoch-native-transport-worker/v1")runWorker();
module.exports=Object.freeze({REQUEST_SCHEMA,RESPONSE_SCHEMA,MAX_FRAME_BYTES,MAX_TIMEOUT_MS,COMMANDS,encodeFrame,decodeFrame,createBoundedPipeTransport,createNativeStorageTransport});
