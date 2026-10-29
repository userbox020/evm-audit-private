#!/usr/bin/env node
'use strict';

const crypto=require('node:crypto');
function canonical(value){if(value===null||typeof value==='boolean'||typeof value==='number'||typeof value==='string')return JSON.stringify(value);if(Array.isArray(value))return`[${value.map(canonical).join(',')}]`;return`{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;}
function freeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
const POLICY=freeze({
  schema:'ostium-current-authority-bootstrap-r1-production-policy/v1',version:1,chainId:42161,mode:'one-shot-read-only',
  docs:{sourceId:'OSTIUM_OFFICIAL_DEPLOYMENTS',origin:'https://docs.ostium.com',path:'/developers/deployments',url:'https://docs.ostium.com/developers/deployments',contentType:'text/html; charset=utf-8',parser:{package:'parse5',version:'7.2.1',runtimeAssumption:'LOADED_CORE_MODULE_BYTE_IDENTITY_ASSUMES_NO_HOSTILE_LOCAL_MUTATION_WITHOUT_EXECUTABLE_BYTE_LOADER'},table:{chain:'Arbitrum',roles:['VAULT_PROXY','REGISTRY','OPEN_PNL_PROXY','ASSET']}},
  inventory:{path:'rpc_endpoints.txt',maxBytes:65536,maxCandidates:8,chainId:42161,transportClasses:['DIRECT_HTTPS','LOCALHOST_KEYLESS_RELAY']},
  permit:{path:'permits/ostium-current-authority-bootstrap-r1-production.json',schema:'ostium-current-authority-bootstrap-r1-production-permit/v3',maxBytes:32768,maxLifetimeSeconds:900,nonceBytes:32},
  output:{root:'reports/raw/fast/ostium-current-authority-bootstrap-r1-production',lock:'.one-shot.lock',runPrefix:'run-',tempSuffix:'.tmp',files:['result.json','validation.json','manifest.json'],commitMarker:'COMMITTED'},
  schemas:{result:'ostium-current-authority-bootstrap-r1-production-result/v1',validation:'ostium-current-authority-bootstrap-r1-production-validation/v1',manifest:'ostium-current-authority-bootstrap-r1-production-manifest/v1'},
  limits:{locatorBytes:4096,docsBodyBytes:1048576,dnsAddresses:8,dnsMs:3000,headerBytes:16384,connectMs:5000,inactivityMs:5000,requestMs:10000,totalMs:120000,rpcResponseBytes:2097152,rpcRequestBytes:131072,candidates:8,retries:0,redirects:0,socketsPerRequest:1,parserFiles:256,parserBytes:8388608},
  rpcMethods:['eth_chainId','eth_getBlockByNumber','eth_getCode','eth_getStorageAt','eth_call'],
  permitBindings:['policyHash','toolHashes','offlineHashes','offlineProfileHash','parserBundle','runtime','approvalNonce','issuedAt','expiresAt','docs','limits','output','hardStops'],
  hardStops:{officialAuthority:false,productionAuthority:false,phase3Authorized:false,economicsOpened:false,routePositive:false,executableNow:false,hardStop:true},
  platform:{requireDirectoryFsync:true,requireSameDirectoryHardLink:true,requireOpenHandleIdentity:true,win32RequiresSuccessfulDurabilityProbe:true},
});
const POLICY_HASH=crypto.createHash('sha256').update(canonical(POLICY)).digest('hex');
module.exports={POLICY,POLICY_HASH,canonical,freeze};
