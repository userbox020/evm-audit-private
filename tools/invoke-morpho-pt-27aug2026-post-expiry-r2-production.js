#!/usr/bin/env node
'use strict';
const TEST_ONLY=true;
class SupervisorError extends Error{constructor(code){super(code);this.code=code;}}
const fail=(code)=>{throw new SupervisorError(code);};
function validateSupervisorInvocation({args,env,stdinBytes,stdinIsPipe}){if(!Array.isArray(args)||args.length!==0)fail('S01');if(!env||Object.entries(env).some(([key,value])=>String(value||'')!==''&&/(?:RPC|ENDPOINT|INVENTORY|PROVIDER|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE|HEADER|_URL|_URI|API_KEY|NODE_OPTIONS|PRELOAD|DEBUG|INSPECT|COVERAGE|TLS|SSL|KEYLOG)/iu.test(key)))fail('S02');if(!stdinIsPipe||!Buffer.isBuffer(stdinBytes)||!/^[0-9a-f]{64}\n$/u.test(stdinBytes.toString('utf8')))fail('S03');return true;}
function readNonce(input=process.stdin){return new Promise((resolve,reject)=>{const chunks=[];let size=0,done=false,finish=(error,value)=>{if(done)return;done=true;error?reject(error):resolve(value);};input.on('data',(chunk)=>{size+=chunk.length;if(size>65){finish(new SupervisorError('S03'));input.destroy();}else chunks.push(chunk);});input.on('end',()=>finish(null,Buffer.concat(chunks)));input.on('error',()=>finish(new SupervisorError('S04')));});}
async function runNativeSupervisor(){fail('NATIVE_R2_PERMIT_UNISSUED');}
if(require.main===module)runNativeSupervisor().catch((error)=>{process.stderr.write(`${error?.code||'S99'}\n`);process.exitCode=2;});
module.exports={TEST_ONLY,SupervisorError,validateSupervisorInvocation,runNativeSupervisor};
