"use strict";
// Local Node worker/pipe qualification ONLY. These peers are not native hosts,
// do not own journals/jobs, and cannot register an adapter or activate epochs.
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto"),{Worker}=require("node:worker_threads");
const bridge=require("../lib/trigger-fork-epoch-native-bridge.js");
const req=(payload={})=>({schema:bridge.REQUEST_SCHEMA,id:1,command:"HELLO",payload});
const response=(id=1)=>({schema:bridge.RESPONSE_SCHEMA,id,status:"RESPONSE",result:{observed:true},code:null,nativeError:null});
function raw(text){const b=Buffer.from(text),f=Buffer.alloc(b.length+4);f.writeUInt32LE(b.length);b.copy(f,4);return f;}
test("codec strict canonical round trip, both directions",()=>{for(const [v,k]of [[req({a:[1,true,null,"synthetic"]}),"request"],[response(),"response"]])assert.deepEqual(JSON.parse(JSON.stringify(bridge.decodeFrame(bridge.encodeFrame(v,k),k))),v);});
for(const mutation of ["extra","unknown-command","unsafe-id","negative-id","decimal-id","payload-null","schema"])test("request codec rejects "+mutation,()=>{const r=req();if(mutation==="extra")r.extra=true;if(mutation==="unknown-command")r.command="ACTIVATE";if(mutation==="unsafe-id")r.id=Number.MAX_SAFE_INTEGER+1;if(mutation==="negative-id")r.id=-1;if(mutation==="decimal-id")r.id=1.5;if(mutation==="payload-null")r.payload=null;if(mutation==="schema")r.schema="unknown";assert.throws(()=>bridge.encodeFrame(r,"request"),/^Error: PROTOCOL_INVALID$/);});
for(const text of ['{"id":1,"id":1}','{"n":9007199254740993}','{"n":1.1}','{"schema":"unknown"}','{"payload":{"__proto__":{}}}',' '.repeat(1)+'{}',"[".repeat(20)+"]".repeat(20)])test("raw malformed/noncanonical/unsafe JSON refuses without echo",()=>{assert.throws(()=>bridge.decodeFrame(raw(text),"request"),/^Error: PROTOCOL_INVALID$/);});
test("accessors and arbitrary thenables are not executed by encoder",()=>{let gets=0;const p={};Object.defineProperty(p,"value",{enumerable:true,get(){++gets;throw new Error("synthetic private detail");}});assert.throws(()=>bridge.encodeFrame(req(p),"request"),/^Error: PROTOCOL_INVALID$/);assert.equal(gets,0);});
test("wire truncation/extra bytes/oversize/invalid UTF8 are rejected",()=>{const f=bridge.encodeFrame(req(),"request");for(const b of [f.subarray(0,3),f.subarray(0,f.length-1),Buffer.concat([f,Buffer.from([0])])])assert.throws(()=>bridge.decodeFrame(b,"request"));const over=Buffer.alloc(4);over.writeUInt32LE(bridge.MAX_FRAME_BYTES+1);assert.throws(()=>bridge.decodeFrame(over,"request"),/^Error: PROTOCOL_OVERSIZE$/);const utf=Buffer.from([1,0,0,0,255]);assert.throws(()=>bridge.decodeFrame(utf,"request"),/^Error: PROTOCOL_INVALID$/);});
for(const mutation of ["status","extra","native-error","raw-error","unsafe-error"])test("response exact fixed diagnostics "+mutation,()=>{const r=response();if(mutation==="status")r.status="READY";if(mutation==="extra")r.payload="private";if(mutation==="native-error")r.nativeError=5;if(mutation==="raw-error"){r.status="ERROR";r.result=null;r.code="synthetic private detail";}if(mutation==="unsafe-error"){r.status="ERROR";r.result=null;r.code="NATIVE_FAILURE";r.nativeError=4294967296;}assert.throws(()=>bridge.encodeFrame(r,"response"),/^Error: PROTOCOL_INVALID$/);});
const peerCode=String.raw`
  const {parentPort,workerData}=require('node:worker_threads'),net=require('node:net'),b=require(workerData.modulePath);
  let count=0;const server=net.createServer(socket=>{let bytes=Buffer.alloc(0);socket.on('error',()=>{});
    socket.on('data',chunk=>{bytes=Buffer.concat([bytes,chunk]);if(bytes.length<4||bytes.length<bytes.readUInt32LE(0)+4)return;
      const request=b.decodeFrame(bytes,'request');bytes=Buffer.alloc(0);++count;parentPort.postMessage({count});
      const response={schema:b.RESPONSE_SCHEMA,id:request.id,status:'RESPONSE',result:{observed:true},code:null,nativeError:null};
      if(workerData.mode==='error'){response.status='ERROR';response.result=null;response.code='NATIVE_ACCESS_DENIED';response.nativeError=5;}
      if(workerData.mode==='wrong-id')++response.id;
      const frame=b.encodeFrame(response,'response');
      if(workerData.mode==='stall'){socket.write(frame.subarray(0,5));return;}
      if(workerData.mode==='death'){setTimeout(()=>process.exit(0),20);return;}
      if(workerData.mode==='late'){setTimeout(()=>{if(!socket.destroyed)socket.write(frame);},600);return;}
      if(workerData.mode==='partial-close'){socket.end(frame.subarray(0,8));return;}
      if(workerData.mode==='oversize'){const p=Buffer.alloc(4);p.writeUInt32LE(b.MAX_FRAME_BYTES+1);socket.write(p);return;}
      if(workerData.mode==='duplicate'){socket.write(Buffer.concat([frame,frame]));return;}
      if(workerData.mode==='malformed'){const text='{"id":1,"id":1}',p=Buffer.alloc(Buffer.byteLength(text)+4);p.writeUInt32LE(Buffer.byteLength(text));p.write(text,4);socket.write(p);return;}
      socket.write(frame);
    });
  });server.listen(workerData.pipeName,()=>parentPort.postMessage({ready:true}));
`;
async function transport(t,mode="happy",timeoutMs=1500){
  const pipeName="\\\\.\\pipe\\evm-epoch-native-"+crypto.randomBytes(16).toString("hex");
  const peer=new Worker(peerCode,{eval:true,workerData:{pipeName,mode,modulePath:require.resolve("../lib/trigger-fork-epoch-native-bridge.js")}});let count=0;
  peer.on("message",m=>{if(m.count)count=m.count;});
  t.after(async()=>{await peer.terminate();});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("PEER_START_TIMEOUT")),3000);peer.once("message",()=>{clearTimeout(timer);resolve();});peer.once("error",e=>{clearTimeout(timer);reject(e);});});
  const made=bridge.createBoundedPipeTransport({pipeName,timeoutMs});t.after(async()=>{const stopped=await made.transport.stop();assert.equal(stopped.ok,true);assert.equal(made.transport.snapshot().workerExited,true);});
  assert.equal(made.ok,true,made.code);return {peer,client:made.transport,count:()=>count};
}
test("UNQUALIFIED pipe: synchronous worker facade, correlation and explicit non-authority",async t=>{const h=await transport(t);for(let n=1;n<=3;n++){const r=h.client.command("HELLO",{});assert.equal(r.id,n);assert.equal(r.status,"RESPONSE");assert.ok(Object.isFrozen(r.result));}assert.equal(h.client.snapshot().helperIdentityVerified,false);assert.equal(h.client.snapshot().authority,"TRANSPORT_ONLY_NOT_NATIVE_CAPABILITY");assert.equal(h.client.snapshot().requests,3);assert.equal(Object.hasOwn(h.client,"worker"),false);assert.equal(Object.hasOwn(h.client,"buffer"),false);});
test("UNQUALIFIED pipe: typed ERROR preserves numeric native diagnostic without raw error",async t=>{const h=await transport(t,"error"),r=h.client.command("HELLO",{});assert.equal(r.status,"ERROR");assert.equal(r.code,"NATIVE_ACCESS_DENIED");assert.equal(r.nativeError,5);assert.equal(r.result,null);});
for(const [mode,status]of [["wrong-id","PROTOCOL_DESYNC"],["duplicate","PROTOCOL_DESYNC"],["oversize","PROTOCOL_OVERSIZE"],["malformed","PROTOCOL_INVALID"],["partial-close","TRANSPORT_LOST"],["death","TRANSPORT_LOST"]])test("UNQUALIFIED pipe: "+mode+" is terminal and never retried",async t=>{const h=await transport(t,mode);const r=h.client.command("HELLO",{});assert.equal(r.status,status);assert.equal(h.client.snapshot().state,"TERMINAL");assert.equal(h.client.command("JOURNAL_APPEND",{bytes:"not-sent"}).status,status);assert.equal(h.client.snapshot().requests,1);});
for(const mode of ["stall","late"])test("UNQUALIFIED pipe: "+mode+" has finite timeout, no late upgrade/reconnect",async t=>{const h=await transport(t,mode,400),start=performance.now(),r=h.client.command("HELLO",{});assert.equal(r.status,"TIMEOUT");assert.ok(performance.now()-start<1800);const saved=JSON.stringify(r);await new Promise(resolve=>setTimeout(resolve,750));assert.equal(JSON.stringify(r),saved);assert.equal(h.client.command("HELLO",{}).status,"TIMEOUT");assert.equal(h.client.snapshot().requests,1);assert.ok(h.count()<=1);});
test("UNQUALIFIED pipe: idle peer worker death causes transport loss without restart",async t=>{const h=await transport(t);await h.peer.terminate();await new Promise(resolve=>setTimeout(resolve,80));assert.equal(h.client.command("HELLO",{}).status,"TRANSPORT_LOST");assert.equal(h.client.snapshot().requests,0);});
test("UNQUALIFIED pipe: one flight enforced even during reflective same-process reentry",async t=>{const h=await transport(t);let nested;const p=new Proxy({}, {getPrototypeOf(){nested=h.client.command("HELLO",{});return Object.prototype;}});const r=h.client.command("HELLO",p);assert.equal(r.status,"RESPONSE");assert.equal(nested.code,"SINGLE_FLIGHT_REQUIRED");assert.equal(h.client.snapshot().requests,1);});
test("remote/UNC/unknown pipe paths refuse before worker creation",()=>{for(const pipeName of ["127.0.0.1:1234","\\\\other\\pipe\\arbitrary","C:\\temp\\file","\\\\.\\pipe\\wrong"]){assert.throws(()=>bridge.createBoundedPipeTransport({pipeName,timeoutMs:100}),/^Error: PROTOCOL_INVALID$/);}});
