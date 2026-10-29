#!/usr/bin/env node
// Quick fix: patch the Kamino monitor's RPC resolution.
// Reads the existing monitor file, replaces resolveRpcUrl() return,
// keeping everything else intact.
const fs=require("fs");const path=require("path");
const f=path.resolve("C:\\_Work\\__EVM_AUDIT","targets","kamino-klend","monitor-liquidation-window.js");
let code=fs.readFileSync(f,"utf8");

// Remove the broken resolveRpcUrl function
code=code.replace(/function resolveRpcUrl[\s\S]*?return 'https:\/\/api\.mainnet-beta\.solana\.com';\n\}/, "");

// Remove secretInventoryPaths
code=code.replace(/function secretInventoryPaths[\s\S]*?return paths;\n\}/, "");

// Remove extractSolanaUrl  
code=code.replace(/function extractSolanaUrl[\s\S]*?return null;\n\}/, "");

// Replace rpcUrl assignment in main()
code=code.replace("const rpcUrl = resolveRpcUrl();", 
`  // Multi-endpoint Solana RPC resolution — tries all URLs
  function loadUrls(){
    const file = path.resolve(__dirname, "..", "..", "rpc_endpoints.txt");
    if(!fs.existsSync(file))return[];
    return [...fs.readFileSync(file,"utf8").matchAll(/https?:\\/\\/[^\\s'"<>]+/g)].map(m=>m[0]).filter(u=>u.toLowerCase().includes("solana")||u.toLowerCase().includes("helius"));
  }
  async function resolveWorkingRpc(){
    for(const url of loadUrls()){
      try{
        const h={"content-type":"application/json"};
        if(url.toLowerCase().includes("helius"))h["Origin"]="https://helius.xyz";
        const r=await fetch(url,{method:"POST",headers:h,body:JSON.stringify({jsonrpc:"2.0",id:1,method:"getSlot",params:[]})});
        const j=await r.json();
        if(!j.error&&j.result)return url;
      }catch(_){}
    }
    return "https://api.mainnet-beta.solana.com";
  }
  const rpcUrl = await resolveWorkingRpc();`);

fs.writeFileSync(f,code);
console.log("Patched");
