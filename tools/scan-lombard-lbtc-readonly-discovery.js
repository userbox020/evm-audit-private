#!/usr/bin/env node
"use strict";

// Lombard LBTC step-1: deterministic local-filesystem and read-only-git discovery.
// Deliberately contains no network, RPC, endpoint-inventory, signing, wallet, fork,
// transaction, build, test, or executor path.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const REPO = path.join(ROOT, "targets", "lombard-evm-smart-contracts");
const EXPECTED_COMMIT = "5ec153c2803991ac2b0240565b1498d85375c7a5";
const SNAPSHOT_LABEL = "2026-07-11-step1";
const SCANNER = "tools/scan-lombard-lbtc-readonly-discovery.js";
const OUT_JSON = "reports/raw/fast/lombard-lbtc-readonly-discovery.json";
const OUT_MD = "reports/lombard-lbtc-readonly-discovery-triage.md";
const ALLOWED_WRITES = new Set([OUT_JSON, OUT_MD]);
const LOMBARD_LBTC_ETHEREUM = "0x8236a87084f8b84306f72007f36f2618a5634494";
const NATIVE_LBTC_BTCB_ETHEREUM = "0xb0f70c0bd6fd87dbeb7c10dc692a2a6106817072";

const INPUTS = [
  ["deployment-map", "targets/lombard-evm-smart-contracts/mainnet.json", "json", ["\"mainnet\"", "\"BridgeV2\"", "\"layerZero\""]],
  ["mint-doc", "targets/lombard-evm-smart-contracts/docs/mint.md", "markdown", ["Wait for required block confirmations", "Only allowed for whitelisted minters"]],
  ["redeem-doc", "targets/lombard-evm-smart-contracts/docs/redeem.md", "markdown", ["In 7 days", "Burns `LBTC` and emits an `UnstakeRequest`"]],
  ["bridge-doc", "targets/lombard-evm-smart-contracts/docs/bridge.md", "markdown", ["attestation by Lombard Ledger", "token minted automatically"]],
  ["audit-index", "targets/lombard-evm-smart-contracts/docs/audit/README.md", "markdown", ["Some of the contracts were modified after they were audited", "GMPBascule"]],
  ["native-lbtc-source", "targets/lombard-evm-smart-contracts/contracts/LBTC/NativeLBTC.sol", "solidity", ["onlyRole(MINTER_ROLE)", "function changeBascule", "usedPayloads[payloadHash]", "checkProof(payloadHash, proof)", "validateWithdrawal(depositID, amount)"]],
  ["actions-source", "targets/lombard-evm-smart-contracts/contracts/libs/Actions.sol", "solidity", ["function depositBtcV1", "if (token != address(this))"]],
  ["consortium-source", "targets/lombard-evm-smart-contracts/contracts/consortium/Consortium.sol", "solidity", ["function _checkProof", "weightThreshold", "revert NotEnoughSignatures"]],
  ["mailbox-source", "targets/lombard-evm-smart-contracts/contracts/gmp/Mailbox.sol", "solidity", ["the handler must prevent double-spending", "inboundMessagePath[payload.msgPath]", "deliveredPayload[payloadHash]", "consortium.checkProof"]],
  ["asset-router-source", "targets/lombard-evm-smart-contracts/contracts/LBTC/AssetRouter.sol", "solidity", ["function changeBascule", "$.mailbox.deliverAndHandle", "AssetRouter_MailboxExpected", "usedPayloads[payload.id]", "AssetRouter_PayloadAlreadyUsed", "validateMint"]],
  ["bridge-v2-source", "targets/lombard-evm-smart-contracts/contracts/bridge/BridgeV2.sol", "solidity", ["function setDestinationBridge", "function addDestinationToken", "function setTokenRateLimits", "function setSenderConfig", "BridgeV2_SenderNotWhitelisted", "BridgeV2_MailboxExpected", "BridgeV2_PayloadSpent", "RateLimits.updateLimit"]],
  ["staked-lbtc-source", "targets/lombard-evm-smart-contracts/contracts/LBTC/StakedLBTC.sol", "solidity", ["Only callable by accounts with `MINTER_ROLE`", "return $.assetRouter.mint(rawPayload, proof)", "$.assetRouter.redeemForBtc", "Burns LBTC from an arbitrary holder; minter-only.", "$.assetRouter.redeem(_msgSender(), address(this), amount)", "$.assetRouter.deposit(_msgSender(), address(this), amount)"]],
  ["staked-oracle-source", "targets/lombard-evm-smart-contracts/contracts/LBTC/StakedLBTCOracle.sol", "solidity", ["function changeConsortium", "function updateRatioThreshold", "function publishNewRatio", "$.consortium.checkProof(payloadHash, proof)"]],
  ["base-lbtc-source", "targets/lombard-evm-smart-contracts/contracts/LBTC/BaseLBTC.sol", "solidity", ["modifier whenMintBurnAllowed", "function pauseTransfers", "function pauseMintBurn"]],
  ["assets-source", "targets/lombard-evm-smart-contracts/contracts/LBTC/libraries/Assets.sol", "solidity", ["struct Release", "function decodeRelease", "Release(toToken, recipient, amount)"]],
  ["gmp-utils-source", "targets/lombard-evm-smart-contracts/contracts/gmp/libs/GMPUtils.sol", "solidity", ["struct Payload", "msgNonce", "msgSender", "msgRecipient", "msgDestinationCaller", "msgBody"]],
  ["message-path-source", "targets/lombard-evm-smart-contracts/contracts/gmp/libs/MessagePath.sol", "solidity", ["sourceContract", "sourceChain", "destinationChain"]],
  ["ccip-pool-source", "targets/lombard-evm-smart-contracts/contracts/bridge/providers/LombardTokenPoolV2.sol", "solidity", ["compatible with BridgeV2", "function lockOrBurn", "function releaseOrMint", "function setPath"]],
  ["oft-lock-source", "targets/lombard-evm-smart-contracts/contracts/bridge/oft/LBTCOFTAdapter.sol", "solidity", ["Burns locked LBTC", "function empty() external onlyOwner"]],
  ["oft-burn-mint-source", "targets/lombard-evm-smart-contracts/contracts/bridge/oft/LBTCBurnMintOFTAdapter.sol", "solidity", ["function _debit", "burn(_from, amountSentLD)", "function _credit", "mint(_to, _amountLD)"]],
  ["ibc-voucher-source", "targets/lombard-evm-smart-contracts/contracts/ibc/IBCVoucher.sol", "solidity", ["function setRateLimit", "onlyRole(RELAYER_ROLE)", "$.lbtc.mint(recipient, amount)"]],
  ["gmp-bascule-source", "targets/lombard-evm-smart-contracts/contracts/bascule/GMPBasculeV1.sol", "solidity", ["allows all mints below this", "When the threshold is zero", "function validateMint"]],
  ["bascule-source", "targets/lombard-evm-smart-contracts/contracts/bascule/Bascule.sol", "solidity", ["allows all withdrawals below this", "When the threshold is zero", "function validateWithdrawal"]],
  ["deprecated-bridge-source", "targets/lombard-evm-smart-contracts/contracts/bridge/Bridge.sol", "solidity", ["requireConsortium", "function receivePayload", "function authNotary", "function withdraw"]],
  ["stale-live-baseline", "reports/raw/fast/lombard-live.json", "json", ["2026-05-31", "NO_ARBITRARY_SENDER_ADMIN_OR_MINT_SUCCESS"]],
  ["older-triage", "reports/lombard-triage.md", "markdown", ["# ⚪ CLEAN", "No current permissionless extraction route was found"]],
  ["consumer-high-ltv", "reports/raw/fast/consumer-first-high-ltv-collateral.json", "json", ["0x8236a87084f8B84306f72007F36F2618A5634494"]],
  ["consumer-compound", "reports/raw/fast/compound-v3-phase0.json", "json", ["0x8236a87084f8B84306f72007F36F2618A5634494"]],
  ["consumer-curve-llamalend", "reports/raw/fast/curve-llamalend-phase0.json", "json", ["0x8236a87084f8B84306f72007F36F2618A5634494"]],
  ["consumer-moonwell", "reports/moonwell-lending-phase0-triage.md", "markdown", ["mLBTC", "Route-positive | `0`"]],
  ["consumer-fluid", "reports/fluid-dex-phase0-triage.md", "markdown", ["VaultT2_DEX-LBTC", "Route-positive | 0"]],
  ["consumer-crvusd", "reports/crvusd-phase0-triage.md", "markdown", ["| LBTC |", "Route positive | 0"]],
].map(([id, inputPath, format, markers]) => ({ id, path: inputPath, format, markers }));

const PUBLIC_ASSERTIONS = [
  ["unique-deposit-address-tuple", "A unique Bitcoin deposit address is recorded as derived for the destination-chain and recipient tuple.", "https://docs.lombard.finance/lbtc/how-to-mint-lbtc"],
  ["six-bitcoin-confirmations", "May 28 public documentation was recorded as requiring six Bitcoin confirmations before minting.", "https://docs.lombard.finance/lbtc/how-to-mint-lbtc"],
  ["ledger-cometbft-consortium", "Lombard Ledger and a CometBFT-based consortium are recorded as the notarization layer.", "https://docs.lombard.finance/lombard-ledger/architecture"],
  ["members-threshold-observation", "May 28 documentation was recorded as describing 14 members and a 10-of-14 threshold; this is a stale, non-comparable conflicting observation against the May 31 equal-weight 12-of-16 chain snapshot. Neither is current.", "https://docs.lombard.finance/lombard-ledger/consortium"],
  ["cubesigner-hsm-bascule", "CubeSigner/HSM custody plus Bascule and Reverse Bascule defense-in-depth are recorded trust components.", "https://docs.lombard.finance/security/security-architecture"],
  ["non-rebasing-exchange-rate", "LBTC is recorded as a non-rebasing exchange-rate token whose BTC value accrues through its exchange rate.", "https://docs.lombard.finance/lbtc/overview"],
  ["bridge-configured-source-references", "Configured/source references for CCIP, IBC, native bridge, and OFT paths were recorded; this is not deployment, peer, mode, reachability, or conservation evidence.", "https://docs.lombard.finance/lbtc/bridging"],
  ["chain-list-discrepancy", "The May 28 recorded public chain list differs from the 19 named local mainnet.json configurations; identity and deployment status require reconciliation.", "https://docs.lombard.finance/lbtc/supported-networks"],
  ["docs-capture-date", "The official-documentation research capture date was recorded as 2026-05-28.", "https://docs.lombard.finance/"],
  ["redemption-ten-day-discrepancy", "May 28 official research was recorded as saying redemption may take up to ten days, while local docs/redeem.md says seven days.", "https://docs.lombard.finance/lbtc/how-to-redeem-lbtc"],
].map(([id, statement, sourceUrl]) => ({ id, statement, sourceUrl, evidenceClass: "recorded-unverified-non-evidence", verificationStatus: "recorded-unverified", fetchedByScanner: false, captureDate: "2026-05-28", authoringProvenance: "librarian-recorded-for-step1" }));

function rel(file) { return path.relative(ROOT, file).replace(/\\/g, "/"); }
function hash(buffer) { return crypto.createHash("sha256").update(buffer).digest("hex"); }
function lineOf(text, marker) { const at = text.indexOf(marker); return at < 0 ? null : text.slice(0, at).split(/\r?\n/).length; }
function writeOwned(relative, content) {
  if (!ALLOWED_WRITES.has(relative)) throw new Error(`write refused outside claim: ${relative}`);
  const file = path.join(ROOT, relative);
  if (!fs.existsSync(path.dirname(file))) throw new Error(`missing output directory: ${rel(path.dirname(file))}`);
  fs.writeFileSync(file, content, "utf8");
}
function git(...args) { return execFileSync("git", args, { cwd: REPO, encoding: "utf8", windowsHide: true }).trim(); }

function gitBlobId(spec) {
  const prefix = "targets/lombard-evm-smart-contracts/";
  if (!spec.path.startsWith(prefix)) return null;
  const repoPath = spec.path.slice(prefix.length);
  try {
    git("ls-files", "--error-unmatch", "--", repoPath);
    return git("rev-parse", `${EXPECTED_COMMIT}:${repoPath}`);
  } catch (_) {
    return null;
  }
}

function loadInputs() {
  const loaded = {};
  const manifest = INPUTS.map((spec) => {
    const file = path.join(ROOT, spec.path);
    if (!fs.existsSync(file)) throw new Error(`missing required input: ${spec.path}`);
    const buffer = fs.readFileSync(file);
    const text = buffer.toString("utf8");
    const markerChecks = spec.markers.map((marker) => ({ marker, found: text.includes(marker), line: lineOf(text, marker) }));
    if (markerChecks.some((check) => !check.found)) throw new Error(`marker check failed: ${spec.path}`);
    const parsed = spec.format === "json" ? JSON.parse(text) : null;
    loaded[spec.id] = { text, parsed };
    return { id: spec.id, path: spec.path, format: spec.format, bytes: buffer.length, sha256: hash(buffer), gitBlobId: gitBlobId(spec), loaded: true, parseOk: parsed ? true : null, markerChecks, fetchedByScanner: false };
  });
  return { loaded, manifest };
}

function exact(value) { return typeof value === "string" && value.toLowerCase() === LOMBARD_LBTC_ETHEREUM; }
function findRows(value, predicate, out = [], seen = new Set()) {
  if (!value || typeof value !== "object") return out;
  if (seen.has(value)) return out;
  seen.add(value);
  if (predicate(value)) out.push(value);
  for (const child of Object.values(value)) findRows(child, predicate, out, seen);
  return out;
}

function consumerEvidence(loaded) {
  const highDoc = loaded["consumer-high-ltv"].parsed;
  const compoundDoc = loaded["consumer-compound"].parsed;
  const curveDoc = loaded["consumer-curve-llamalend"].parsed;
  const ethereum = (row) => !Object.prototype.hasOwnProperty.call(row, "chainId") || row.chainId === 1;
  const high = findRows(highDoc, (row) => ethereum(row) && row.collateral && exact(row.collateral.address) && row.protocol && row.consumer);
  const compound = findRows(compoundDoc, (row) => ethereum(row) && exact(row.asset) && row.comet && row.assetSymbol);
  const curve = findRows(curveDoc, (row) => ethereum(row) && row.kind === "curve-llamalend-market" && row.controllerState && exact(row.controllerState.collateralToken));
  const candidates = [
    ...high.map((r) => ({ source: "reports/raw/fast/consumer-first-high-ltv-collateral.json", sourceGeneratedAt: highDoc.generatedAt, sourceRoutePositive: Object.prototype.hasOwnProperty.call(r, "routePositive") ? r.routePositive : null, chainId: r.chainId, protocol: r.protocol, chain: r.chain, consumer: r.consumer.marketId || r.consumer.evault || "consumer-row", role: "collateral", asset: r.collateral.address, context: `ltv=${r.ltv}; routeLiquidityUsd=${r.routeLiquidityUsd}`, currentRouteStatus: "unknown-not-refreshed" })),
    ...compound.map((r) => ({ source: "reports/raw/fast/compound-v3-phase0.json", sourceGeneratedAt: compoundDoc.generatedAt, sourceRoutePositive: Object.prototype.hasOwnProperty.call(r, "routePositive") ? r.routePositive : null, chainId: r.chainId, protocol: "Compound V3", chain: r.chain, consumer: r.comet, role: "collateral", asset: r.asset, context: `market=${r.market}; borrowCFBps=${r.borrowCFBps}; assetValueUsd=${r.assetValueUsd}`, currentRouteStatus: "unknown-not-refreshed" })),
    ...curve.map((r) => ({ source: "reports/raw/fast/curve-llamalend-phase0.json", sourceGeneratedAt: curveDoc.generatedAt, sourceRoutePositive: Object.prototype.hasOwnProperty.call(r, "routePositive") ? r.routePositive : null, chainId: r.chainId, protocol: "Curve LlamaLend", chain: r.chain, consumer: r.controller, role: "collateral", asset: r.controllerState.collateralToken, context: `market=${r.name}; debtUsd=${r.controllerState.totalDebtUsd}`, currentRouteStatus: "unknown-not-refreshed" })),
  ];
  const dedup = new Map();
  for (const row of candidates) dedup.set([row.chainId, row.protocol, row.consumer, row.role, row.asset.toLowerCase()].join("|"), row);
  const rows = [...dedup.values()];
  const markdownSources = ["consumer-moonwell", "consumer-fluid", "consumer-crvusd"].map((id) => ({ id, exactAddressPresent: loaded[id].text.toLowerCase().includes(LOMBARD_LBTC_ETHEREUM), symbolMentionPresent: /\bLBTC\b/.test(loaded[id].text), promoted: false, reason: "Markdown row lacks the full canonical Lombard Ethereum address; symbol-only/abbreviated context is not promoted." }));
  if (rows.some((row) => row.chainId !== 1 || !exact(row.asset))) throw new Error("non-exact/non-Ethereum consumer row promoted");
  return { scope: "LBTC-as-collateral only", canonicalAddress: LOMBARD_LBTC_ETHEREUM, exactAddressRows: rows, exactAddressRowCount: rows.length, duplicateCandidatesRemoved: candidates.length - rows.length, excludedSymbolOnlySources: markdownSources, btcDotBRowsPromoted: 0, nonLombardRowsPromoted: 0 };
}

function sourceFindings(manifest) {
  const refs = (id, markers) => {
    const item = manifest.find((x) => x.id === id);
    return markers.map((marker) => `${item.path}:${item.markerChecks.find((x) => x.marker === marker).line}`).join(", ");
  };
  return [
    { component: "Canonical Ethereum StakedLBTC — privileged mint", finding: "StakedLBTC direct mint and batch mint are MINTER_ROLE gated.", refs: "contracts/LBTC/StakedLBTC.sol:293-317", markerEvidence: refs("staked-lbtc-source", ["Only callable by accounts with `MINTER_ROLE`"]) },
    { component: "Canonical Ethereum StakedLBTC — public proof mint", finding: "The public proof-mint overload forwards raw payload and proof through AssetRouter to Mailbox; the handler checks Mailbox caller, module sender, payload uniqueness, release body, and optional GMP Bascule.", refs: "contracts/LBTC/StakedLBTC.sol:319-353; contracts/LBTC/AssetRouter.sol:703-829; contracts/gmp/Mailbox.sol:426-505", markerEvidence: refs("staked-lbtc-source", ["return $.assetRouter.mint(rawPayload, proof)"]) },
    { component: "Canonical Ethereum StakedLBTC — BTC redemption", finding: "redeemForBtc forwards a burn/request through AssetRouter; local documentation describes an asynchronous UnstakeRequest process. This maps request architecture, not BTC backing or fulfillment.", refs: "contracts/LBTC/StakedLBTC.sol:400-420; contracts/LBTC/AssetRouter.sol:478-523; docs/redeem.md:64-71", markerEvidence: refs("staked-lbtc-source", ["$.assetRouter.redeemForBtc"]) },
    { component: "Canonical Ethereum StakedLBTC — burn authority", finding: "A holder can burn its own balance, while MINTER_ROLE can burn from an arbitrary holder.", refs: "contracts/LBTC/StakedLBTC.sol:422-436", markerEvidence: refs("staked-lbtc-source", ["Burns LBTC from an arbitrary holder; minter-only."]) },
    { component: "StakedLBTC / NativeLBTC conversion", finding: "StakedLBTC redeem converts toward NativeLBTC through AssetRouter, while deposit burns NativeLBTC and queues a Ledger deposit toward StakedLBTC. Conversion accounting and backing are not proven.", refs: "contracts/LBTC/StakedLBTC.sol:438-458; contracts/LBTC/AssetRouter.sol:524-635", markerEvidence: refs("staked-lbtc-source", ["$.assetRouter.redeem(_msgSender(), address(this), amount)", "$.assetRouter.deposit(_msgSender(), address(this), amount)"]) },
    { component: "StakedLBTCOracle exchange-rate surface", finding: "Ratio publication is Consortium-signed; owner can change Consortium, ahead interval, and ratio threshold. The separate oracle drives ratio/rate surfaces and is owner-configurable, not backing proof.", refs: "contracts/LBTC/StakedLBTCOracle.sol:104-159, 196-257", markerEvidence: refs("staked-oracle-source", ["function changeConsortium", "function updateRatioThreshold", "function publishNewRatio", "$.consortium.checkProof(payloadHash, proof)"]) },
    { component: "NativeLBTC DepositV1 replay and proof scope", finding: "NativeLBTC DepositV1 payload binds chain/recipient/amount/nonzero txid/vout/token and blocks exact payload-hash replay, but does not independently prove BTC inclusion/ownership/amount correctness or UTXO uniqueness across differently encoded payloads.", refs: "contracts/LBTC/NativeLBTC.sol:392-489; contracts/libs/Actions.sol:14-22, 183-218", markerEvidence: `${refs("native-lbtc-source", ["usedPayloads[payloadHash]", "checkProof(payloadHash, proof)"])}, ${refs("actions-source", ["function depositBtcV1", "if (token != address(this))"])}` },
    { component: "Canonical StakedLBTC release/GMP replay domain", finding: "Canonical StakedLBTC release body has token/recipient/amount. GMP path, nonce, sender, recipient, destination caller, and body are included in signed raw payload; replay is exact payload-ID/hash bookkeeping at Mailbox/handler, not independent nonce or source-message uniqueness enforcement. Path domain binds source contract/source chain/destination chain. UTXO correctness remains Ledger/Consortium/optional-Bascule trust.", refs: "contracts/LBTC/libraries/Assets.sol:28-31, 145-183; contracts/gmp/libs/GMPUtils.sol:18-75; contracts/gmp/libs/MessagePath.sol:4-20; contracts/gmp/Mailbox.sol:426-505; contracts/LBTC/AssetRouter.sol:783-810", markerEvidence: `${refs("assets-source", ["struct Release", "function decodeRelease", "Release(toToken, recipient, amount)"])}, ${refs("gmp-utils-source", ["struct Payload", "msgNonce", "msgSender", "msgRecipient", "msgDestinationCaller", "msgBody"])}, ${refs("message-path-source", ["sourceContract", "sourceChain", "destinationChain"])}, ${refs("mailbox-source", ["deliveredPayload[payloadHash]"])}, ${refs("asset-router-source", ["usedPayloads[payload.id]"])}` },
    { component: "Consortium threshold proof", finding: "Source sums validator weights to a stored threshold and permits proof-authorized rotation; current epoch, weights, threshold, and rotation history remain unknown.", refs: "contracts/consortium/Consortium.sol:91-118, 140-159, 165-240", markerEvidence: refs("consortium-source", ["function _checkProof", "weightThreshold", "revert NotEnoughSignatures"]) },
    { component: "Bascule configurability", finding: "NativeLBTC and AssetRouter Bascule addresses are independently admin-configurable and disableable. A nonzero validation threshold permits unreported below-threshold operations; zero validates every nonzero operation.", refs: "contracts/LBTC/NativeLBTC.sol:104-115, 481-503; contracts/LBTC/AssetRouter.sol:316-337, 817-836; contracts/bascule/Bascule.sol:28-41, 268-293; contracts/bascule/GMPBasculeV1.sol:42-55, 231-259", markerEvidence: `${refs("native-lbtc-source", ["function changeBascule"])}, ${refs("asset-router-source", ["function changeBascule"])}, ${refs("bascule-source", ["allows all withdrawals below this", "When the threshold is zero", "function validateWithdrawal"])}, ${refs("gmp-bascule-source", ["allows all mints below this", "When the threshold is zero", "function validateMint"])}` },
    { component: "BridgeV2 controls", finding: "BridgeV2 source contains admin-configurable sender/path/token/rate-limit surfaces plus outbound burn and inbound Mailbox/source/replay/rate-limit checks; deployed configuration and reachability are unverified.", refs: "contracts/bridge/BridgeV2.sol:86-292, 473-545, 582-641", markerEvidence: refs("bridge-v2-source", ["function setDestinationBridge", "function addDestinationToken", "function setTokenRateLimits", "function setSenderConfig", "BridgeV2_SenderNotWhitelisted", "BridgeV2_MailboxExpected", "BridgeV2_PayloadSpent", "RateLimits.updateLimit"]) },
  ].map((row) => ({ ...row, evidenceClass: "local-source-marker-presence-only", traceStatus: "architecture-summary-requires-step-2-function-body-trace", vulnerabilityClaim: false }));
}

function bridgeSourceMapping(manifest) {
  const evidence = (id) => manifest.find((row) => row.id === id).path;
  return [
    { configuredFamilyReference: "Chainlink CCIP", sourceMode: "CCIP TokenPool lockOrBurn/releaseOrMint callbacks invoke BridgeV2/Mailbox paths; owner-set pool paths are separate configuration", sourceInputs: [evidence("ccip-pool-source"), evidence("bridge-v2-source"), evidence("mailbox-source")] },
    { configuredFamilyReference: "LayerZero lock-style OFT", sourceMode: "OFT adapter custody/lock style with owner empty() burning locked LBTC", sourceInputs: [evidence("oft-lock-source")] },
    { configuredFamilyReference: "LayerZero burn/mint OFT", sourceMode: "OFT debit burns holder tokens and credit mints destination tokens", sourceInputs: [evidence("oft-burn-mint-source")] },
    { configuredFamilyReference: "IBC", sourceMode: "IBCVoucher wraps by burning LBTC, spends by minting LBTC, and has role/admin rate-limit controls", sourceInputs: [evidence("ibc-voucher-source")] },
    { configuredFamilyReference: "Native Mailbox/BridgeV2", sourceMode: "BridgeV2 admin controls and Mailbox proof/replay handler path", sourceInputs: [evidence("bridge-v2-source"), evidence("mailbox-source")] },
    { configuredFamilyReference: "Deprecated Bridge configured context", sourceMode: "mainnet.json deprecated Bridge reference; withdrawal conditionally requires adapter confirmation and/or Consortium confirmation because each confirmation requirement is optional, with replay state in source", sourceInputs: [evidence("deprecated-bridge-source")] },
  ].map((row) => ({ ...row, evidenceClass: "local-source-marker-presence-only", traceStatus: "architecture-summary-requires-step-2-function-body-trace", deploymentStatus: "unverified", conservationConclusion: "none" }));
}

function render(raw) {
  const lines = ["# Lombard LBTC Step-1 Deterministic Offline Discovery", "", `Signal: **${raw.signal}**`, "", `Classification: **${raw.classification}**`, "", `Snapshot label: \`${raw.snapshotLabel}\`. Output is deterministic for unchanged scanner, local inputs, and Git state; no runtime timestamp is emitted.`, "", "## Scope and safety", "", "- Deterministic local filesystem/hash and read-only Git only. No network, endpoint inventory, secrets, live calls, builds, tests, transactions, signing, forks, wallets, or executor.", `- Source checkout HEAD: \`${raw.sourceCheckout.head}\`; dirty: \`${raw.sourceCheckout.dirty}\`. \`.yarnrc.yml\` is observed only as untracked in Git status and was not read; its relevance was not independently assessed. The checkout is **not pristine**.`, "- No vulnerability or backing/conservation conclusion is claimed. Marker presence supports partial architecture summaries only; step-2 function-body trace is required.", "- The May 31 block-pinned live artifact is stale baseline context, not current proof. Older CLEAN wording is downgraded because freshness and scope gaps prevent closure.", "", "## Canonical token identity", "", `- Canonical Ethereum StakedLBTC: \`${raw.tokenIdentity.canonicalEthereumStakedLBTC.address}\` from \`mainnet.json\`.`, `- Separate Ethereum NativeLBTC/BTC.b: \`${raw.tokenIdentity.nativeLBTCBTCb.address}\` from \`mainnet.json\`. It is not canonical StakedLBTC and symbol-only BTC.b rows are not promoted.`, "", "## Metrics", "", `- namedChainConfigs=${raw.summary.namedChainConfigs}; configuredFamilyReferences=${raw.summary.configuredFamilyReferences}; localInputs=${raw.summary.localInputs}; trackedInputsWithBlobIds=${raw.summary.trackedInputsWithBlobIds}; sourceFindings=${raw.summary.sourceFindings}; exactAddressConsumerRows=${raw.summary.exactAddressConsumerRows}`, `- vulnerabilityClaims=${raw.vulnerabilityClaims}; priorLombardRoutePositiveClaims=${raw.priorLombardRoutePositiveClaims}; routePositive=${raw.routePositive} (zero proven positive routes, not a negative assessment); routeEvidenceStatus=${raw.routeEvidenceStatus}; evidenceComplete=${raw.evidenceComplete}; closureEligible=${raw.closureEligible}; executableNow=${raw.executableNow}`, "", "## Partial local-source architecture summaries", ""];
  for (const row of raw.sourceFindings) lines.push(`- **${row.component}** — ${row.finding} (${row.refs})`);
  lines.push("", "Every row above is `local-source-marker-presence-only`, is a hardcoded architecture summary, and requires step-2 function-body trace.", "", "## Redemption, threshold, Bascule, deployments, and audits", "", "- Redemption is asynchronous. Local `docs/redeem.md:64-71` says up to seven days; librarian-recorded May 28 public research says up to ten days. This recorded-unverified discrepancy is unresolved.", "- Threshold observations are stale and non-comparable: May 28 recorded docs say 10/14; the May 31 chain snapshot says equal-weight 12/16. Neither is current. Current epoch, weights, threshold, and rotation history are unknown.", "- Bascule is independently admin-configurable/disableable on NativeLBTC and AssetRouter. Nonzero threshold permits unreported below-threshold operations; zero validates every nonzero operation. May 31 NativeLBTC zero-address versus AssetRouter GMP Bascule configured threshold-zero is stale.", `- \`mainnet.json\` has ${raw.deploymentMap.namedChainConfigCount} named chain configurations and ${raw.deploymentMap.configuredFamilyReferences.length} configured family references: ${raw.deploymentMap.configuredFamilyReferences.join(", ")}. These are references, not verified deployments.`, `- Bundled audit index contains ${raw.auditContext.auditRows} report rows, but warns contracts may have changed; there is no audit-to-current-deployed-bytecode applicability proof.`, "", "## Configured-family source mapping", "");
  for (const row of raw.bridgeSourceMapping) lines.push(`- **${row.configuredFamilyReference}** — ${row.sourceMode}. Deployment status=${row.deploymentStatus}; conservation conclusion=${row.conservationConclusion}.`);
  lines.push("", "Per-chain deployment, token, peer, mode, rate-limit, pause, and reachability remain unverified. No supply conservation conclusion is made.", "", "## Scope separation", "");
  for (const row of raw.scopeSeparation) lines.push(`- **${row.scope}** — ${row.treatment}`);
  lines.push("", "## Exact-address third-party consumer context", "", `Filter scope is LBTC-as-collateral only and requires chainId=1 where present plus exact full canonical StakedLBTC address \`${raw.consumerEvidence.canonicalAddress}\`. BTC.b, symbol-only LBTC, abbreviated addresses, and non-Lombard rows are excluded. Deduplicated rows: ${raw.consumerEvidence.exactAddressRowCount}. Current route status is not currently assessed.`, "");
  for (const row of raw.consumerEvidence.exactAddressRows) lines.push(`- ${row.protocol} / ${row.chain}: consumer \`${row.consumer}\`; ${row.context}; sourceGeneratedAt=${row.sourceGeneratedAt}; sourceRoutePositive=${row.sourceRoutePositive}; currentRouteStatus=${row.currentRouteStatus}.`);
  lines.push("", "## Recorded-unverified public research (non-evidence)", "");
  for (const fact of raw.recordedPublicAssertions) lines.push(`- **${fact.id}** — ${fact.statement} [${fact.verificationStatus}; fetchedByScanner=${fact.fetchedByScanner}; captureDate=${fact.captureDate}; authoring=${fact.authoringProvenance}] ${fact.sourceUrl}`);
  lines.push("", "## Provenance", "");
  lines.push(`- Scanner \`${raw.provenance.scanner.path}\` — SHA-256 \`${raw.provenance.scanner.sha256}\`.`);
  for (const item of raw.provenance.localInputs) lines.push(`- \`${item.path}\` — SHA-256 \`${item.sha256}\`; Git blob=${item.gitBlobId || "not-applicable"}; bytes=${item.bytes}; markers=${item.markerChecks.length}/${item.markerChecks.length}.`);
  lines.push("", "## Gates and required next step", "", `- routePositive=${raw.routePositive}; routeEvidenceStatus=${raw.routeEvidenceStatus}; evidenceComplete=${raw.evidenceComplete}; closureEligible=${raw.closureEligible}; executableNow=${raw.executableNow}; signedActionJustified=${raw.signedActionJustified}; forkJustified=${raw.forkJustified}.`, `- **Required next step:** ${raw.requiredNextStep}`, "- No fork/executor is justified.", "");
  return lines.join("\n");
}

function selfCheck(raw) {
  const required = INPUTS.map((x) => x.path);
  if (raw.snapshotLabel !== SNAPSHOT_LABEL || Object.prototype.hasOwnProperty.call(raw, "generatedAt") || raw.sourceCheckout.head !== EXPECTED_COMMIT) throw new Error("snapshot/commit self-check failed");
  if (!raw.sourceCheckout.dirty || raw.sourceCheckout.statusShort.join("\n") !== "?? .yarnrc.yml") throw new Error("dirty caveat self-check failed");
  if (raw.provenance.localInputs.length !== required.length || !required.every((p) => raw.provenance.localInputs.some((x) => x.path === p && /^[0-9a-f]{64}$/.test(x.sha256)))) throw new Error("path/hash self-check failed");
  if (!raw.provenance.localInputs.every((x) => x.markerChecks.every((m) => m.found && Number.isInteger(m.line)))) throw new Error("marker self-check failed");
  const tracked = raw.provenance.localInputs.filter((x) => x.path.startsWith("targets/lombard-evm-smart-contracts/"));
  if (!tracked.every((x) => /^[0-9a-f]{40}$/.test(x.gitBlobId))) throw new Error("Git blob self-check failed");
  const scannerBytes = fs.readFileSync(path.join(ROOT, SCANNER));
  if (raw.provenance.scanner.sha256 !== hash(scannerBytes)) throw new Error("scanner hash self-check failed");
  if (!raw.recordedPublicAssertions.every((x) => x.verificationStatus === "recorded-unverified" && x.evidenceClass === "recorded-unverified-non-evidence" && x.fetchedByScanner === false && x.captureDate === "2026-05-28" && x.authoringProvenance === "librarian-recorded-for-step1" && /^https:\/\//.test(x.sourceUrl))) throw new Error("external label self-check failed");
  if (raw.consumerEvidence.exactAddressRowCount !== 7 || raw.consumerEvidence.exactAddressRows.some((x) => x.chainId !== 1 || !exact(x.asset) || x.currentRouteStatus !== "unknown-not-refreshed" || Object.prototype.hasOwnProperty.call(x, "routePositive")) || raw.consumerEvidence.btcDotBRowsPromoted !== 0 || raw.consumerEvidence.nonLombardRowsPromoted !== 0) throw new Error("consumer filter self-check failed");
  if (![...raw.sourceFindings, ...raw.bridgeSourceMapping].every((x) => x.evidenceClass === "local-source-marker-presence-only" && x.traceStatus === "architecture-summary-requires-step-2-function-body-trace")) throw new Error("source evidence label self-check failed");
  if (!raw.thresholdObservations.thresholdObservationConflict || raw.thresholdObservations.currentEpoch !== "unknown" || raw.deploymentMap.configuredFamilyReferences.length !== 4) throw new Error("threshold/family self-check failed");
  if (raw.vulnerabilityClaims !== 0 || raw.priorLombardRoutePositiveClaims !== 0 || raw.routePositive !== 0 || raw.routeEvidenceStatus !== "unknown" || raw.evidenceComplete || raw.closureEligible || raw.executableNow !== 0 || raw.signedActionJustified || raw.forkJustified) throw new Error("gate self-check failed");
  if (Object.values(raw.safety).some((value) => value !== false) || raw.deploymentMap.namedChainConfigCount !== 19) throw new Error("safety/deployment self-check failed");
  return { status: "passed", requiredPaths: required.length, inputHashes: required.length, scannerHash: "passed", trackedGitBlobIds: tracked.length, markerChecks: raw.provenance.localInputs.reduce((n, x) => n + x.markerChecks.length, 0), exactAddressConsumerFiltering: "passed-7-unique", externalAssertionLabels: "passed-non-evidence", sourceEvidenceLabels: "passed-marker-presence-only", duplicateKeys: "passed-by-object-construction", unsafeActions: "none", gates: "passed-fail-closed" };
}

function main() {
  const { loaded, manifest } = loadInputs();
  const head = git("rev-parse", "HEAD");
  const statusShort = git("status", "--short").split(/\r?\n/).filter(Boolean);
  const deployments = loaded["deployment-map"].parsed;
  const chains = Object.keys(deployments);
  const configuredFamilyReferences = ["native Mailbox/BridgeV2", "Chainlink CCIP", "LayerZero OFT", "IBC"].filter((family) => family.startsWith("native") || chains.some((name) => {
    const row = deployments[name];
    return family.includes("Chainlink") ? !!row.chainlink : family.includes("LayerZero") ? !!row.layerZero : !!row.IBC;
  }));
  const consumers = consumerEvidence(loaded);
  const findings = sourceFindings(manifest);
  const bridgeRows = bridgeSourceMapping(manifest);
  const scannerBuffer = fs.readFileSync(path.join(ROOT, SCANNER));
  const mainnetLombard = deployments.mainnet.lombard;
  const raw = {
    snapshotLabel: SNAPSHOT_LABEL,
    deterministicOutputPolicy: "No runtime generatedAt is emitted. For unchanged scanner, local inputs, and read-only Git state, output content is deterministic.",
    scanner: SCANNER,
    signal: "🟠 WATCH",
    classification: "INCOMPLETE/WATCH — PARTIAL LOCAL SOURCE MAPPING, CURRENT STATE/BACKING/DEPLOYED MATCH BLOCKED",
    scope: "Lombard LBTC step-1 deterministic offline discovery",
    sourceCheckout: { path: "targets/lombard-evm-smart-contracts", expectedHead: EXPECTED_COMMIT, head, headMatches: head === EXPECTED_COMMIT, dirty: statusShort.length > 0, pristine: false, statusShort, dirtyCaveat: ".yarnrc.yml was observed only as untracked in Git status and was not read; its relevance was not independently assessed." },
    safety: { networkCalls: false, liveCalls: false, endpointInventoryReads: false, secretReads: false, builds: false, tests: false, transactions: false, signing: false, forks: false, wallets: false, executor: false },
    provenance: { policy: "Every local input is loaded, marker-checked, and SHA-256 hashed; tracked checkout inputs include commit blob IDs; public assertions are recorded-unverified non-evidence and not fetched.", scanner: { path: SCANNER, bytes: scannerBuffer.length, sha256: hash(scannerBuffer) }, localInputs: manifest },
    tokenIdentity: {
      canonicalEthereumStakedLBTC: { configPath: "mainnet.lombard.StakedLBTC", address: mainnetLombard.StakedLBTC, role: "canonical Ethereum StakedLBTC", backingProven: false },
      nativeLBTCBTCb: { configPath: "mainnet.lombard.NativeLBTC", address: mainnetLombard.NativeLBTC, role: "separate NativeLBTC/BTC.b", backingProven: false },
      distinct: mainnetLombard.StakedLBTC.toLowerCase() !== mainnetLombard.NativeLBTC.toLowerCase(),
    },
    deploymentMap: { namedChainConfigCount: chains.length, namedChainConfigs: chains, configuredFamilyReferences, configuredReferencesAreVerifiedDeployments: false, deploymentStateVerifiedCurrent: false },
    sourceFindings: findings,
    bridgeSourceMapping: bridgeRows,
    auditContext: { auditRows: loaded["audit-index"].text.split(/\r?\n/).filter((line) => /^\| (?!-)/.test(line)).length - 1, codeMayHaveChangedWarning: true, auditToDeployedBytecodeApplicabilityProven: false },
    staleBaseline: { path: "reports/raw/fast/lombard-live.json", sourceGeneratedAt: loaded["stale-live-baseline"].parsed.generatedAt, blockPinned: true, currentProof: false, treatment: "stale-context-only" },
    priorTriageCorrection: { path: "reports/lombard-triage.md", priorSignal: "CLEAN", currentTreatment: "downgraded-to-INCOMPLETE/WATCH", reason: "freshness, chain-scope, backing, authority, and deployed-bytecode applicability gaps", positiveClaimsCarriedForward: 0 },
    scopeSeparation: [
      { scope: "Core LBTC", treatment: "Staked/non-rebasing LBTC source and Ethereum canonical address context; current backing and exchange rate not verified." },
      { scope: "BTC.b", treatment: "NativeLBTC/BTC.b is a separate token identity and is not promoted from symbol-only third-party rows." },
      { scope: "Bridges/adapters", treatment: "Configured/source references for Native Mailbox/BridgeV2, CCIP, IBC, and OFT exist; path configuration and multichain conservation are unverified." },
      { scope: "Ledger/CubeSigner/Bascule offchain trust", treatment: "Separate notarization, key custody, monitoring, and reverse-monitoring trust boundaries; recorded-unverified current operation." },
      { scope: "Babylon staking/yield", treatment: "Underlying staking/yield and slash/reward behavior is separate from EVM receipt correctness and not validated here." },
      { scope: "Third-party consumers", treatment: "Only exact canonical-address LBTC-as-collateral matches are context; current consumer oracle/liquidation/economic behavior is not currently assessed." },
    ],
    consumerEvidence: consumers,
    recordedPublicAssertions: PUBLIC_ASSERTIONS,
    thresholdObservations: { thresholdObservationConflict: true, comparability: "stale-non-comparable-conflicting-observations", may28RecordedDocs: "10/14", may31ChainSnapshot: "equal-weight 12/16", neitherCurrent: true, currentEpoch: "unknown", currentWeights: "unknown", currentThreshold: "unknown", currentRotationHistory: "unknown", requiresCurrentFixedBlockVerification: true },
    basculeObservations: { independentlyAdminConfigurableAndDisableable: true, nonzeroThresholdEffect: "unreported below-threshold operations permitted", zeroThresholdEffect: "every nonzero operation validated", may31NativeLBTC: "zero-address-stale", may31AssetRouterGMPBascule: "configured-threshold-zero-stale", currentState: "unknown" },
    discrepancyFlags: { chainListDiscrepancy: true, redemptionDaysDiscrepancy: "local=up to seven; May 28 recorded research=up to ten; unresolved" },
    summary: { localInputs: manifest.length, namedChainConfigs: chains.length, configuredFamilyReferences: configuredFamilyReferences.length, bridgeSourceMappingRows: bridgeRows.length, trackedInputsWithBlobIds: manifest.filter((x) => x.gitBlobId).length, sourceFindings: findings.length, exactAddressConsumerRows: consumers.exactAddressRowCount, duplicateConsumerCandidatesRemoved: consumers.duplicateCandidatesRemoved, recordedPublicAssertions: PUBLIC_ASSERTIONS.length, vulnerabilityClaims: 0 },
    vulnerabilityClaims: 0,
    priorLombardRoutePositiveClaims: 0,
    routePositive: 0,
    routePositiveMeaning: "zero proven positive routes; not a negative assessment",
    routeEvidenceStatus: "unknown",
    evidenceComplete: false,
    closureEligible: false,
    executableNow: 0,
    signedActionJustified: false,
    forkJustified: false,
    requiredNextStep: "Pinned-source end-to-end mint/redeem/bridge authority trace plus current sanitized read-only deployed implementation/roles/threshold/Bascule/rate-limit and backing-vs-multichain-supply reconciliation. No fork/executor.",
  };
  if (!raw.sourceCheckout.headMatches) throw new Error(`unexpected source HEAD: ${head}`);
  raw.selfChecks = selfCheck(raw);
  writeOwned(OUT_JSON, `${JSON.stringify(raw, null, 2)}\n`);
  writeOwned(OUT_MD, `${render(raw)}\n`);
  console.log(`wrote ${OUT_JSON} and ${OUT_MD}`);
  console.log(`localInputs=${raw.summary.localInputs} namedChainConfigs=${raw.summary.namedChainConfigs} configuredFamilyReferences=${raw.summary.configuredFamilyReferences} bridgeSourceMappingRows=${raw.summary.bridgeSourceMappingRows} trackedInputsWithBlobIds=${raw.summary.trackedInputsWithBlobIds} sourceFindings=${raw.summary.sourceFindings} exactAddressConsumerRows=${raw.summary.exactAddressConsumerRows} duplicateConsumerCandidatesRemoved=${raw.summary.duplicateConsumerCandidatesRemoved} recordedPublicAssertions=${raw.summary.recordedPublicAssertions} vulnerabilityClaims=${raw.vulnerabilityClaims}`);
  console.log(`selfChecks=${raw.selfChecks.status} requiredPaths=${raw.selfChecks.requiredPaths} inputHashes=${raw.selfChecks.inputHashes} scannerHash=${raw.selfChecks.scannerHash} trackedGitBlobIds=${raw.selfChecks.trackedGitBlobIds} markerChecks=${raw.selfChecks.markerChecks} duplicateKeys=${raw.selfChecks.duplicateKeys} unsafeActions=${raw.selfChecks.unsafeActions}`);
  console.log(`classification=${raw.classification} routePositive=${raw.routePositive} routeEvidenceStatus=${raw.routeEvidenceStatus} evidenceComplete=${raw.evidenceComplete} closureEligible=${raw.closureEligible} executableNow=${raw.executableNow} signedActionJustified=${raw.signedActionJustified} forkJustified=${raw.forkJustified}`);
}

try { main(); } catch (error) { console.error(`scan-lombard-lbtc-readonly-discovery failed: ${error.message}`); process.exitCode = 1; }
