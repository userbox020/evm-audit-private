#!/usr/bin/env node
// Phase 1 - EigenLayer withdrawal event decoding & signature verification
const{ethers}=require("ethers");

const WITHDRAWAL_STRUCT="tuple(address staker,address delegatedTo,address withdrawer,uint256 nonce,uint32 startBlock,address[] strategies,uint256[] scaledShares)";
const sigs=[
  "SlashingWithdrawalQueued(bytes32,"+WITHDRAWAL_STRUCT+",uint256[])",
  "WithdrawalQueued(bytes32,"+WITHDRAWAL_STRUCT+")",
  "WithdrawalCompleted(bytes32)",
  "OperatorSharesDecreased(address,address,uint256)",
  "OperatorSharesIncreased(address,address,uint256)",
  "StakerDelegated(address,address)",
  "StakerUndelegated(address,address)",
];

console.log("=== EigenLayer DelegationManager Event Signatures ===\n");
for(const sig of sigs){
  console.log(ethers.id(sig)+" = "+sig);
}

// Also show the 7 observed raw topics for comparison
const observed=[
  "0x6909600037b75d7b4733aedd815442b5ec018a827751c832aaff64eba5d6d2dd",
  "0x8be932bac54561f27260f95463d9b8ab37e06b2842e5ee2404157cc13df6eb8f",
  "0x26b2aae26516e8719ef50ea2f6831a2efbd4e37dccdf0d6936b27bc08e793e30",
  "0x1ec042c965e2edd7107b51188ee0f383e22e76179041ab3a9d18ff151405166c",
  "0x1f40400889274ed07b24845e5054a87a0cab969eb1277aafe61ae352e7c32a00",
  "0xc3ee9f2e5fda98e8066a1f745b2df9285f416fe98cf2559cd21484b3d8743304",
  "0xfee30966a256b71e14bc0ebfc94315e28ef4a97a7131a9e2b7a310a73af44676",
];

console.log("\n=== Matching Observed to Computed ===");
for(const obs of observed){
  const match=sigs.find(s=>ethers.id(s)===obs);
  console.log(obs.slice(0,10)+"... = "+(match||"UNKNOWN (may need different struct/param types)"));
}
