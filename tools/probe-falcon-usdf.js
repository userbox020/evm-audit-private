const{ethers}=require("ethers");const{rpcCall,resolveRpc}=require("./shared-rpc");
(async()=>{const r=await resolveRpc(1);const USDF="0xFa2B947eEc368f42195f24F36d2aF29f7c24CeC2";
const ERC20=new ethers.Interface(["function symbol() view returns (string)","function totalSupply() view returns (uint256)","function owner() view returns (address)","function paused() view returns (bool)"]);
const[sym,supply,ow,paused]=await Promise.all(["symbol","totalSupply","owner","paused"].map(fn=>rpcCall(r,"eth_call",[{to:USDF,data:ERC20.encodeFunctionData(fn,[])},"latest"],8000).then(raw=>{try{return ERC20.decodeFunctionResult(fn,raw)}catch(_){return null}})));
const s=supply?Number(ethers.formatUnits(supply[0],18)):0;const o=ow?ow[0]:null;
let ot="?";if(o){const c=await rpcCall(r,"eth_getCode",[o,"latest"],8000);ot=c&&c!=="0x"?"contract":"EOA"}
// Permissionless probes
const DEAD="0x000000000000000000000000000000000000dEaD";
const PROBES=["mint(address,uint256)","burn(uint256)","burnFrom(address,uint256)","pause()","unpause()"];
const results=[];
for(const sig of PROBES){const fn=sig.slice(0,sig.indexOf("("));const iface=new ethers.Interface(["function "+sig]);try{const raw=await rpcCall(r,"eth_call",[{from:DEAD,to:USDF,data:iface.encodeFunctionData(fn,[])},"latest"],8000);results.push(sig+": NO_REVERT ret="+(raw&&raw!=="0x"?(raw.length-2)/2:0))}catch(e){results.push(sig+": REVERTED")}}
console.log(JSON.stringify({symbol:sym?.[0],supply:s,owner:o?.slice(0,12),ownerType:ot,paused:paused?Boolean(paused[0]):null,probes:results},null,2))})().catch(e=>console.error(e.message));
