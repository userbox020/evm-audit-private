#!/usr/bin/env node
const fs=require("fs");const crypto=require("crypto");
const b=fs.readFileSync("targets/solend-program.so");const hex=b.toString("hex");
const patterns=new Map();
for(let i=0;i<hex.length-16;i+=2){
  const s8=hex.slice(i,i+16);
  if(/^[0-9a-f]{16}$/.test(s8)&&s8!=="0000000000000000")patterns.set(s8,(patterns.get(s8)||0)+1);
}
const arr=[...patterns.entries()].filter(([k,v])=>v>5&&v<200).sort((a,b)=>b[1]-a[1]);
const known={};
const instrs=["initObligation","depositReserveLiquidity","redeemReserveCollateral","borrowObligationLiquidity","repayObligationLiquidity","liquidateObligation","flashLoan","refreshObligation","refreshReserve","deposit","withdraw","borrow","repay","liquidate","init_lending_market","init_reserve","lending_pool_deposit","lending_pool_withdraw","lending_pool_borrow","lending_pool_repay","lending_pool_liquidate"];
const accounts=["Obligation","Reserve","LendingMarket","LastUpdate"];
instrs.forEach(name=>{const h=crypto.createHash("sha256").update("global:"+name).digest("hex").slice(0,16);known[h]=name});
accounts.forEach(name=>{const h=crypto.createHash("sha256").update("account:"+name).digest("hex").slice(0,16);known[h]="account:"+name});
console.log("Top Solend discriminators:");
arr.slice(0,20).forEach(([k,v])=>{const name=known[k];console.log("  "+k+(name?" = "+name:" (unknown)")+" x"+v)});
