"use strict";
// Actual storage/dummy containment service, queried privately by the platform.
// Neither this brand nor native self-observation authorizes an epoch/source.
const bridge=require("./trigger-fork-epoch-native-bridge.js");
const adapters=new WeakSet(),services=new WeakMap();
function exact(o,keys){if(!o||![Object.prototype,null].includes(Object.getPrototypeOf(o))||Reflect.ownKeys(o).length!==keys.length)throw new Error("NATIVE_ADAPTER_INPUT_INVALID");for(const k of Reflect.ownKeys(o)){const d=Object.getOwnPropertyDescriptor(o,k);if(!keys.includes(k)||!d.enumerable||!("value"in d))throw new Error("NATIVE_ADAPTER_INPUT_INVALID");}}
function createNativeStorageAdapter(options,inheritConsole=false){
  exact(options,["root","timeoutMs","startupTimeoutMs","qualificationDelayMs"]);
  const made=bridge.createNativeStorageTransport(options,inheritConsole),transport=made.transport;
  if(!made.ok)return Object.freeze({ok:false,code:made.code,nativeStartup:transport.snapshot().nativeStartup,cleanup:()=>transport.stop(),supervision:()=>transport.snapshot()});
  const hello=transport.command("HELLO",{}),startup=transport.snapshot().nativeStartup;
  if(hello.status!=="RESPONSE"||hello.result.schema!=="trigger-fork-native-hello/v1"||hello.result.helper.pid!==startup.helper.pid||hello.result.helper.creationTime100ns!==startup.helper.creationTime100ns||hello.result.parent.pid!==process.pid||hello.result.parent.creationTime100ns!==startup.parent.creationTime100ns){return Object.freeze({ok:false,code:"NATIVE_HELLO_BINDING_FAILED",cleanup:()=>transport.stop(),supervision:()=>transport.snapshot()});}
  let held=null,adoptionToken=null,rawLifecycleControlUsed=false;
  const revoked=()=>Object.freeze({ok:false,code:"NATIVE_RAW_ADAPTER_REVOKED",held:true});
  function makeApi(privateUse){
  const leases=new WeakMap(),containments=new WeakMap(),namespaceLeases=new WeakSet();let namespaceBound=false;
  function call(command,payload){
    const readonly=command==="CLOCK_SAMPLE"&&(Object.keys(payload).length===0||payload.operation==="CONSOLE_INSPECT")||command==="JOURNAL_PATH_IDENTITY"||command==="ESTABLISH"&&payload.operation==="DESCRIBE";
    if(adoptionToken&&!privateUse&&!readonly)return revoked();
    if(held)return Object.freeze({ok:false,code:held,held:true});
    const r=transport.command(command,privateUse&&adoptionToken?{...payload,__nativeOwnerLease:adoptionToken}:payload);
    if(r.status!=="RESPONSE"){
      if(r.code==="ABANDONED_OWNER_MUTEX")held=r.code;
      else if(r.status!=="ERROR"||["JOURNAL_APPEND","JOURNAL_FLUSH"].includes(command)||r.code==="NATIVE_DIRECTORY_FLUSH_FAILED"||r.code==="NATIVE_FILE_FLUSH_FAILED")held=r.status==="ERROR"?"NATIVE_MUTATION_UNCERTAIN":r.status;
      return Object.freeze({ok:false,code:r.status==="ERROR"?r.code:r.status,nativeError:r.nativeError,held:!!held});
    }
    return Object.freeze({ok:true,...r.result});
  }
  function token(fd){const t=leases.get(fd);if(!t)throw new Error("NATIVE_LEASE_INVALID");return t;}
  function fdCall(command,fd,extra={}){try{return call(command,{lease:token(fd),...extra});}catch{return Object.freeze({ok:false,code:"NATIVE_LEASE_INVALID"});}}
  function open(path,readonly){const r=call("JOURNAL_OPEN",{path,readonly});if(!r.ok)return r;const fd=Object.freeze({});leases.set(fd,r.lease);return Object.freeze({ok:true,fd,identity:r.identity,identityMode:"ACTUAL_NATIVE_N1"});}
  function contain(command,cap,extra={}){const token=containments.get(cap);if(!token)return Object.freeze({ok:false,code:"NATIVE_CONTAINMENT_TOKEN_INVALID"});return call(command,{token,...extra});}
  const adapter=Object.freeze({
    mode:"NATIVE_STORAGE_N1_ONLY",label:"DOCUMENTED_SEMANTICS_APPLIED_NOT_EPOCH_AUTHORITY",
    createExclusiveFile:path=>open(path,false),openReadonlyExisting:path=>open(path,true),
    append(fd,bytes){if(!Buffer.isBuffer(bytes)||bytes.length>16384)return Object.freeze({ok:false,code:"NATIVE_BYTES_INVALID"});return fdCall("JOURNAL_APPEND",fd,{bytes:bytes.toString("base64")});},
    flush:fd=>fdCall("JOURNAL_FLUSH",fd),
    readAll(fd,maxBytes=786432){const r=fdCall("JOURNAL_READ",fd,{maxBytes});if(!r.ok)return r;return Object.freeze({ok:true,bytes:Buffer.from(r.bytes,"base64")});},
    statIdentity(fd){const r=fdCall("JOURNAL_IDENTITY",fd);return r.ok?Object.freeze({ok:true,...r}):r;},
    statIdentityByPath:path=>call("JOURNAL_PATH_IDENTITY",{path}),
    closeFile(fd){const r=fdCall("JOURNAL_CLOSE",fd);if(r.ok)leases.delete(fd);return r;},
    sampleClock:()=>call("CLOCK_SAMPLE",{}),acquireMutex:()=>call("MUTEX_ACQUIRE",{}),releaseMutex:()=>call("MUTEX_RELEASE",{}),
    bindLifetime:(deadlineUtcMs,deadlineMonotonicMs)=>call("CLOCK_SAMPLE",{operation:"BIND_LIFETIME",deadlineUtcMs,deadlineMonotonicMs}),
    narrowLifetime:(deadlineUtcMs,deadlineMonotonicMs)=>call("CLOCK_SAMPLE",{operation:"NARROW_LIFETIME",deadlineUtcMs,deadlineMonotonicMs}),
    acquireOwnerNamespace(){if(namespaceBound)return Object.freeze({ok:false,code:"NATIVE_OWNER_NAMESPACE_ALREADY_BOUND"});const r=call("MUTEX_ACQUIRE",{operation:"NATIVE_OWNER_NAMESPACE"});if(!r.ok||!r.acquired)return r;const capability=Object.freeze({});namespaceLeases.add(capability);namespaceBound=true;return Object.freeze({...r,capability});},
    verifyOwnerNamespace(cap){if(!namespaceLeases.has(cap))return Object.freeze({ok:false,code:"NATIVE_OWNER_NAMESPACE_CAPABILITY_REFUSED"});return call("MUTEX_ACQUIRE",{operation:"VERIFY_NATIVE_OWNER_NAMESPACE"});},
    releaseOwnerNamespace(cap){if(!namespaceLeases.has(cap))return Object.freeze({ok:false,code:"NATIVE_OWNER_NAMESPACE_CAPABILITY_REFUSED"});const r=call("MUTEX_RELEASE",{operation:"NATIVE_OWNER_NAMESPACE"});if(r.ok)namespaceLeases.delete(cap);return r;},
    consoleInspect:()=>call("CLOCK_SAMPLE",{operation:"CONSOLE_INSPECT"}),
    consoleBegin:options=>call("CLOCK_SAMPLE",{operation:"CONSOLE_BEGIN",...options}),
    consolePoll:token=>call("CLOCK_SAMPLE",{operation:"CONSOLE_POLL",token}),
    consoleInvalidate:token=>call("CLOCK_SAMPLE",{operation:"CONSOLE_INVALIDATE",token}),
    armJournalQualificationFault:fault=>call("CLOCK_SAMPLE",{operation:"QUALIFICATION_JOURNAL_FAULT",fault}),
    verifyServiceQuiescence:()=>call("CLOCK_SAMPLE",{operation:"VERIFY_SERVICE_QUIESCENCE"}),
    containment:()=>call("ESTABLISH",{}),
    describeDummy:()=>call("ESTABLISH",{operation:"DESCRIBE",scope:"DUMMY_QUALIFICATION_ONLY"}),
    installDummy:()=>call("ESTABLISH",{operation:"INSTALL",scope:"DUMMY_QUALIFICATION_ONLY"}),
    establishDummy(options){
      try{exact(options,["mode","scriptPath","scriptDigest","deadlineUtcMs","deadlineMonotonicMs","cleanupBudgetMs","fault"]);}catch{return Object.freeze({ok:false,code:"NATIVE_DUMMY_INPUT_INVALID"});}
      const r=call("ESTABLISH",{operation:"CREATE",scope:"DUMMY_QUALIFICATION_ONLY",...options});if(!r.ok)return r;
      const cap=Object.freeze({});containments.set(cap,r.token);const {token,...view}=r;return Object.freeze({...view,containment:cap});
    },
    resumeDummy:cap=>contain("RESUME",cap),waitDummy:(cap,waitMs=1000)=>contain("WAIT",cap,{waitMs}),treeDummy:cap=>contain("TREE_VERIFY",cap),cancelDummy:cap=>contain("CANCEL",cap),closeDummy:(cap,mode="AFTER_VERIFIED_ZERO")=>contain("JOB_CLOSE",cap,{mode}),
    supervision:()=>Object.freeze({...transport.snapshot(),hello:hello.result,heldCode:held}),
    terminateOwnedHelper(delayMs=0){if(adoptionToken&&!privateUse)return revoked();if(!Number.isSafeInteger(delayMs)||delayMs<0||delayMs>2000)throw new Error("PROTOCOL_INVALID");if(!privateUse)rawLifecycleControlUsed=true;return transport.terminateOwnedHelper(delayMs);},
    loseTransportForQualification(){if(adoptionToken&&!privateUse)return Promise.resolve(revoked());if(!privateUse)rawLifecycleControlUsed=true;return transport.loseTransportForQualification();},
    dispose(){if(adoptionToken&&!privateUse)return Promise.resolve(revoked());if(!privateUse)rawLifecycleControlUsed=true;return transport.stop(privateUse?adoptionToken:null);}
  });
  adapters.add(adapter);return adapter;
  }
  const adapter=makeApi(false);
  services.set(adapter,{adopt(key){const mode=require("./trigger-fork-epoch-native-owner.js").nativeConstructionMode(key);if(!mode||adoptionToken)return Object.freeze({ok:false,code:"NATIVE_ADOPTION_CAPABILITY_REFUSED"});if(rawLifecycleControlUsed)return Object.freeze({ok:false,code:"NATIVE_ADOPTION_RAW_LIFECYCLE_USED"});if(held)return Object.freeze({ok:false,code:"NATIVE_ADOPTION_SERVICE_HELD"});const r=transport.command("CLOCK_SAMPLE",{operation:"ADOPT_NATIVE_CONTROLLER",mode});if(r.status!=="RESPONSE")return Object.freeze({ok:false,code:r.code||r.status,nativeError:r.nativeError});adoptionToken=r.result.token;return Object.freeze({ok:true,adapter:makeApi(true)});}});
  return Object.freeze({ok:true,adapter,scope:"N1_STORAGE_ONLY_NO_EPOCH_AUTHORITY"});
}
module.exports=Object.freeze({createNativeStorageAdapter:options=>createNativeStorageAdapter(options,false),createNativeConsoleStorageAdapter:options=>createNativeStorageAdapter(options,true),isNativeStorageAdapter:value=>adapters.has(value),adoptNativeStorageAdapter(value,key){const s=services.get(value);return s?s.adopt(key):Object.freeze({ok:false,code:"NATIVE_ADOPTION_CAPABILITY_REFUSED"});}});
