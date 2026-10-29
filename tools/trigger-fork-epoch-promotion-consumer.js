"use strict";
// A live MODEL owner/receipt capability only. No default reads/sends/adapters.
const owners=require("./lib/trigger-fork-epoch-owner.js");
function blocked(){return Object.freeze({ok:false,code:"PLATFORM_RUNTIME_UNIMPLEMENTED",evidenceClass:"MODEL_ONLY",productionReady:false});}
function consumeModelPromotion({owner,receipt,deliver}={}){
  if(!owners.isRegisteredModelOwner(owner))return Object.freeze({ok:false,code:"MODEL_OWNER_UNREGISTERED"});
  const queued=owner.enqueueModelPromotion(receipt);if(!queued.ok)return queued;
  return owner.deliverModelPromotion({receipt,deliver});
}
function previewRecovery(){return blocked();} // no automatic disk import/resume
function runCli(){return blocked();} // --check/--apply equally inert before I/O
if(require.main===module){const r=runCli();process.stdout.write(JSON.stringify(r)+"\n");process.exitCode=1;}
module.exports=Object.freeze({consumeModelPromotion,previewRecovery,runCli});
