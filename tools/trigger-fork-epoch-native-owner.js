#!/usr/bin/env node
"use strict";
// No default artifact access/helper/backend/source capture/approval flags.
async function main(args=process.argv.slice(2)){
  if(args.length===0||args.length===1&&args[0]==="--check"){
    const q=require("./lib/trigger-fork-epoch-native-qualify.js");process.stdout.write(JSON.stringify({...q.staticStatus(),code:"NATIVE_INACTIVE_NOT_READY",sideEffects:"NONE"})+"\n");return 0;
  }
  if(args.length===1&&args[0]==="--check-platform"){
    const q=require("./lib/trigger-fork-epoch-native-qualify.js"),report=await q.qualifyNative();process.stdout.write(JSON.stringify(report)+"\n");return report.ok?0:3;
  }
  process.stdout.write(JSON.stringify({ok:false,code:"NATIVE_OWNER_ARGUMENTS_REFUSED_NOT_READY",productionActive:false,sideEffects:"NONE"})+"\n");return 2;
}
if(require.main===module)main().then(code=>{process.exitCode=code;},()=>{process.stdout.write('{"ok":false,"code":"NATIVE_OWNER_QUALIFICATION_FAILED_HELD","productionActive":false}\n');process.exitCode=3;});
module.exports=Object.freeze({main});
