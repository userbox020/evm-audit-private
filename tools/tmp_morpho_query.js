const q = `{
  marketPositions(first:3, orderBy:BorrowShares, orderDirection:Desc,
    where:{healthFactor_lte:0.99, borrowShares_gte:"1"}) {
    items {
      user { address }
      market {
        loanAsset { symbol address }
        collateralAsset { symbol address }
        oracle { address }
        irmAddress
        lltv
      }
      state { borrowAssetsUsd collateralUsd }
    }
  }
}`;

fetch("https://api.morpho.org/graphql",{
  method:"POST", headers:{"content-type":"application/json"},
  body:JSON.stringify({query:q})
}).then(r=>r.json()).then(j=>{
  const items = j.data?.marketPositions?.items || [];
  console.log("Found", items.length, "liquidatable positions");
  if (items.length > 0) {
    const m = items[0].market;
    console.log("loan:", m.loanAsset.symbol, m.loanAsset.address);
    console.log("coll:", m.collateralAsset.symbol, m.collateralAsset.address);
    console.log("oracle:", m.oracle?.address);
    console.log("irm:", m.irmAddress);
    console.log("lltv:", m.lltv);
  }
}).catch(e=>console.error(e.message));
