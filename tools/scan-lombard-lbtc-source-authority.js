#!/usr/bin/env node
"use strict";

// Lombard LBTC step-2 deterministic offline source-authority mapper.
// Reads pinned local source and read-only Git metadata only. No network, endpoint,
// secret, build, test, transaction, signing, fork, wallet, or executor code exists.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const REPO = path.join(ROOT, "targets", "lombard-evm-smart-contracts");
const COMMIT = "5ec153c2803991ac2b0240565b1498d85375c7a5";
const SNAPSHOT = "2026-07-11-lombard-step2";
const SCANNER = "tools/scan-lombard-lbtc-source-authority.js";
const OUT_JSON = "reports/raw/fast/lombard-lbtc-source-authority.json";
const OUT_MD = "reports/lombard-lbtc-source-authority-triage.md";
const WRITES = new Set([OUT_JSON, OUT_MD]);
const P = "targets/lombard-evm-smart-contracts/";

const FILES = {
  mainnet: "mainnet.json",
  base: "contracts/LBTC/BaseLBTC.sol",
  staked: "contracts/LBTC/StakedLBTC.sol",
  native: "contracts/LBTC/NativeLBTC.sol",
  router: "contracts/LBTC/AssetRouter.sol",
  assets: "contracts/LBTC/libraries/Assets.sol",
  validation: "contracts/LBTC/libraries/Validation.sol",
  assert: "contracts/LBTC/libraries/Assert.sol",
  actions: "contracts/libs/Actions.sol",
  oracle: "contracts/LBTC/StakedLBTCOracle.sol",
  gmp: "contracts/gmp/libs/GMPUtils.sol",
  path: "contracts/gmp/libs/MessagePath.sol",
  mailbox: "contracts/gmp/Mailbox.sol",
  consortium: "contracts/consortium/Consortium.sol",
  bascule: "contracts/bascule/Bascule.sol",
  gmpBascule: "contracts/bascule/GMPBasculeV1.sol",
  bridge2: "contracts/bridge/BridgeV2.sol",
  bridge: "contracts/bridge/Bridge.sol",
  ccip: "contracts/bridge/providers/LombardTokenPoolV2.sol",
  oftEscrow: "contracts/bridge/oft/LBTCOFTAdapter.sol",
  oftBurnMint: "contracts/bridge/oft/LBTCBurnMintOFTAdapter.sol",
  oftRateAdapter: "contracts/bridge/oft/EfficientRateLimitedOFTAdapter.sol",
  oftRate: "contracts/bridge/oft/EfficientRateLimiter.sol",
  ibc: "contracts/ibc/IBCVoucher.sol",
  rateLimits: "contracts/libs/RateLimits.sol",
};

function sha(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function git(...args) { return execFileSync("git", args, { cwd: REPO, encoding: "utf8", windowsHide: true }).trim(); }
function rel(file) { return path.relative(ROOT, file).replace(/\\/g, "/"); }
function writeOwned(name, content) {
  if (!WRITES.has(name)) throw new Error(`write refused: ${name}`);
  const file = path.join(ROOT, name);
  if (!fs.existsSync(path.dirname(file))) throw new Error(`missing output directory: ${rel(path.dirname(file))}`);
  fs.writeFileSync(file, content, "utf8");
}

function loadSources() {
  const loaded = {};
  const manifest = [];
  for (const [key, repoPath] of Object.entries(FILES)) {
    const absolute = path.join(REPO, repoPath);
    if (!fs.existsSync(absolute)) throw new Error(`missing source: ${repoPath}`);
    const buffer = fs.readFileSync(absolute);
    const text = buffer.toString("utf8");
    loaded[key] = text;
    const blob = git("rev-parse", `${COMMIT}:${repoPath}`);
    manifest.push({ key, path: `${P}${repoPath}`, bytes: buffer.length, sha256: sha(buffer), gitBlobId: blob, trackedAtCommit: true });
  }
  return { loaded, manifest };
}

// Lexically mask comments and quoted strings before discovery. Every non-newline
// masked byte becomes a space, preserving offsets and line numbers exactly.
function maskSolidity(text) {
  const out = text.split("");
  let state = "code", quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (state === "line") { if (c === "\n" || c === "\r") state = "code"; else out[i] = " "; continue; }
    if (state === "block") { if (c === "*" && n === "/") { out[i] = out[i + 1] = " "; i++; state = "code"; } else if (c !== "\n" && c !== "\r") out[i] = " "; continue; }
    if (state === "string") { if (c === "\\") { out[i] = " "; if (i + 1 < text.length && text[i + 1] !== "\n" && text[i + 1] !== "\r") out[++i] = " "; continue; } if (c === quote) { out[i] = " "; state = "code"; } else if (c !== "\n" && c !== "\r") out[i] = " "; continue; }
    if (c === "/" && n === "/") { out[i] = out[i + 1] = " "; i++; state = "line"; continue; }
    if (c === "/" && n === "*") { out[i] = out[i + 1] = " "; i++; state = "block"; continue; }
    if (c === "\"" || c === "'") { out[i] = " "; state = "string"; quote = c; }
  }
  return out.join("");
}

function matchingParen(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "(") depth++;
    else if (masked[i] === ")" && --depth === 0) return i;
  }
  throw new Error("unbalanced parameter list");
}
function splitTopLevel(value) {
  const out = []; let start = 0, p = 0, b = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") p++; else if (value[i] === ")") p--;
    else if (value[i] === "[") b++; else if (value[i] === "]") b--;
    else if (value[i] === "," && p === 0 && b === 0) { out.push(value.slice(start, i)); start = i + 1; }
  }
  if (value.slice(start).trim()) out.push(value.slice(start));
  return out;
}
function parseParameter(param) {
  const clean = param.replace(/\b(calldata|memory|storage)\b/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  let depth = 0, split = -1;
  for (let i = clean.length - 1; i >= 0; i--) {
    if (clean[i] === ")" || clean[i] === "]") depth++;
    else if (clean[i] === "(" || clean[i] === "[") depth--;
    else if (/\s/.test(clean[i]) && depth === 0) { split = i; break; }
  }
  let type = split < 0 ? clean : clean.slice(0, split).trim();
  let name = split < 0 ? null : clean.slice(split + 1).trim();
  if (name && !/^[A-Za-z_$][\w$]*$/.test(name)) { type = clean; name = null; }
  type = type.replace(/\s+/g, "").replace(/^uint$/, "uint256").replace(/^int$/, "int256");
  return { type, name: name || "unnamed" };
}

function solidityFunctions(text, file) {
  const masked = maskSolidity(text);
  const rows = [];
  const re = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let match;
  while ((match = re.exec(masked))) {
    const start = match.index;
    const paramOpen = masked.indexOf("(", start);
    const paramClose = matchingParen(masked, paramOpen);
    const parameters = splitTopLevel(text.slice(paramOpen + 1, paramClose)).map(parseParameter).filter(Boolean);
    const canonicalSignature = `${match[1]}(${parameters.map((p) => p.type).join(",")})`;
    let i = paramClose + 1;
    let open = -1;
    for (; i < masked.length; i++) {
      if (masked[i] === ";") break;
      if (masked[i] === "{") { open = i; break; }
    }
    if (open < 0) continue;
    let depth = 0, end = -1;
    for (i = open; i < masked.length; i++) {
      if (masked[i] === "{") depth++;
      if (masked[i] === "}" && --depth === 0) { end = i + 1; break; }
    }
    if (end < 0) throw new Error(`unclosed function ${match[1]} in ${file}`);
    const segment = text.slice(start, end);
    const header = text.slice(start, open).replace(/\s+/g, " ").trim();
    rows.push({ name: match[1], header, text: segment, parameters, canonicalSignature, canonicalSignatureHash: sha(canonicalSignature), startLine: text.slice(0, start).split(/\r?\n/).length, endLine: text.slice(0, end).split(/\r?\n/).length });
    re.lastIndex = end;
  }
  return rows;
}

function solidityConstructors(text, file) {
  const masked = maskSolidity(text);
  const rows = [];
  const re = /\bconstructor\s*\(/g;
  let match;
  while ((match = re.exec(masked))) {
    const start = match.index, paramOpen = masked.indexOf("(", start), paramClose = matchingParen(masked, paramOpen);
    const parameters = splitTopLevel(text.slice(paramOpen + 1, paramClose)).map(parseParameter).filter(Boolean);
    const canonicalSignature = `constructor(${parameters.map((p) => p.type).join(",")})`;
    let open = -1;
    for (let i = paramClose + 1; i < masked.length; i++) { if (masked[i] === ";") break; if (masked[i] === "{") { open = i; break; } }
    if (open < 0) continue;
    let depth = 0, end = -1;
    for (let i = open; i < masked.length; i++) { if (masked[i] === "{") depth++; if (masked[i] === "}" && --depth === 0) { end = i + 1; break; } }
    if (end < 0) throw new Error(`unclosed constructor in ${file}`);
    rows.push({ name: "constructor", header: text.slice(start, open).replace(/\s+/g, " ").trim(), text: text.slice(start, end), parameters, canonicalSignature, canonicalSignatureHash: sha(canonicalSignature), startLine: text.slice(0, start).split(/\r?\n/).length, endLine: text.slice(0, end).split(/\r?\n/).length });
    re.lastIndex = end;
  }
  return rows;
}

function extractorFixtureSelfTest() {
  const fixture = [
    "contract Fixture {",
    "  // function commented(uint256 x) external { }",
    "  string constant noise = \"function stringFake(address x) { } }\";",
    "  function overloaded(uint256 value) external { if (value > 0) { { value; } } }",
    "  /* function blocked(bytes memory x) internal { } */",
    "  function overloaded(address who) external { bytes memory x = bytes(\"{ function fake() }\"); who; x; }",
    "  function _underscored(uint256[] calldata values) internal { for (uint256 i; i < values.length; i++) { values[i]; } }",
    "}",
  ].join("\n");
  const found = solidityFunctions(fixture, "embedded-fixture.sol");
  const signatures = found.map((f) => f.canonicalSignature);
  const cases = {
    commentFunctionMasked: !signatures.some((s) => s.startsWith("commented(")),
    blockCommentFunctionMasked: !signatures.some((s) => s.startsWith("blocked(")),
    stringFunctionMasked: !signatures.some((s) => s.startsWith("stringFake(") || s.startsWith("fake(")),
    nestedBracesRange: found.find((f) => f.canonicalSignature === "overloaded(uint256)")?.startLine === 4 && found.find((f) => f.canonicalSignature === "overloaded(uint256)")?.endLine === 4,
    overloadsCanonical: signatures.includes("overloaded(uint256)") && signatures.includes("overloaded(address)"),
    underscorePreserved: signatures.includes("_underscored(uint256[])") && found.find((f) => f.name === "_underscored")?.startLine === 7,
  };
  if (!Object.values(cases).every(Boolean) || found.length !== 3) throw new Error(`extractor fixture failed: ${JSON.stringify({ cases, signatures })}`);
  return { status: "PASS", fixtureFunctions: found.length, caseCount: Object.keys(cases).length, cases, canonicalSignatures: signatures };
}

function spec(component, rail, file, name, occurrence = 1, markers = [], meta = {}) {
  return { component, rail, file, name, legacyOccurrence: occurrence, markers, ...meta };
}

const SPECS = [
  // Base pause matrix.
  spec("BaseLBTC", "shared-token", "base", "pauseMintBurn", 1, ["MINT_BURN_PAUSER_ROLE", "mintBurnPaused = true"], { actor: "MINT_BURN_PAUSER_ROLE", accounting: "sets mint/burn guard true" }),
  spec("BaseLBTC", "shared-token", "base", "unpauseMintBurn", 1, ["DEFAULT_ADMIN_ROLE", "mintBurnPaused = false"], { actor: "DEFAULT_ADMIN_ROLE", accounting: "sets mint/burn guard false" }),
  spec("BaseLBTC", "shared-token", "base", "pauseTransfers", 1, ["PAUSER_ROLE", "_pause()"], { actor: "PAUSER_ROLE", accounting: "activates ERC20Pausable" }),
  spec("BaseLBTC", "shared-token", "base", "unpauseTransfers", 1, ["DEFAULT_ADMIN_ROLE", "_unpause()"], { actor: "DEFAULT_ADMIN_ROLE", accounting: "clears ERC20Pausable" }),

  // Canonical StakedLBTC.
  spec("StakedLBTC", "canonical-staked", "staked", "initialize", 1, ["initializer", "__StakedLBTC_init"], { actor: "one-time initializer caller", accounting: "initializes token/admin state" }),
  spec("StakedLBTC", "canonical-staked", "staked", "migrateToAccessControl", 1, ["reinitializer(3)", "_grantRole"], { actor: "legacy owner", accounting: "migrates legacy owner/minters to AccessControl" }),
  spec("StakedLBTC", "canonical-staked", "staked", "mint", 1, ["MINTER_ROLE", "_mint(to, amount)"], { canonical: "mint(address,uint256)", actor: "MINTER_ROLE", accounting: "increases canonical supply" }),
  spec("StakedLBTC", "canonical-staked", "staked", "batchMint", 1, ["MINTER_ROLE", "_batchMint"], { canonical: "batchMint(address[],uint256[])", actor: "MINTER_ROLE", accounting: "increases canonical supply in batch" }),
  spec("StakedLBTC", "canonical-staked-gmp", "staked", "mint", 2, ["assetRouter.mint", "rawPayload"], { canonical: "mint(bytes,bytes)", actor: "public caller with valid downstream proof/path", replay: "AssetRouter payload.id", accounting: "downstream canonical mint" }),
  spec("StakedLBTC", "canonical-staked-gmp", "staked", "batchMint", 2, ["assetRouter.batchMint", "paused()"], { canonical: "batchMint(bytes[],bytes[])", actor: "public caller with valid downstream proofs", replay: "per AssetRouter payload.id", accounting: "downstream canonical batch mint" }),
  spec("StakedLBTC", "canonical-staked-fee", "staked", "mintWithFee", 1, ["CLAIMER_ROLE", "_mintWithFee"], { actor: "CLAIMER_ROLE", accounting: "proof mint then fee transfer" }),
  spec("StakedLBTC", "canonical-staked-fee", "staked", "batchMintWithFee", 1, ["CLAIMER_ROLE", "assetRouter.batchMintWithFee"], { actor: "CLAIMER_ROLE", accounting: "proof mints with per-item fee approval" }),
  spec("StakedLBTC", "canonical-staked", "staked", "burn", 1, ["_burn(_msgSender(), amount)"], { canonical: "burn(uint256)", actor: "token holder", accounting: "decreases caller supply" }),
  spec("StakedLBTC", "canonical-staked", "staked", "burn", 2, ["MINTER_ROLE", "_burn(from, amount)"], { canonical: "burn(address,uint256)", actor: "MINTER_ROLE", accounting: "decreases arbitrary holder supply" }),
  spec("StakedLBTC", "canonical-to-bitcoin", "staked", "redeemForBtc", 1, ["assetRouter.redeemForBtc", "scriptPubkey"], { actor: "token holder", accounting: "router burns canonical token and emits BTC redeem request" }),
  spec("StakedLBTC", "canonical-to-native", "staked", "redeem", 1, ["assetRouter.redeem", "address(this)"], { actor: "token holder", accounting: "forwards the input amount unchanged into the router's canonical-to-Native Ledger request; no router rate call occurs in this function" }),
  spec("StakedLBTC", "native-to-canonical", "staked", "deposit", 1, ["assetRouter.deposit", "address(this)"], { actor: "NativeLBTC holder", accounting: "burns NativeLBTC and emits Ledger deposit request" }),
  spec("StakedLBTC", "canonical-rate", "staked", "ratio", 1, ["assetRouter.ratio"], { actor: "view caller", accounting: "no state; returns oracle ratio" }),
  spec("StakedLBTC", "canonical-rate", "staked", "getRate", 1, ["assetRouter.getRate"], { actor: "view caller", accounting: "no state; returns conversion rate" }),
  ...["toggleRedeemsForBtc", "changeNameAndSymbol", "changeTreasuryAddress", "changeAssetRouter", "changeRedeemFee", "changeRedeemForBtcMinAmount"].map((n) => spec("StakedLBTC", "canonical-admin", "staked", n, 1, ["DEFAULT_ADMIN_ROLE"], { actor: "DEFAULT_ADMIN_ROLE", accounting: "changes canonical token/router configuration" })),

  // NativeLBTC/BTC.b.
  spec("NativeLBTC", "native", "native", "initialize", 1, ["initializer", "__NativeLBTC_init"], { actor: "one-time initializer caller", accounting: "initializes native token/admin state" }),
  spec("NativeLBTC", "native", "native", "mint", 1, ["MINTER_ROLE", "_mint(to, amount)"], { actor: "MINTER_ROLE", accounting: "increases NativeLBTC supply" }),
  spec("NativeLBTC", "native", "native", "batchMint", 1, ["MINTER_ROLE", "_batchMint"], { actor: "MINTER_ROLE", accounting: "increases NativeLBTC supply in batch" }),
  spec("NativeLBTC", "native-deposit-v1", "native", "mintV1", 1, ["_mint(rawPayload, proof)"], { actor: "public caller with Consortium proof", replay: "sha256(full DepositV1 payload)", accounting: "increases NativeLBTC supply" }),
  spec("NativeLBTC", "native-deposit-v1", "native", "batchMintV1", 1, ["usedPayloads[payloadHash]", "mintV1"], { actor: "public caller with per-item proofs", replay: "sha256(each full payload); used items skipped", accounting: "increases NativeLBTC supply per accepted item" }),
  spec("NativeLBTC", "native-fee", "native", "mintV1WithFee", 1, ["CLAIMER_ROLE", "_mintWithFee"], { actor: "CLAIMER_ROLE", accounting: "proof mint then transfers approved fee" }),
  spec("NativeLBTC", "native-fee", "native", "batchMintV1WithFee", 1, ["CLAIMER_ROLE", "usedPayloads[payloadHash]"], { actor: "CLAIMER_ROLE", replay: "sha256(each full payload)", accounting: "proof mints and charges per-item fees" }),
  spec("NativeLBTC", "native", "native", "burn", 1, ["_burn(_msgSender(), amount)"], { canonical: "burn(uint256)", actor: "token holder", accounting: "decreases caller NativeLBTC" }),
  spec("NativeLBTC", "native", "native", "burn", 2, ["MINTER_ROLE", "_burn(from, amount)"], { canonical: "burn(address,uint256)", actor: "MINTER_ROLE", accounting: "decreases arbitrary holder NativeLBTC" }),
  spec("NativeLBTC", "native-to-bitcoin", "native", "redeemForBtc", 1, ["assetRouter.redeemForBtc", "scriptPubkey"], { actor: "token holder", accounting: "router burns NativeLBTC and emits BTC redeem request" }),
  ...["toggleRedeemsForBtc", "changeNameAndSymbol", "changeConsortium", "changeTreasuryAddress", "changeBascule", "changeAssetRouter", "changeRedeemFee", "changeRedeemForBtcMinAmount"].map((n) => spec("NativeLBTC", "native-admin", "native", n, 1, ["DEFAULT_ADMIN_ROLE"], { actor: "DEFAULT_ADMIN_ROLE", accounting: "changes NativeLBTC trust/configuration" })),
  spec("NativeLBTC", "native-deposit-v1", "native", "_validateAndMint", 1, ["usedPayloads[payloadHash]", "checkProof", "_confirmDeposit", "_mint(recipient"], { actor: "internal proof-mint path", replay: "sha256(full payload)", accounting: "consumes payload then optional Bascule then mints" }),

  // Router and Assets value bodies.
  spec("AssetRouter", "router-admin", "router", "initialize", 1, ["initializer", "__AssetRouter_init"], { accounting: "initializes router admin, chain, Mailbox and native-token configuration" }),
  spec("AssetRouter", "native-to-canonical", "router", "deposit", 1, ["AssetRouter_Unauthorized", "_deposit("], { canonical: "deposit(address,address,uint256)", actor: "fromAddress holder or toToken contract", accounting: "delegates conversion deposit for holder" }),
  spec("AssetRouter", "native-to-canonical", "router", "deposit", 2, ["_deposit(sender"], { canonical: "deposit(bytes32,bytes32,bytes32,uint256)", actor: "public token holder", accounting: "delegates conversion deposit" }),
  spec("AssetRouter", "native-to-canonical", "router", "_deposit", 1, ["IBaseLBTC($.nativeToken).burn", "Assets.encodeDepositRequest"], { actor: "internal", accounting: "burns NativeLBTC and emits deposit request" }),
  spec("AssetRouter", "to-bitcoin", "router", "redeemForBtc", 1, ["Validation.redeemFee", "_redeem("], { actor: "configured token caller/holder checked downstream", accounting: "delegates token burn/fee and BTC redeem request" }),
  spec("AssetRouter", "crosschain-redeem", "router", "redeem", 1, ["AssertRouter_WrongRedeemDestinationChain", "_redeem("], { canonical: "redeem(address,bytes32,address,bytes32,bytes32,uint256)", actor: "holder/token checked in internal path", accounting: "delegates crosschain redeem request" }),
  spec("AssetRouter", "canonical-to-native", "router", "redeem", 2, ["GMPUtils.addressToBytes32($.nativeToken)", "_redeem("], { canonical: "redeem(address,address,uint256)", actor: "holder/token checked in internal path", accounting: "forwards amount into canonical-to-Native Ledger conversion request without a router rate call" }),
  spec("AssetRouter", "redeem-request", "router", "_redeem", 1, ["tokenContract.burn", "$.mailbox.send"], { actor: "internal; from holder/token and allowed token enforced", accounting: "emits Ledger redeem request, mints fee to treasury, then burns source token" }),
  spec("AssetRouter", "canonical-staked-gmp", "router", "mint", 1, ["_mint(rawPayload, proof)"], { actor: "public proof submitter", replay: "Mailbox/handler payload.id", accounting: "returns handled canonical mint recipient" }),
  spec("AssetRouter", "canonical-staked-gmp", "router", "batchMint", 1, ["_mint(payload[i]", "AssetRouter_BatchMintError"], { actor: "public proof submitter", replay: "per payload.id", accounting: "attempts each canonical release" }),
  spec("AssetRouter", "canonical-staked-fee", "router", "mintWithFee", 1, ["CLAIMER_ROLE", "_mintWithFee"], { actor: "CLAIMER_ROLE", accounting: "release mint followed by fee burn/mint" }),
  spec("AssetRouter", "canonical-staked-fee", "router", "batchMintWithFee", 1, ["CLAIMER_ROLE", "_mintWithFee"], { actor: "CLAIMER_ROLE", accounting: "attempts batch release mints with fee approvals" }),
  spec("AssetRouter", "canonical-staked-fee", "router", "_mintWithFee", 1, ["Assert.feeApproval", "burn(recipient, fee)", "mint(treasury, fee)"], { actor: "internal fee path", accounting: "redistributes minted amount as fee" }),
  spec("AssetRouter", "canonical-staked-gmp", "router", "handlePayload", 1, ["AssetRouter_MailboxExpected", "BTC_STAKING_MODULE_ADDRESS", "usedPayloads[payload.id] = true", "decodeRelease", ".mint(receipt.recipient"], { actor: "configured Mailbox with BTC module sender", replay: "payload.id", accounting: "consumes release then mints canonical token" }),
  ...["encodeDepositRequest", "encodeRedeemRequest", "encodeRedeemNativeRequest", "decodeRelease"].map((n) => spec("Assets", "ledger-body", "assets", n, 1, [n === "decodeRelease" ? "Release(toToken, recipient, amount)" : "abi.encodeWithSelector"], { actor: "internal library caller", accounting: "encodes/decodes signed Ledger request/release fields" })),
  ...["setRoute", "removeRoute", "toggleRedeem", "changeTokenConfig", "changeTokenConfigExt", "changeDepositMinAmount", "changeBascule", "changeOracle", "changeMailbox", "changeToNativeCommission", "changeNativeToken", "setMaxMintCommission"].map((n) => spec("AssetRouter", "router-admin", "router", n, 1, [], { accounting: "changes router route/token/trust/fee configuration" })),
  spec("AssetRouter", "router-fee-control", "router", "changeRedeemFee", 1, [], { canonical: "changeRedeemFee(uint256)", accounting: "CALLER_ROLE changes caller token fee" }),
  spec("AssetRouter", "router-fee-control", "router", "changeRedeemFee", 2, [], { canonical: "changeRedeemFee(address,uint256)", accounting: "admin changes selected token fee" }),
  spec("AssetRouter", "router-fee-control", "router", "changeRedeemForBtcMinAmount", 1, [], { canonical: "changeRedeemForBtcMinAmount(uint256)", accounting: "CALLER_ROLE changes caller token minimum" }),
  spec("AssetRouter", "router-fee-control", "router", "changeRedeemForBtcMinAmount", 2, [], { canonical: "changeRedeemForBtcMinAmount(address,uint256)", accounting: "admin changes selected token minimum" }),

  // Action schemas and fee helpers.
  ...["depositBtcV0", "depositBtcV1", "depositBridge", "validateValSet", "pubKeysToAddress", "feeApproval", "ratioUpdate"].map((n) => spec("Actions", "signed-action-schema", "actions", n, 1, [], { actor: "internal decoding/validation library", accounting: "decodes and validates signed action schema" })),
  spec("BaseLBTC", "fee-eip712", "base", "getFeeDigest", 1, ["_hashTypedDataV4", "block.chainid", "fee", "expiry"], { actor: "view caller", accounting: "derives EIP-712 fee approval digest" }),
  spec("Assert", "fee-eip712", "assert", "feeApproval", 1, ["checkSignature", "recipient"], { actor: "internal fee path", accounting: "checks recipient EOA/EIP-1271 signature" }),
  ...["redeemFee", "calcFeeAndDustLimit"].map((n) => spec("Validation", "btc-redeem-validation", "validation", n, 1, [], { actor: "internal library caller", accounting: "validates script/fee/minimum and computes net redeem amount" })),

  // GMP envelope/path/mailbox.
  spec("GMPUtils", "gmp-envelope", "gmp", "encodePayload", 1, ["msgDestinationCaller", "msgBody"], { actor: "internal sender", replay: "sha256(encoded raw payload)", accounting: "encodes full GMP envelope" }),
  spec("GMPUtils", "gmp-envelope", "gmp", "decodeAndValidatePayload", 1, ["payload.id = hash(rawPayload)", "msgDestinationCaller"], { actor: "internal receiver", replay: "sha256(raw payload)", accounting: "decodes fields and derives payload id" }),
  spec("GMPUtils", "gmp-envelope", "gmp", "hash", 1, ["sha256(rawPayload)"], { actor: "internal library caller", replay: "sha256(raw payload)", accounting: "no balance effect" }),
  spec("MessagePath", "gmp-domain", "path", "id", 1, ["sourceContract", "sourceChain", "destinationChain"], { actor: "internal library caller", replay: "not a replay store", accounting: "derives path domain id" }),
  spec("Mailbox", "gmp", "mailbox", "initialize", 1, ["initializer", "__Mailbox_init"], { actor: "one-time initializer caller", accounting: "sets Consortium/admin" }),
  spec("Mailbox", "gmp-outbound", "mailbox", "send", 1, ["encodePayload", "globalNonce++", "MessageSent"], { actor: "configured/size-valid sender paying fee", replay: "monotonic outbound nonce inside signed raw payload", accounting: "increments nonce and emits payload" }),
  spec("Mailbox", "gmp-inbound", "mailbox", "deliverAndHandle", 1, ["_deliver", "_handle"], { actor: "public proof submitter", replay: "exact payload hash delivery plus consumer key", accounting: "verifies/delivers then invokes handler" }),
  spec("Mailbox", "gmp-inbound", "mailbox", "_verifyPayload", 1, ["deliveredPayload[payloadHash]", "checkProof", "= true"], { actor: "internal delivery", replay: "exact payloadHash", accounting: "marks delivered before handler; persists if outer call returns despite handler revert being caught" }),
  spec("Mailbox", "gmp-handler", "mailbox", "_handle", 1, ["msgDestinationCaller", "try IHandler", "catch"], { actor: "destinationCaller or any caller when zero", replay: "consumer-owned", accounting: "calls handler; catches revert and permits later retry" }),
  ...["enableMessagePath", "disableMessagePath", "setDefaultMaxPayloadSize", "setSenderConfig", "setFee", "withdrawFee", "rescueERC20", "pause", "unpause"].map((n) => spec("Mailbox", "gmp-admin", "mailbox", n, 1, [], { actor: n === "pause" ? "PAUSER_ROLE" : "DEFAULT_ADMIN_ROLE or designated treasury where body specifies", accounting: "changes GMP configuration/custody/pause state" })),

  // Consortium and rate oracle.
  spec("Consortium", "proof-authority", "consortium", "initialize", 1, ["initializer", "__Ownable_init"], { actor: "one-time initializer caller", accounting: "sets owner" }),
  spec("Consortium", "proof-authority", "consortium", "setInitialValidatorSet", 1, ["onlyOwner", "_setValidatorSet"], { actor: "owner", replay: "epoch must be unset", accounting: "sets initial validator weights/threshold" }),
  spec("Consortium", "proof-authority", "consortium", "setNextValidatorSet", 1, ["checkProof", "epoch + 1", "_setValidatorSet"], { actor: "public submitter with current-set proof", replay: "strict next epoch and no epoch overwrite", accounting: "rotates validator set" }),
  spec("Consortium", "proof-authority", "consortium", "checkProof", 1, ["_checkProof"], { actor: "any consumer/caller", replay: "none; consumer must own replay", accounting: "view proof verification" }),
  spec("Consortium", "proof-authority", "consortium", "_checkProof", 1, ["_payloadHash", "weightThreshold", "NotEnoughSignatures"], { actor: "internal/view", replay: "none", accounting: "sums current epoch signature weights" }),
  spec("StakedLBTCOracle", "canonical-rate", "oracle", "initialize", 1, ["initializer", "__StakedLBTCOracle_init"], { actor: "one-time initializer caller", accounting: "sets owner/token/Consortium/initial ratio" }),
  spec("StakedLBTCOracle", "canonical-rate", "oracle", "publishNewRatio", 1, ["_publishNewRatio"], { actor: "public proof submitter", replay: "strictly increasing switchTime", accounting: "schedules ratio update" }),
  spec("StakedLBTCOracle", "canonical-rate", "oracle", "_publishNewRatio", 1, ["RATIO_UPDATE", "checkProof", "_setNewRatio"], { actor: "internal", replay: "switchTime monotonicity, not raw-hash map", accounting: "validates and schedules signed ratio" }),
  spec("StakedLBTCOracle", "canonical-rate", "oracle", "_validateRatio", 1, ["denomHash_", "maxAheadInterval", "TooBigRatioChange"], { actor: "internal", replay: "requires switchTime greater than prior", accounting: "enforces denom/time/rate bounds" }),
  ...["changeConsortium", "changeMaxAheadInterval", "updateRatioThreshold"].map((n) => spec("StakedLBTCOracle", "canonical-rate-admin", "oracle", n, 1, ["onlyOwner"], { actor: "owner", accounting: "changes oracle trust/bounds" })),

  // Bascule variants.
  ...["pause", "unpause", "updateValidateThreshold", "setMaxDeposits", "reportDeposits", "validateWithdrawal"].map((n) => spec("Bascule", "native-bascule", "bascule", n, 1, [], { actor: "role-gated as extracted", replay: n === "validateWithdrawal" ? "depositID history" : "report/config key", accounting: "changes report/validation/pause state" })),
  ...["pause", "unpause", "updateValidateThreshold", "setMaxMints", "setTrustedSigner", "reportMints", "validateMint", "_mintID"].map((n) => spec("GMPBasculeV1", "gmp-bascule", "gmpBascule", n, 1, [], { actor: "role/admin/internal as extracted", replay: n === "validateMint" || n === "_mintID" ? "keccak256(nonce, block.chainid, recipient, toToken, amount)" : "mint report/config key", accounting: "changes mint validation/report/config state" })),

  // BridgeV2 and legacy Bridge.
  spec("BridgeV2", "native-bridge-v2", "bridge2", "initialize", 1, ["initializer", "__BridgeV2_init"], { actor: "one-time initializer caller", accounting: "sets owner/Mailbox" }),
  spec("BridgeV2", "native-bridge-v2", "bridge2", "deposit", 1, ["_deposit", "sender"], { canonical: "deposit(bytes32,address,address,bytes32,uint256,bytes32)", actor: "external caller; downstream sender whitelist", replay: "new Mailbox nonce/raw payload", accounting: "delegates outbound burn/send for explicit sender" }),
  spec("BridgeV2", "native-bridge-v2", "bridge2", "deposit", 2, ["_deposit", "optionalMessage"], { canonical: "deposit(bytes32,address,address,bytes32,uint256,bytes32,bytes)", actor: "external caller; downstream sender whitelist", replay: "new Mailbox nonce/raw payload", accounting: "delegates outbound burn/send for explicit sender/message" }),
  spec("BridgeV2", "native-bridge-v2", "bridge2", "deposit", 3, ["_deposit", "_msgSender()"], { canonical: "deposit(bytes32,address,bytes32,uint256,bytes32)", actor: "external caller; downstream sender whitelist", replay: "new Mailbox nonce/raw payload", accounting: "delegates outbound burn/send for caller" }),
  spec("BridgeV2", "native-bridge-v2", "bridge2", "deposit", 4, ["_deposit", "optionalMessage"], { canonical: "deposit(bytes32,address,bytes32,uint256,bytes32,bytes)", actor: "external caller; downstream sender whitelist", replay: "new Mailbox nonce/raw payload", accounting: "delegates outbound burn/send for caller/message" }),
  spec("BridgeV2", "native-bridge-v2", "bridge2", "_deposit", 1, ["SenderNotWhitelisted", "_burnToken", "mailbox.send"], { actor: "whitelisted sender", replay: "Mailbox outbound nonce/full payload", accounting: "burns source token, calls Mailbox.send, and emits a raw payload that must be subsequently notarized; send does not sign it" }),
  spec("BridgeV2", "native-bridge-v2", "bridge2", "handlePayload", 1, ["MailboxExpected", "payloadSpent[payload.id] = true", "_withdraw"], { actor: "configured Mailbox and registered source bridge", replay: "payload.id", accounting: "consumes payload then mints destination token" }),
  spec("BridgeV2", "native-bridge-v2", "bridge2", "_withdraw", 1, ["updateLimit", ".mint(recipient, amount)"], { actor: "internal inbound path", replay: "caller handlePayload key", accounting: "updates inbound rate limit then mints" }),
  ...["setDestinationBridge", "addDestinationToken", "setAllowance", "removeDestinationToken", "setTokenRateLimits", "setSenderConfig", "rescueERC20"].map((n) => spec("BridgeV2", "native-bridge-v2-admin", "bridge2", n, 1, ["onlyOwner"], { actor: "owner", accounting: "changes bridge path/token/allowance/rate/sender or rescues custody" })),
  spec("Bridge", "deprecated-bridge", "bridge", "initialize", 1, ["initializer", "__Bridge_init"], { actor: "one-time initializer caller", accounting: "sets legacy bridge owner/config" }),
  spec("Bridge", "deprecated-bridge", "bridge", "deposit", 1, [], { actor: "public depositor", replay: "new crossChainOperationsNonce in delegated _deposit", accounting: "validates destination, then delegated _deposit transfers fee and performs legacy outbound lifecycle" }),
  spec("Bridge", "deprecated-bridge", "bridge", "receivePayload", 1, [], { actor: "only the configured adapter for the source chain", replay: "SHA256(payload) adapterReceived/withdrawn state", accounting: "validates adapter payload and marks adapterReceived" }),
  spec("Bridge", "deprecated-bridge", "bridge", "authNotary", 1, [], { actor: "public proof submitter", replay: "SHA256(payload) notarized/withdrawn state", accounting: "marks notarized before Consortium proof; invalid proof reverts the write" }),
  spec("Bridge", "deprecated-bridge", "bridge", "withdraw", 1, [], { actor: "public executor", replay: "SHA256(payload) withdrawn state", accounting: "requires each independently configured confirmation, consumes payload, and mints" }),
  spec("Bridge", "deprecated-bridge", "bridge", "_deposit", 1, ["RateLimits.updateLimit", "safeTransferFrom", "crossChainOperationsNonce++", "config.adapter.deposit", "lbtc().burn"], { actor: "internal public-deposit path", replay: "new crossChainOperationsNonce in SHA256 payload; no local inbound replay in this function", accounting: "charges fee, then adapter escrow/allowance branch or direct burn, and emits payload" }),
  ...["addDestination", "removeDestination", "changeDepositAbsoluteCommission", "changeDepositRelativeCommission", "changeAdapter", "changeConsortium", "setRateLimits"].map((n) => spec("Bridge", "deprecated-bridge-admin", "bridge", n, 1, ["onlyOwner"], { actor: "owner", accounting: "changes legacy destination/adapter/Consortium/fees/rates" })),

  // CCIP, OFT and IBC rails.
  spec("LombardTokenPoolV2", "ccip-via-bridge-v2", "ccip", "lockOrBurn", 1, ["bridge.deposit", "payloadHash"], { actor: "CCIP callback entry authorization inherited/unverified; local body invokes BridgeV2", replay: "BridgeV2/Mailbox payload", accounting: "invokes BridgeV2 burn/message path" }),
  spec("LombardTokenPoolV2", "ccip-via-bridge-v2", "ccip", "releaseOrMint", 1, ["deliverAndHandle", "sourcePoolData", "HashMismatch"], { actor: "CCIP callback entry authorization inherited/unverified; local body invokes Mailbox", replay: "Mailbox/handler exact payload plus sourcePoolData hash", accounting: "invokes Mailbox/BridgeV2 inbound mint path" }),
  ...["setPath", "removePath"].map((n) => spec("LombardTokenPoolV2", "ccip-admin", "ccip", n, 1, ["onlyOwner"], { actor: "owner", accounting: "changes CCIP-to-Lombard path mapping" })),
  spec("LBTCOFTAdapter", "layerzero-escrow", "oftEscrow", "empty", 1, ["onlyOwner", ".burn("], { actor: "owner", accounting: "burns LBTC escrow balance held by adapter" }),
  spec("LBTCBurnMintOFTAdapter", "layerzero-burn-mint", "oftBurnMint", "_debit", 1, ["burn(_from", "_debitView"], { actor: "inherited OFT endpoint path", replay: "external LayerZero endpoint/peer dependency", accounting: "burns source LBTC" }),
  spec("LBTCBurnMintOFTAdapter", "layerzero-burn-mint", "oftBurnMint", "_credit", 1, ["mint(_to", "_amountLD"], { actor: "inherited OFT endpoint path", replay: "external LayerZero endpoint/peer dependency", accounting: "mints destination LBTC" }),
  spec("EfficientRateLimitedOFTAdapter", "layerzero-rate-admin", "oftRateAdapter", "setRateLimits", 1, ["onlyOwner", "_setRateLimits"], { actor: "owner", accounting: "changes inbound/outbound OFT limits" }),
  spec("EfficientRateLimitedOFTAdapter", "layerzero-rate", "oftRateAdapter", "_debit", 1, ["_checkAndUpdateRateLimit", "Outbound"], { actor: "inherited OFT endpoint path", accounting: "checks outbound limit then inherited debit" }),
  spec("EfficientRateLimitedOFTAdapter", "layerzero-rate", "oftRateAdapter", "_credit", 1, ["_checkAndUpdateRateLimit", "Inbound"], { actor: "inherited OFT endpoint path", accounting: "checks inbound limit then inherited credit" }),
  spec("IBCVoucher", "ibc-voucher", "ibc", "initialize", 1, ["initializer", "__IBCVoucher_init"], { actor: "one-time initializer caller", accounting: "sets LBTC/admin/fee/voucher state" }),
  spec("IBCVoucher", "ibc-voucher", "ibc", "wrap", 1, ["RELAYER_ROLE", "_wrap"], { canonical: "wrap(uint256)", actor: "RELAYER_ROLE", accounting: "burns LBTC and mints voucher" }),
  spec("IBCVoucher", "ibc-voucher", "ibc", "wrap", 2, ["RELAYER_ROLE", "_wrap"], { canonical: "wrap(uint256,uint256)", actor: "RELAYER_ROLE", accounting: "burns LBTC and mints voucher with fee option" }),
  spec("IBCVoucher", "ibc-voucher", "ibc", "wrapTo", 1, ["RELAYER_ROLE", "_wrap"], { canonical: "wrapTo(address,uint256)", actor: "RELAYER_ROLE", accounting: "burns caller LBTC and mints voucher to recipient" }),
  spec("IBCVoucher", "ibc-voucher", "ibc", "wrapTo", 2, ["RELAYER_ROLE", "_wrap"], { canonical: "wrapTo(address,uint256,uint256)", actor: "RELAYER_ROLE", accounting: "burns caller LBTC and mints voucher to recipient with min out" }),
  spec("IBCVoucher", "ibc-voucher", "ibc", "spend", 1, ["_spend(_msgSender()"], { actor: "voucher holder", accounting: "burns voucher and mints LBTC" }),
  spec("IBCVoucher", "ibc-voucher", "ibc", "spendTo", 1, ["_spend(_msgSender()"], { actor: "voucher holder", accounting: "burns voucher and mints LBTC to recipient" }),
  spec("IBCVoucher", "ibc-voucher", "ibc", "spendFrom", 1, ["OPERATOR_ROLE", "_spend(owner"], { actor: "OPERATOR_ROLE", accounting: "burns arbitrary holder voucher and mints LBTC" }),
  spec("IBCVoucher", "ibc-voucher", "ibc", "_wrap", 1, ["uint64", "_lbtc.burn", "_mint(recipient"], { actor: "internal relayer path", replay: "no local message replay key; repeated execution is balance/allowance constrained; external IBC packet uniqueness is outside this contract", accounting: "rate credit, LBTC burn, voucher mint" }),
  spec("IBCVoucher", "ibc-voucher", "ibc", "_spend", 1, ["uint64(amount)", "_burn(from", "lbtc.mint"], { actor: "internal holder/operator path", replay: "no local message replay key; repeated execution is voucher-balance constrained; external IBC packet uniqueness is outside this contract", accounting: "rate debit, voucher burn, LBTC mint" }),
  ...["setRateLimit", "pause", "unpause", "setTreasuryAddress", "setFee"].map((n) => spec("IBCVoucher", "ibc-admin", "ibc", n, 1, [], { actor: "role/admin as extracted", accounting: "changes voucher rate/pause/treasury/fee configuration" })),
  spec("RateLimits", "shared-rate-limit", "rateLimits", "setRateLimit", 1, [], { actor: "internal library caller", accounting: "sets limit/window and checkpoints state" }),
  spec("RateLimits", "shared-rate-limit", "rateLimits", "availableAmountToSend", 1, [], { canonical: "availableAmountToSend(Data)", actor: "internal library caller", accounting: "computes available amount from Data struct" }),
  spec("RateLimits", "shared-rate-limit", "rateLimits", "availableAmountToSend", 2, [], { canonical: "availableAmountToSend(uint256,uint256,uint256,uint256)", actor: "internal library caller", accounting: "computes decayed available amount from scalar fields" }),
  spec("RateLimits", "shared-rate-limit", "rateLimits", "updateLimit", 1, [], { actor: "internal library caller", accounting: "updates amount-in-flight limit" }),
  spec("RateLimits", "shared-rate-limit", "rateLimits", "checkRateLimitSanity", 1, [], { actor: "internal library caller", accounting: "validates limit bound" }),
  ...["getAmountCanBeSent", "getAmountCanBeReceived", "_setRateLimits", "_amountCanBeSent", "_amountCanBeReceived", "_checkAndUpdateRateLimit"].map((n) => spec("EfficientRateLimiter", "layerzero-rate", "oftRate", n, 1, [], { actor: "public view/internal inherited adapter path", accounting: "reads/sets/checks inherited OFT rate state" })),
];

function localModifiers(header) {
  const found = [];
  for (const match of header.matchAll(/onlyRole\(([^)]+)\)|\bonlyOwner\b|\binitializer\b|\breinitializer\(([^)]+)\)|\bonlyInitializing\b|\bwhen[A-Za-z0-9_]+\b|\bnonReentrant\b/g)) found.push(match[0]);
  return [...new Set(found)];
}
function inferGate(fn, supplied, component) {
  const mods = localModifiers(fn.header);
  const roles = mods.filter((m) => m.startsWith("onlyRole("));
  if (component === "Bascule" && fn.name === "updateValidateThreshold") return "conditional trusted gate: lowering requires DEFAULT_ADMIN_ROLE; raising requires VALIDATION_GUARDIAN_ROLE, which is then renounced";
  if (mods.includes("onlyOwner")) return "owner";
  if (roles.length) return roles.join(" + ");
  const reinit = mods.find((m) => m.startsWith("reinitializer("));
  if (mods.includes("initializer")) return "privileged one-time initializer authority";
  if (reinit) return `privileged ${reinit} migration authority plus body-conditional legacy-owner check where present`;
  if (/\binternal\b|\bprivate\b/.test(fn.header)) return "internal/private call path";
  return supplied || "public/external subject to explicit body/downstream checks";
}

function signingSemantics(component, canonical) {
  const na = { signedPayloadFields: "not-applicable", signatureDigest: "not-applicable", domainFields: "not-applicable", missingDomainFields: "not-applicable" };
  if (component === "NativeLBTC" && ["mintV1(bytes,bytes)", "_validateAndMint(address,uint256,bytes,bytes)"].includes(canonical)) return { signedPayloadFields: ["DEPOSIT_BTC_ACTION_V1 selector", "toChain", "recipient", "amount", "nonzero txid", "vout", "token"], signatureDigest: "SHA256(full selector-prefixed DepositV1 payload) checked by Consortium; legacy Bascule deposit key is KECCAK256(payload body), a distinct digest", domainFields: ["toChain", "recipient", "token", "txid", "vout", "amount"], missingDomainFields: ["verifying NativeLBTC contract address as explicit field; token is checked against address(this)"] };
  if (["GMPUtils", "Mailbox", "AssetRouter", "BridgeV2", "LombardTokenPoolV2"].includes(component) && /encodePayload|decodeAndValidatePayload|deliverAndHandle|_verifyPayload|handlePayload|releaseOrMint/.test(canonical)) return { signedPayloadFields: ["path", "nonce", "sender", "recipient", "destinationCaller", "body"], signatureDigest: "SHA256(full raw GMP payload) checked by Consortium at Mailbox delivery", domainFields: ["MessagePath.sourceContract", "MessagePath.sourceChain", "MessagePath.destinationChain"], missingDomainFields: [] };
  if (component === "MessagePath") return { signedPayloadFields: ["sourceContract", "sourceChain", "destinationChain"], signatureDigest: "KECCAK256(MessagePath fields), then included as path in SHA256 raw GMP payload", domainFields: ["sourceContract", "sourceChain", "destinationChain"], missingDomainFields: [] };
  if (component === "StakedLBTCOracle" && /publishNewRatio|_publishNewRatio/.test(canonical)) return { signedPayloadFields: ["RATIO_UPDATE action selector", "denom", "ratio", "switchTime"], signatureDigest: "SHA256(raw selector-prefixed ratio payload) checked by Consortium", domainFields: ["denom", "ratio", "switchTime"], missingDomainFields: ["oracle contract address", "block.chainid"] };
  if ((component === "BaseLBTC" && canonical === "getFeeDigest(uint256,uint256)") || (component === "Assert" && canonical === "feeApproval(bytes32,address,bytes)")) return { signedPayloadFields: ["feeApproval typehash", "block.chainid", "fee", "expiry"], signatureDigest: "EIP-712 _hashTypedDataV4 struct digest; EOA/EIP-1271 recipient signature checked", domainFields: ["EIP-712 name", "version", "block.chainid", "verifying contract"], missingDomainFields: [] };
  if (component === "Actions" && canonical === "feeApproval(bytes)") return { signedPayloadFields: ["fee", "expiry"], signatureDigest: "fields feed BaseLBTC EIP-712 fee digest", domainFields: ["added by BaseLBTC.getFeeDigest"], missingDomainFields: [] };
  if (component === "Actions" && canonical === "depositBridge(bytes)") return { signedPayloadFields: ["DEPOSIT_BRIDGE_ACTION selector", "fromChain", "fromContract", "toChain", "toContract", "recipient", "amount", "nonce"], signatureDigest: "SHA256(full selector-prefixed DepositBridgeAction payload) where Consortium confirmation is configured", domainFields: ["fromChain", "fromContract", "toChain", "toContract", "recipient", "nonce"], missingDomainFields: [] };
  if (component === "Actions" && canonical === "depositBtcV1(bytes)") return { signedPayloadFields: ["DEPOSIT_BTC_ACTION_V1 selector", "toChain", "recipient", "amount", "nonzero txid", "vout", "token"], signatureDigest: "consumer hashes full selector-prefixed payload with SHA256 before Consortium proof", domainFields: ["toChain", "recipient", "token", "txid", "vout", "amount"], missingDomainFields: ["verifying contract is enforced by token == address(this) at library delegate context, not encoded separately"] };
  if (component === "Actions" && canonical === "ratioUpdate(bytes)") return { signedPayloadFields: ["RATIO_UPDATE action selector", "denom", "ratio", "switchTime"], signatureDigest: "consumer hashes full selector-prefixed payload with SHA256", domainFields: ["denom", "ratio", "switchTime"], missingDomainFields: ["oracle contract address", "block.chainid"] };
  if (component === "Consortium" && ["checkProof(bytes32,bytes)", "_checkProof(bytes32,bytes)"].includes(canonical)) return { signedPayloadFields: ["consumer-supplied payloadHash"], signatureDigest: "ECDSA recovery directly over consumer-supplied bytes32 hash (no Ethereum signed-message prefix)", domainFields: ["entirely consumer payload dependent"], missingDomainFields: ["Consortium itself adds no contract address, chain id, action type, nonce, or replay domain"] };
  if (component === "GMPBasculeV1" && canonical === "_mintID(Message)") return { signedPayloadFields: ["nonce", "block.chainid", "recipient", "toToken", "amount"], signatureDigest: "constructs GMPBascule mintID = KECCAK256(ABI-encoded fields); this function performs no signature verification", domainFields: ["block.chainid", "recipient", "toToken", "nonce", "amount"], missingDomainFields: ["GMPBascule contract address"] };
  if (component === "GMPBasculeV1" && canonical === "reportMints(bytes32,Message[],bytes[])") return { signedPayloadFields: ["per-message nonce", "block.chainid", "recipient", "toToken", "amount"], signatureDigest: "recovers each supplied proof over GMPBascule mintID and requires trustedSigner before writing REPORTED history", domainFields: ["block.chainid", "recipient", "toToken", "nonce", "amount"], missingDomainFields: ["GMPBascule contract address"] };
  if (component === "GMPBasculeV1" && canonical === "validateMint(Message)") return { signedPayloadFields: "not-applicable", signatureDigest: "not-applicable; validateMint performs no signature verification", domainFields: "not-applicable", missingDomainFields: "not-applicable" };
  return na;
}

const HIGH_RISK_KEYS = new Set([
  "NativeLBTC::mintV1(bytes,bytes)", "NativeLBTC::_validateAndMint(address,uint256,bytes,bytes)",
  "Mailbox::deliverAndHandle(bytes,bytes)", "Mailbox::_verifyPayload(MailboxStorage,bytes32,uint256,bytes32,bytes,bytes)", "Mailbox::_handle(MailboxStorage,GMPUtils.Payload,bytes32)",
  "AssetRouter::handlePayload(GMPUtils.Payload)",
  "StakedLBTCOracle::publishNewRatio(bytes,bytes)", "StakedLBTCOracle::_publishNewRatio(bytes,bytes)", "StakedLBTCOracle::_validateRatio(StakedLBTCOracleStorage,uint256,uint256,bytes32)",
  "Bascule::validateWithdrawal(bytes32,uint256)",
  "GMPBasculeV1::reportMints(bytes32,Message[],bytes[])", "GMPBasculeV1::validateMint(Message)", "GMPBasculeV1::_mintID(Message)",
  "BridgeV2::deposit(bytes32,address,address,bytes32,uint256,bytes32)", "BridgeV2::deposit(bytes32,address,address,bytes32,uint256,bytes32,bytes)", "BridgeV2::deposit(bytes32,address,bytes32,uint256,bytes32)", "BridgeV2::deposit(bytes32,address,bytes32,uint256,bytes32,bytes)", "BridgeV2::_deposit(bytes32,IERC20MintableBurnable,address,bytes32,uint256,bytes32,bytes)", "BridgeV2::handlePayload(GMPUtils.Payload)",
  "Bridge::deposit(bytes32,bytes32,uint64)", "Bridge::_deposit(DestinationConfig,bytes32,bytes32,uint64)", "Bridge::receivePayload(bytes32,bytes)", "Bridge::authNotary(bytes,bytes)", "Bridge::withdraw(bytes)",
  "IBCVoucher::_wrap(address,address,uint256,uint256)", "IBCVoucher::_spend(address,address,uint256)",
]);

function exactOperations(orderedOperations, replayConsumptionTiming, survivesCaughtHandlerFailure = false) {
  return { orderedOperations, replayConsumptionTiming, survivesCaughtHandlerFailure, fallback: false };
}

function operationSemantics(component, canonical, fallback) {
  const key = `${component}::${canonical}`;
  if (key === "NativeLBTC::mintV1(bytes,bytes)") return exactOperations(["enforce nonReentrant and mint/burn-not-paused modifiers", "delegate rawPayload and proof to internal _mint", "internal path validates DepositV1 fields then calls _validateAndMint"], "replay is consumed by _validateAndMint using SHA256(full payload); uncaught revert rolls all writes back");
  if (key === "NativeLBTC::_validateAndMint(address,uint256,bytes,bytes)") return exactOperations(["compute SHA256(full payload) and KECCAK256(payload body)", "reject used SHA256 payloadHash", "Consortium.checkProof(payloadHash,proof)", "set usedPayloads[payloadHash]=true", "if Bascule configured call validateWithdrawal(legacyHash,amountToMint)", "mint recipient", "emit MintProofConsumed"], "exact payload SHA256 is set before Bascule and mint; any uncaught revert rolls all writes back");
  if (key === "Mailbox::deliverAndHandle(bytes,bytes)") return exactOperations(["decode and validate full raw GMP payload and derive payload.id", "require enabled inbound message path in _deliver", "call _verifyPayload", "call _handle", "return payload.id, handler success, and handler result"], "delivered=true persists when _handle catches recipient failure and outer deliverAndHandle returns normally", true);
  if (key === "Mailbox::_verifyPayload(MailboxStorage,bytes32,uint256,bytes32,bytes,bytes)") return exactOperations(["check deliveredPayload[payloadHash]", "if not delivered call Consortium.checkProof(payloadHash,proof)", "set deliveredPayload[payloadHash]=true before handler stage", "emit MessageDelivered"], "delivery is idempotent; delivered state persists across a later caught handler failure because the outer call returns", true);
  if (key === "Mailbox::_handle(MailboxStorage,GMPUtils.Payload,bytes32)") return exactOperations(["enforce destinationCaller is zero or equals current caller", "require recipient supports IHandler", "call recipient.handlePayload(payload)", "on success emit result, set handledPayload[payloadHash]=true, and return success/result", "catch string or low-level revert, emit error, and return false/empty result"], "this function does not consume delivered replay state; prior delivered=true persists because recipient revert is caught and the outer call returns", true);
  if (key === "AssetRouter::handlePayload(GMPUtils.Payload)") return exactOperations(["require caller is configured Mailbox", "require payload.msgSender is BTC_STAKING_MODULE_ADDRESS", "reject used payload.id", "set usedPayloads[payload.id]=true", "decode Release from payload.msgBody", "if GMP Bascule configured call validateMint(nonce,recipient,toToken,amount)", "mint toToken to recipient", "return encoded recipient/token/amount"], "used payload is set before decode/Bascule/mint; any uncaught revert rolls the flag and all local writes back");
  if (key === "StakedLBTCOracle::publishNewRatio(bytes,bytes)") return exactOperations(["public caller supplies rawPayload and proof", "delegate unchanged arguments to _publishNewRatio"], "strictly increasing switchTime is enforced by delegated validation; no raw payload replay map");
  if (key === "StakedLBTCOracle::_publishNewRatio(bytes,bytes)") return exactOperations(["require RATIO_UPDATE selector", "decode denom, ratio, and switchTime", "call _validateRatio", "compute SHA256(rawPayload)", "Consortium.checkProof(payloadHash,proof)", "set new ratio and switchTime"], "validation requires switchTime greater than stored switchTime before proof and state update; uncaught revert rolls back");
  if (key === "StakedLBTCOracle::_validateRatio(StakedLBTCOracleStorage,uint256,uint256,bytes32)") return exactOperations(["require denom equals configured token denom", "require switchTime is greater than stored switchTime", "require switchTime is not beyond maxAheadInterval", "compute time-scaled ratio-change threshold", "reject ratio movement above threshold"], "view validation only; monotonic switchTime is the replay constraint");
  if (key === "Bascule::validateWithdrawal(bytes32,uint256)") return exactOperations(["read depositHistory[depositID]", "if REPORTED set WITHDRAWN, emit validated, and return", "if WITHDRAWN revert", "if UNREPORTED and amount is at least threshold revert", "if UNREPORTED below threshold emit not-validated without writing history"], "below-threshold unreported success does not consume depositID; reported success marks it WITHDRAWN");
  if (key === "GMPBasculeV1::reportMints(bytes32,Message[],bytes[])") return exactOperations(["require mint count at most maxMints and equal proof count", "for each message compute mintID", "if UNREPORTED recover proof signer and require trustedSigner", "write mintHistory[mintID]=REPORTED", "otherwise emit already-reported-or-processed warning", "emit MintsReported after loop"], "each report write follows proof validation; any uncaught revert rolls the entire batch back");
  if (key === "GMPBasculeV1::validateMint(Message)") return exactOperations(["compute mintID and read history", "if REPORTED set MINTED, emit validated, and return", "if MINTED revert", "if UNREPORTED and amount is at least threshold revert", "if UNREPORTED below threshold set MINTED and emit not-validated"], "every successful validation marks mintID MINTED");
  if (key === "GMPBasculeV1::_mintID(Message)") return exactOperations(["ABI-encode nonce, block.chainid, recipient, toToken, and amount", "return KECCAK256 encoding"], "digest construction only; no history read/write and no signature verification");
  if (key.startsWith("BridgeV2::deposit(")) {
    const explicitSender = canonical.startsWith("deposit(bytes32,address,address,");
    const optional = canonical.endsWith(",bytes)");
    return exactOperations([...(explicitSender ? ["require explicit sender is nonzero"] : []), `call _deposit with ${explicitSender ? "explicit sender" : "_msgSender()"} and ${optional ? "supplied optionalMessage" : "empty optionalMessage"}`, "return nonce and payloadHash from _deposit"], "delegated Mailbox.send creates a new outbound nonce/raw payload; repeated calls are balance/allowance constrained");
  }
  if (key === "BridgeV2::_deposit(bytes32,IERC20MintableBurnable,address,bytes32,uint256,bytes32,bytes)") return exactOperations(["require nonzero amount and valid nonzero destination recipient", "require current caller is whitelisted", "require configured destination bridge", "require configured destination token", "transfer source token from caller and burn it", "encode destination body", "check caller-discounted Mailbox fee", "call Mailbox.send", "emit DepositToBridge"], "Mailbox.send embeds a new global nonce; any uncaught burn/fee/send failure rolls all state back");
  if (key === "BridgeV2::handlePayload(GMPUtils.Payload)") return exactOperations(["require caller is configured Mailbox", "reject payloadSpent[payload.id]", "set payloadSpent[payload.id]=true", "resolve source chain from Mailbox inbound path", "require configured source bridge and matching payload.msgSender", "decode body and require allowed destination token", "update inbound rate limit", "mint recipient", "emit withdrawal and return optional message"], "replay is set in source order before source-bridge/token/rate checks and mint; any uncaught revert rolls replay and all writes back");
  if (key === "Bridge::deposit(bytes32,bytes32,uint64)") return exactOperations(["public depositor validates nonzero amount and recipient", "load and require configured destination", "delegate to _deposit, which transfers the fee before outbound token handling"], "_deposit creates a new nonce; repeated calls are balance/allowance constrained");
  if (key === "Bridge::_deposit(DestinationConfig,bytes32,bytes32,uint64)") return exactOperations(["update outbound rate limit", "calculate relative fee then add absolute fee and require fee below amount", "transfer fee from public depositor to treasury", "construct DepositBridgeAction with crossChainOperationsNonce++", "if adapter configured transfer net LBTC into Bridge escrow", "if adapter configured approve adapter", "if adapter configured call adapter.deposit", "otherwise directly burn net LBTC from depositor", "emit DepositToBridge with SHA256(payload)", "return net amount and payload"], "new nonce per successful call; uncaught transfer/adapter/burn failure rolls fee, nonce, and state back");
  if (key === "Bridge::receivePayload(bytes32,bytes)") return exactOperations(["load and require configured source destination record", "require caller is exactly its configured adapter", "require DepositBridgeAction selector and decode payload", "require action.fromContract matches configured bridge", "compute SHA256(payload) and reject withdrawn", "set adapterReceived=true", "emit PayloadReceived"], "exact payload adapter confirmation is written only by the configured adapter; uncaught revert rolls it back");
  if (key === "Bridge::authNotary(bytes,bytes)") return exactOperations(["public proof submitter requires DepositBridgeAction selector and decodes payload", "require action.fromContract matches configured bridge", "compute SHA256(payload) and reject withdrawn", "set notarized=true before Consortium.checkProof(payloadHash,proof)", "call Consortium.checkProof(payloadHash,proof)", "emit PayloadNotarized"], "invalid proof reverts and rolls back notarized=true");
  if (key === "Bridge::withdraw(bytes)") return exactOperations(["public executor requires DepositBridgeAction selector and decodes payload", "require action.toContract is this Bridge", "update inbound rate limit", "require configured source destination and compute SHA256(payload)", "if adapter configured require adapterReceived", "if Consortium confirmation configured require notarized", "reject already withdrawn", "set withdrawn=true", "mint recipient", "emit withdrawal and return amount"], "adapter and Consortium confirmations are independently conditional; replay is marked before mint and an uncaught mint revert rolls replay/rate state back");
  if (key === "IBCVoucher::_wrap(address,address,uint256,uint256)") return exactOperations(["calculate fee/net amount and enforce minimum output", "reset epoch if needed then increase uint64 rate credit", "transfer full LBTC amount from payer", "transfer fee to treasury", "burn net LBTC", "mint net voucher to recipient"], "no local message replay key; repeated execution is balance/allowance constrained; external IBC packet uniqueness is outside this contract");
  if (key === "IBCVoucher::_spend(address,address,uint256)") return exactOperations(["reset epoch if needed", "require uint64 amount does not exceed rate credit then decrease credit", "burn voucher from holder/operator-selected account", "mint LBTC to recipient"], "no local message replay key; repeated execution is voucher-balance constrained; external IBC packet uniqueness is outside this contract");
  const signed = signingSemantics(component, canonical);
  if (signed.signatureDigest !== "not-applicable") return { orderedOperations: ["use row-specific signed fields and digest metadata", "execute extracted body statements in source order"], replayConsumptionTiming: "row-specific digest/replay semantics shown in replayKey; uncaught revert rolls local writes back", survivesCaughtHandlerFailure: false, fallback: true };
  return { orderedOperations: [fallback], replayConsumptionTiming: "as ordered in extracted body; uncaught revert rolls back local state", survivesCaughtHandlerFailure: false, fallback: true };
}

function buildRows(loaded) {
  const cache = {};
  for (const key of Object.keys(FILES)) if (FILES[key].endsWith(".sol")) cache[key] = solidityFunctions(loaded[key], FILES[key]);
  const selectedRanges = new Set();
  return SPECS.map((s) => {
    const candidates = (cache[s.file] || []).filter((f) => f.name === s.name);
    let fn;
    if (s.canonical) fn = candidates.find((f) => f.canonicalSignature === s.canonical);
    else if (candidates.length === 1) fn = candidates[0];
    else throw new Error(`overload requires canonical manifest key: ${s.component}.${s.name} candidates=${candidates.map((f) => f.canonicalSignature).join("|")}`);
    if (!fn) throw new Error(`canonical function extraction failed: ${s.component}.${s.canonical || s.name}`);
    const rangeKey = `${s.file}:${fn.startLine}-${fn.endLine}`;
    if (selectedRanges.has(rangeKey)) throw new Error(`duplicate required function selection: ${rangeKey}`);
    selectedRanges.add(rangeKey);
    const rowMarkers = [`function ${s.name}`, ...s.markers];
    for (const marker of rowMarkers) if (!fn.text.includes(marker)) throw new Error(`bounded marker missing in ${s.component}.${fn.canonicalSignature}: ${marker}`);
    const mods = localModifiers(fn.header);
    const actor = inferGate(fn, s.actor, s.component);
    const signing = signingSemantics(s.component, fn.canonicalSignature);
    const operations = operationSemantics(s.component, fn.canonicalSignature, "execute extracted body statements in source order");
    const restricted = mods.some((m) => /onlyRole|onlyOwner|initializer|reinitializer|onlyInitializing/.test(m)) || /\b(owner|ROLE|initializer|reinitializer|treasury|claimer|operator|relayer|reporter|validator|guardian)\b/i.test(actor);
    const componentSlug = s.component.toLowerCase().replace(/[^a-z0-9_]+/g, "-");
    const id = `${componentSlug}-${fn.canonicalSignatureHash.slice(0, 20)}`;
    return {
      id,
      component: s.component,
      tokenIdentity: s.rail,
      rail: s.rail,
      functionSignature: fn.canonicalSignature,
      canonicalSignature: fn.canonicalSignature,
      canonicalSignatureHash: fn.canonicalSignatureHash,
      functionSourceRange: `${P}${FILES[s.file]}:${fn.startLine}-${fn.endLine}`,
      actorCallerGate: actor,
      localModifiers: mods.length ? mods : ["none"],
      effectiveCallPathGates: [actor, ...mods, s.pathGate || "body/downstream conditions per ordered operations"],
      pauseReentrancyGate: mods.filter((m) => /^when|nonReentrant/.test(m)).join(" + ") || "none",
      functionInputs: fn.parameters,
      signedPayloadFields: signing.signedPayloadFields,
      signatureDigest: signing.signatureDigest,
      domainFields: signing.domainFields,
      missingDomainFields: signing.missingDomainFields,
      domainBinding: signing.domainFields === "not-applicable" ? "not-applicable" : signing.domainFields,
      replayKey: s.replay || "none local or delegated to caller/downstream component",
      replayConsumptionTiming: s.replayTiming || operations.replayConsumptionTiming,
      survivesCaughtHandlerFailure: operations.survivesCaughtHandlerFailure,
      accountingEffect: s.accounting || "configuration/view effect described by extracted body",
      orderedOperations: operations.orderedOperations,
      orderedOperationsFallback: operations.fallback === true,
      externalCallsOrder: operations.orderedOperations,
      adminOverride: restricted ? "trusted authority visible" : "none visible locally or downstream/config dependent",
      privilegedTrusted: restricted,
      failureRetry: s.failure || "uncaught revert rolls back this call; caught downstream failures follow body-specific behavior",
      backingLiabilityImplication: s.backing || "source authority/accounting mapping only; BTC backing and multichain liabilities not proven",
      evidenceRefs: [{ range: `${P}${FILES[s.file]}:${fn.startLine}-${fn.endLine}`, markers: rowMarkers }],
      deployedStateDependency: "implementation match, initialization, roles, peers, paths, pause, limits and balances require fixed-block reads",
      evidenceClass: "local-function-body-extracted-and-checked",
      extractedBodySha256: sha(fn.text),
    };
  });
}

const CONSTRUCTOR_SPECS = [
  { component: "StakedLBTC", rail: "canonical-staked", file: "staked", canonical: "constructor()", markers: ["_disableInitializers"], effect: "locks implementation initialization" },
  { component: "NativeLBTC", rail: "native", file: "native", canonical: "constructor()", markers: ["_disableInitializers"], effect: "locks implementation initialization" },
  { component: "Bascule", rail: "native-bascule", file: "bascule", canonical: "constructor(address,address,address,address,uint256)", markers: ["_grantRole(PAUSER_ROLE", "_grantRole(DEPOSIT_REPORTER_ROLE", "_grantRole(WITHDRAWAL_VALIDATOR_ROLE", "_mMaxDeposits = aMaxDeposits", "_validateThreshold = 0"], effect: "sets default admin delay/admin, role holders, max deposits, and default zero threshold" },
  { component: "GMPBasculeV1", rail: "gmp-bascule", file: "gmpBascule", canonical: "constructor(address,address,address,address,uint256,address)", markers: ["_grantRole(PAUSER_ROLE", "_grantRole(MINT_REPORTER_ROLE", "_grantRole(MINT_VALIDATOR_ROLE", "maxMints = aMaxMints", "validateThreshold = 0", "trustedSigner = aTrustedSigner"], effect: "sets default admin delay/admin, roles, max mints, trusted signer, and default zero threshold" },
  { component: "LombardTokenPoolV2", rail: "ccip-via-bridge-v2", file: "ccip", canonical: "constructor(IBridgeV2,IERC20Metadata,address[],address,address,uint8)", markers: ["TokenPool(", "bridge = bridge_", "safeIncreaseAllowance"], effect: "sets inherited token/allowlist/RMN/router configuration, immutable BridgeV2, version checks, and optional max allowance" },
  { component: "LBTCOFTAdapter", rail: "layerzero-escrow", file: "oftEscrow", canonical: "constructor(address,address,address)", markers: ["OFTAdapter(_token, _lzEndpoint, _owner)", "Ownable(_owner)"], effect: "passes token, LayerZero endpoint and owner into inherited OFT/Ownable constructors; inherited behavior remains unverified" },
  { component: "LBTCBurnMintOFTAdapter", rail: "layerzero-burn-mint", file: "oftBurnMint", canonical: "constructor(address,address,address)", markers: ["OFTAdapter(_token, _lzEndpoint, _owner)", "Ownable(_owner)"], effect: "passes token, LayerZero endpoint and owner into inherited OFT/Ownable constructors; inherited behavior remains unverified" },
];

// Independent mandatory coverage declaration. It is intentionally not derived
// from extracted rows or SPECS; extraction results are compared against it.
const STATIC_REQUIRED_SIGNATURES = {
  BaseLBTC: ["getFeeDigest(uint256,uint256)", "pauseMintBurn()", "unpauseMintBurn()", "pauseTransfers()", "unpauseTransfers()"],
  StakedLBTC: ["constructor()", "initialize(address,address,uint48)", "migrateToAccessControl(address[],address[])", "mint(address,uint256)", "batchMint(address[],uint256[])", "mint(bytes,bytes)", "batchMint(bytes[],bytes[])", "mintWithFee(bytes,bytes,bytes,bytes)", "batchMintWithFee(bytes[],bytes[],bytes[],bytes[])", "burn(uint256)", "burn(address,uint256)", "redeemForBtc(bytes,uint256)", "redeem(uint256)", "deposit(uint256)", "ratio()", "getRate()"],
  NativeLBTC: ["constructor()", "initialize(address,address,string,string,address,uint48)", "mint(address,uint256)", "batchMint(address[],uint256[])", "mintV1(bytes,bytes)", "batchMintV1(bytes[],bytes[])", "mintV1WithFee(bytes,bytes,bytes,bytes)", "batchMintV1WithFee(bytes[],bytes[],bytes[],bytes[])", "burn(uint256)", "burn(address,uint256)", "redeemForBtc(bytes,uint256)", "_validateAndMint(address,uint256,bytes,bytes)", "changeConsortium(address)", "changeBascule(address)", "changeAssetRouter(address)"],
  AssetRouter: ["initialize(address,uint48,bytes32,bytes32,address,address)", "deposit(address,address,uint256)", "deposit(bytes32,bytes32,bytes32,uint256)", "_deposit(address,bytes32,bytes32,bytes32,uint256)", "redeemForBtc(address,address,bytes,uint256)", "redeem(address,bytes32,address,bytes32,bytes32,uint256)", "redeem(address,address,uint256)", "_redeem(AssetRouterStorage,address,bytes32,address,bytes32,bytes,uint256,uint256,bytes32,bool)", "mint(bytes,bytes)", "batchMint(bytes[],bytes[])", "mintWithFee(bytes,bytes,bytes,bytes)", "batchMintWithFee(bytes[],bytes[],bytes[],bytes[])", "_mintWithFee(bytes,bytes,bytes,bytes)", "handlePayload(GMPUtils.Payload)", "setRoute(bytes32,bytes32,bytes32,bytes32,RouteType)", "removeRoute(bytes32,bytes32,bytes32,bytes32)", "toggleRedeem()", "changeTokenConfig(address,uint256,uint256,bool)", "changeTokenConfigExt(address,uint256,uint256,address,uint256,uint64)", "changeDepositMinAmount(address,uint256)", "changeBascule(address)", "changeOracle(address,address)", "changeMailbox(address)", "changeToNativeCommission(address,uint64)", "changeNativeToken(address)", "setMaxMintCommission(address,uint256)", "changeRedeemFee(uint256)", "changeRedeemFee(address,uint256)", "changeRedeemForBtcMinAmount(uint256)", "changeRedeemForBtcMinAmount(address,uint256)"],
  Actions: ["depositBtcV1(bytes)", "depositBridge(bytes)", "validateValSet(bytes)", "feeApproval(bytes)", "ratioUpdate(bytes)"],
  Assets: ["encodeDepositRequest(bytes32,bytes32,bytes32,bytes32,uint256)", "encodeRedeemRequest(bytes32,bytes32,bytes32,bytes,uint256)", "encodeRedeemNativeRequest(bytes32,bytes,uint256)", "decodeRelease(bytes)"],
  Validation: ["redeemFee(bytes,uint256,uint64,uint256)", "calcFeeAndDustLimit(bytes,uint256,uint64,uint256)"],
  Assert: ["feeApproval(bytes32,address,bytes)"],
  GMPUtils: ["encodePayload(bytes32,uint256,bytes32,bytes32,bytes32,bytes)", "decodeAndValidatePayload(bytes)", "hash(bytes)"],
  MessagePath: ["id(Details)"],
  Mailbox: ["initialize(address,INotaryConsortium,uint256,uint48)", "send(bytes32,bytes32,bytes32,bytes)", "deliverAndHandle(bytes,bytes)", "_verifyPayload(MailboxStorage,bytes32,uint256,bytes32,bytes,bytes)", "_handle(MailboxStorage,GMPUtils.Payload,bytes32)", "enableMessagePath(bytes32,bytes32,PathDirectionType)", "disableMessagePath(bytes32,bytes32,PathDirectionType)", "setSenderConfig(address,uint32,bool)", "withdrawFee()", "rescueERC20(IERC20,address,uint256)", "pause()", "unpause()"],
  Consortium: ["initialize(address)", "setInitialValidatorSet(bytes)", "setNextValidatorSet(bytes,bytes)", "checkProof(bytes32,bytes)", "_checkProof(bytes32,bytes)"],
  StakedLBTCOracle: ["initialize(address,address,address,bytes32,uint256,uint256,uint256)", "publishNewRatio(bytes,bytes)", "_publishNewRatio(bytes,bytes)", "_validateRatio(StakedLBTCOracleStorage,uint256,uint256,bytes32)", "changeConsortium(address)", "changeMaxAheadInterval(uint256)", "updateRatioThreshold(uint32)"],
  Bascule: ["constructor(address,address,address,address,uint256)", "updateValidateThreshold(uint256)", "pause()", "unpause()", "reportDeposits(bytes32,bytes32[])", "validateWithdrawal(bytes32,uint256)"],
  GMPBasculeV1: ["constructor(address,address,address,address,uint256,address)", "updateValidateThreshold(uint256)", "setTrustedSigner(address)", "reportMints(bytes32,Message[],bytes[])", "validateMint(Message)", "_mintID(Message)", "pause()", "unpause()"],
  BridgeV2: ["initialize(address,IMailbox)", "deposit(bytes32,address,address,bytes32,uint256,bytes32)", "deposit(bytes32,address,address,bytes32,uint256,bytes32,bytes)", "deposit(bytes32,address,bytes32,uint256,bytes32)", "deposit(bytes32,address,bytes32,uint256,bytes32,bytes)", "_deposit(bytes32,IERC20MintableBurnable,address,bytes32,uint256,bytes32,bytes)", "handlePayload(GMPUtils.Payload)", "_withdraw(BridgeV2Storage,bytes32,bytes)", "setDestinationBridge(bytes32,bytes32)", "addDestinationToken(bytes32,address,bytes32)", "setAllowance(IERC20,address,bool)", "removeDestinationToken(bytes32,address)", "setTokenRateLimits(address,RateLimits.Config)", "setSenderConfig(address,uint32,bool)", "rescueERC20(IERC20,address,uint256)"],
  Bridge: ["initialize(IBaseLBTC,address,address)", "deposit(bytes32,bytes32,uint64)", "_deposit(DestinationConfig,bytes32,bytes32,uint64)", "receivePayload(bytes32,bytes)", "authNotary(bytes,bytes)", "withdraw(bytes)", "addDestination(bytes32,bytes32,uint16,uint64,IAdapter,bool)", "removeDestination(bytes32)", "changeAdapter(bytes32,IAdapter)", "changeConsortium(INotaryConsortium)", "setRateLimits(RateLimits.Config[],RateLimits.Config[])"],
  LombardTokenPoolV2: ["constructor(IBridgeV2,IERC20Metadata,address[],address,address,uint8)", "lockOrBurn(Pool.LockOrBurnInV1)", "releaseOrMint(Pool.ReleaseOrMintInV1)", "setPath(uint64,bytes32,bytes,bytes32)", "removePath(uint64)"],
  LBTCOFTAdapter: ["constructor(address,address,address)", "empty()"],
  LBTCBurnMintOFTAdapter: ["constructor(address,address,address)", "_debit(address,uint256,uint256,uint32)", "_credit(address,uint256,uint32)"],
  EfficientRateLimitedOFTAdapter: ["setRateLimits(RateLimits.Config[],RateLimitDirection)", "_debit(address,uint256,uint256,uint32)", "_credit(address,uint256,uint32)"],
  IBCVoucher: ["initialize(IBaseLBTC,address,uint256,address)", "wrap(uint256)", "wrap(uint256,uint256)", "wrapTo(address,uint256)", "wrapTo(address,uint256,uint256)", "spend(uint256)", "spendTo(address,uint256)", "spendFrom(address,uint256)", "_wrap(address,address,uint256,uint256)", "_spend(address,address,uint256)", "setRateLimit(uint16,uint64,uint64)", "pause()", "unpause()", "setTreasuryAddress(address)", "setFee(uint256)"],
  RateLimits: ["setRateLimit(Data,Config)", "availableAmountToSend(Data)", "availableAmountToSend(uint256,uint256,uint256,uint256)", "updateLimit(Data,uint256)", "checkRateLimitSanity(uint256)"],
  EfficientRateLimiter: ["getAmountCanBeSent(uint32)", "getAmountCanBeReceived(uint32)", "_setRateLimits(RateLimits.Config[],RateLimitDirection)", "_amountCanBeSent(uint256,uint256,uint256,uint256)", "_amountCanBeReceived(uint256,uint256,uint256,uint256)", "_checkAndUpdateRateLimit(uint32,uint256,RateLimitDirection)"],
};
const STATIC_REQUIRED_KEYS = Object.entries(STATIC_REQUIRED_SIGNATURES).flatMap(([component, signatures]) => signatures.map((signature) => `${component}::${signature}`));
const STATIC_REQUIRED_DEPENDENCY_KEYS = [
  "LayerZero inherited OFT::external::endpoint/peer/replay",
  "LayerZero inherited OFT::external::escrow debit/credit",
  "Chainlink CCIP inherited TokenPool::external::lockOrBurn/releaseOrMint callback authorization",
  "Proxy upgrade administration::external::proxy admin/upgrade authorization",
];
const EXPECTED_INVARIANT_CONSTITUENTS = {
  "canonical-release-invariant": ["Mailbox::deliverAndHandle(bytes,bytes)", "Mailbox::_verifyPayload(MailboxStorage,bytes32,uint256,bytes32,bytes,bytes)", "AssetRouter::handlePayload(GMPUtils.Payload)", "GMPBasculeV1::validateMint(Message)"],
  "native-utxo-uniqueness": ["NativeLBTC::mintV1(bytes,bytes)", "NativeLBTC::_validateAndMint(address,uint256,bytes,bytes)"],
  "mailbox-handler-retry": ["Mailbox::deliverAndHandle(bytes,bytes)", "Mailbox::_verifyPayload(MailboxStorage,bytes32,uint256,bytes32,bytes,bytes)", "Mailbox::_handle(MailboxStorage,GMPUtils.Payload,bytes32)", "AssetRouter::handlePayload(GMPUtils.Payload)"],
  "ratio-domain-watch": ["StakedLBTCOracle::publishNewRatio(bytes,bytes)", "StakedLBTCOracle::_publishNewRatio(bytes,bytes)", "StakedLBTCOracle::_validateRatio(StakedLBTCOracleStorage,uint256,uint256,bytes32)"],
  "rail-conservation": ["BridgeV2::_deposit(bytes32,IERC20MintableBurnable,address,bytes32,uint256,bytes32,bytes)", "LBTCOFTAdapter::empty()", "LBTCBurnMintOFTAdapter::_debit(address,uint256,uint256,uint32)", "IBCVoucher::_wrap(address,address,uint256,uint256)"],
  "deprecated-bridge-optional-confirmations": ["Bridge::receivePayload(bytes32,bytes)", "Bridge::authNotary(bytes,bytes)", "Bridge::withdraw(bytes)", "Bridge::addDestination(bytes32,bytes32,uint16,uint64,IAdapter,bool)"],
};

function buildConstructorRows(loaded) {
  return CONSTRUCTOR_SPECS.map((s) => {
    const candidates = solidityConstructors(loaded[s.file], FILES[s.file]);
    const ctor = candidates.find((c) => c.canonicalSignature === s.canonical);
    if (!ctor) throw new Error(`constructor extraction failed: ${s.component}::${s.canonical}; found=${candidates.map((c) => c.canonicalSignature).join("|")}`);
    for (const marker of s.markers) if (!ctor.text.includes(marker)) throw new Error(`constructor marker missing ${s.component}: ${marker}`);
    const id = `${s.component.toLowerCase().replace(/[^a-z0-9_]+/g, "-")}-${ctor.canonicalSignatureHash.slice(0, 20)}`;
    return { id, component: s.component, tokenIdentity: s.rail, rail: s.rail, constructorSignature: ctor.canonicalSignature, canonicalSignature: ctor.canonicalSignature, canonicalSignatureHash: ctor.canonicalSignatureHash, sourceRange: `${P}${FILES[s.file]}:${ctor.startLine}-${ctor.endLine}`, functionInputs: ctor.parameters, actorCallerGate: "privileged deployment-time constructor authority", localModifiers: ["constructor"], effectiveCallPathGates: ["deployment only", "constructor/base-constructor checks"], orderedOperations: [s.effect], accountingEffect: s.effect, signedPayloadFields: "not-applicable", signatureDigest: "not-applicable", domainFields: "not-applicable", missingDomainFields: "not-applicable", replayKey: "deployment uniqueness/address creation", replayConsumptionTiming: "constructor executes once at deployment", survivesCaughtHandlerFailure: false, backingLiabilityImplication: "authority initialization only; deployed match/backing not proven", privilegedTrusted: true, evidenceRefs: [{ range: `${P}${FILES[s.file]}:${ctor.startLine}-${ctor.endLine}`, markers: s.markers }], evidenceClass: "local-constructor-body-extracted-and-checked" };
  });
}

function makeSummaries(rows) {
  const pick = (...pairs) => rows.filter((r) => pairs.some(([component, signature]) => r.component === component && (signature === "*" || r.canonicalSignature === signature)));
  const defs = [
    ["canonical-release-invariant", "Canonical release invariant", pick(["Mailbox", "deliverAndHandle(bytes,bytes)"], ["Mailbox", "_verifyPayload(MailboxStorage,bytes32,uint256,bytes32,bytes,bytes)"], ["AssetRouter", "handlePayload(GMPUtils.Payload)"], ["GMPBasculeV1", "validateMint(Message)"]), "Successful canonical release requires valid Consortium-signed full GMP payload, enabled path, BTC module sender, Mailbox exact-payload delivery, unspent AssetRouter payload, and a Bascule call if configured. A prior reported record is required only when amount >= threshold; below threshold may be unreported and is marked MINTED by GMPBascule."],
    ["native-utxo-uniqueness", "Native mint semantic uniqueness", pick(["NativeLBTC", "mintV1(bytes,bytes)"], ["NativeLBTC", "_validateAndMint(address,uint256,bytes,bytes)"]), "Native mint blocks exact payload SHA-256 replay only; the same UTXO under a distinct valid payload is not locally blocked by a (txid,vout) map and relies on Consortium/Bascule policy."],
    ["mailbox-handler-retry", "Mailbox handler retry", pick(["Mailbox", "deliverAndHandle(bytes,bytes)"], ["Mailbox", "_verifyPayload(MailboxStorage,bytes32,uint256,bytes32,bytes,bytes)"], ["Mailbox", "_handle(MailboxStorage,GMPUtils.Payload,bytes32)"], ["AssetRouter", "handlePayload(GMPUtils.Payload)"]), "Delivered-but-handler-failed payload can retry: Mailbox delivery persists when handler revert is caught; handler writes roll back on revert; successful handler consumes its key before mint call."],
    ["ratio-domain-watch", "Ratio replay/domain watch", pick(["StakedLBTCOracle", "publishNewRatio(bytes,bytes)"], ["StakedLBTCOracle", "_publishNewRatio(bytes,bytes)"], ["StakedLBTCOracle", "_validateRatio(StakedLBTCOracleStorage,uint256,uint256,bytes32)"]), "Strictly increasing switchTime rejects exact ratio replay, but raw signed payload lacks visible oracle-address/block.chainid domain binding; deployment/config watch only, not exploit."],
    ["rail-conservation", "Bridge rail conservation", pick(["BridgeV2", "_deposit(bytes32,IERC20MintableBurnable,address,bytes32,uint256,bytes32,bytes)"], ["LBTCOFTAdapter", "empty()"], ["LBTCBurnMintOFTAdapter", "_debit(address,uint256,uint256,uint32)"], ["IBCVoucher", "_wrap(address,address,uint256,uint256)"]), "Rails differ: locally traced BridgeV2 and burn/mint OFT burn/mint; local empty() burns escrow balance, while inherited escrow OFT lock/credit behavior remains unverified; IBCVoucher burns/mints between LBTC and voucher. Cross-rail and multichain conservation is not proven by source alone."],
    ["deprecated-bridge-optional-confirmations", "Deprecated Bridge confirmation composition", pick(["Bridge", "receivePayload(bytes32,bytes)"], ["Bridge", "authNotary(bytes,bytes)"], ["Bridge", "withdraw(bytes)"], ["Bridge", "addDestination(bytes32,bytes32,uint16,uint64,IAdapter,bool)"]), "Deprecated Bridge destination configuration makes adapter confirmation and Consortium confirmation independently optional; withdraw enforces each only when its corresponding adapter/requireConsortium configuration is enabled."],
    ["trusted-role-powers", "Trusted authority powers", rows.filter((r) => r.adminOverride === "trusted authority visible"), "Direct mint, arbitrary-holder burn, router/Consortium/Bascule/oracle/peer/path/rate-limit/rescue changes are trusted authority, not permissionless findings."],
    ["upgrade-initializer-status", "Upgrade and initializer status", rows.filter((r) => /^(initialize|migrateToAccessControl)\(/.test(r.canonicalSignature)), "Initializer/reinitializer guards are source-visible and classified privileged; deployed implementation, proxy admin, initialization version and upgrade authority remain fixed-block dependencies."],
  ];
  return defs.map(([id, component, constituents, finding]) => {
    if (!constituents.length) throw new Error(`summary has no constituents: ${id}`);
    return { id, component, tokenIdentity: "cross-component", rail: "cross-component", functionSignature: "cross-function-summary", canonicalSignature: "cross-function-summary", functionSourceRange: constituents.map((r) => r.functionSourceRange).join("; "), constituentRowIds: [...new Set(constituents.map((r) => r.id))], actorCallerGate: "composed gates from constituent rows", localModifiers: ["composed"], effectiveCallPathGates: ["composed"], pauseReentrancyGate: "composed", functionInputs: "composed", signedPayloadFields: "composed", signatureDigest: "composed", domainFields: "composed", missingDomainFields: "composed", domainBinding: "composed", replayKey: "composed", replayConsumptionTiming: "composed in constituent call order", survivesCaughtHandlerFailure: "see constituents", accountingEffect: finding, orderedOperations: ["see constituent exact ranges"], externalCallsOrder: ["see constituent exact ranges"], adminOverride: "see constituent rows", failureRetry: "see constituent rows", backingLiabilityImplication: "no backing/conservation proof", evidenceRefs: constituents.map((r) => ({ rowId: r.id, range: r.functionSourceRange })), deployedStateDependency: "all constituent deployed dependencies unresolved", evidenceClass: "local-cross-function-summary" };
  });
}

const WATCH = [
  ["semantic-utxo-uniqueness", "Same UTXO semantic uniqueness is delegated to Consortium/Bascule policy beyond exact payload-hash replay."],
  ["raw-consortium-hash-domain", "Consortium verifies consumer-supplied raw hashes; domain strength depends on each consumer payload."],
  ["gmp-bascule-mintid-domain", "GMPBascule mintID includes block.chainid but not contract address."],
  ["bascule-below-threshold", "Below-threshold unreported operation allowance is explicit design behavior."],
  ["destination-caller-length", "BridgeV2 does not visibly validate destinationCaller length; current source assessment is DoS/operational only."],
  ["ibc-uint64", "IBCVoucher uint64 accounting boundary is theoretical only without reachable amounts/state."],
  ["deprecated-bridge", "Deprecated Bridge configured reachability and live configuration are unknown."],
  ["external-ccip-layerzero", "CCIP and LayerZero inherited endpoint/peer/replay assumptions remain external dependencies."],
  ["authority-concentration", "Role/admin concentration is trusted-authority risk, not permissionless reachability."],
].map(([id, statement]) => ({ id, classification: "watch-not-vulnerability", statement, sourceVulnerabilityClaim: false, permissionlessReachabilityProven: false }));

const REJECTED = [
  "Arbitrary MINTER_ROLE, OPERATOR_ROLE, RELAYER_ROLE, owner, or admin power is not a permissionless exploit.",
  "Retry after a caught handler revert is not proof of double mint.",
  "A replay lock written before an uncaught revert does not persist because EVM state reverts atomically.",
  "No current role, validator threshold, Bascule threshold, peer, path, pause, limit, implementation, or deprecated-bridge reachability is inferred from source.",
  "Consumer collateral rows and economics are outside this source-authority step and do not establish a route.",
  "A missing destinationCaller length check is not classified as value extraction from source alone.",
  "Theoretical uint64 bounds are not classified as reachable invariant violations.",
].map((statement, index) => ({ id: `rejected-${index + 1}`, statement, classification: "explicit-false-positive-rejection" }));

const EXTERNAL_DEPENDENCIES = [
  { id: "layerzero-endpoint-peer-replay", component: "LayerZero inherited OFT", canonicalSignature: "external::endpoint/peer/replay", status: "external-inherited-assumption-unverified", assumption: "Endpoint authentication, peer configuration, message replay protection, and receive authorization are inherited and their dependency source is not in this pinned local manifest." },
  { id: "layerzero-escrow-credit", component: "LayerZero inherited OFT", canonicalSignature: "external::escrow debit/credit", status: "external-inherited-assumption-unverified", assumption: "Escrow OFT lock/debit and destination credit behavior is inherited and unproven here; only local LBTCOFTAdapter.empty() burn authority is source-proven." },
  { id: "ccip-tokenpool-callback-auth", component: "Chainlink CCIP inherited TokenPool", canonicalSignature: "external::lockOrBurn/releaseOrMint callback authorization", status: "external-inherited-assumption-unverified", assumption: "CCIP Router/onRamp/offRamp callback authorization and inherited TokenPool checks remain unverified; local callback bodies invoking BridgeV2/Mailbox are source-proven only after entry." },
  { id: "proxy-upgrade-authorization", component: "Proxy upgrade administration", canonicalSignature: "external::proxy admin/upgrade authorization", status: "external-inherited-assumption-unverified", assumption: "No local _authorizeUpgrade function is present in mapped implementations; proxy type, admin and upgrade authorization are deployed/inherited dependencies requiring fixed-block verification." },
];

function groupCount(rows, key) {
  return rows.reduce((out, row) => { out[row[key]] = (out[row[key]] || 0) + 1; return out; }, {});
}

function render(raw) {
  const lines = [
    "# Lombard LBTC Step-2 Pinned Source Authority Triage", "",
    `Signal: **${raw.signal}**`, "", `Classification: **${raw.classification}**`, "",
    `Snapshot: \`${raw.snapshotLabel}\` (deterministic; no runtime timestamp).`, "",
    "## Result", "",
    "Pinned source authority and accounting order are mapped with brace-aware bounded function extraction. No deployed implementation/configuration, BTC backing, multichain liability conservation, permissionless invariant violation, or positive route is proven.", "",
    "## Exact metrics", "",
    `- sourceFiles=${raw.summary.sourceFiles}; sourceHashes=${raw.summary.sourceHashes}; gitBlobIds=${raw.summary.gitBlobIds}; extractedFunctions=${raw.summary.extractedFunctions}; crossFunctionSummaries=${raw.summary.crossFunctionSummaries}`,
    `- extractorFixture=${raw.extractorFixture.status}; fixtureCases=${raw.extractorFixture.caseCount}; requiredManifest=${raw.summary.requiredManifest}; requiredMissing=${raw.summary.requiredManifestMissing}; canonicalSignatures=${raw.summary.canonicalSignatures}; semanticSigningRows=${raw.summary.semanticSigningRows}; semanticHighRiskRows=${raw.summary.semanticHighRiskRows}; highRiskRegistryKeys=${raw.highRiskRegistryKeys}; highRiskRegistryFallbacks=${raw.highRiskRegistryFallbacks}; inheritedDependencies=${raw.summary.inheritedDependencies}`,
    `- invariants=${raw.summary.invariants}; watchCandidates=${raw.summary.watchCandidates}; rejectedFalsePositives=${raw.summary.rejectedFalsePositives}; privilegedPowers=${raw.summary.privilegedPowers}; unresolvedDeployedDependencies=${raw.summary.unresolvedDeployedDependencies}`,
    `- sourceVulnerabilityClaims=${raw.sourceVulnerabilityClaims}; permissionlessInvariantViolations=${raw.permissionlessInvariantViolations}; routePositive=${raw.routePositive} (${raw.routePositiveMeaning}); routeEvidenceStatus=${raw.routeEvidenceStatus}`, "",
    "### Functions by component", "",
  ];
  for (const [name, count] of Object.entries(raw.summary.functionsByComponent)) lines.push(`- ${name}: ${count}`);
  lines.push("", "### Functions by rail", "");
  for (const [name, count] of Object.entries(raw.summary.functionsByRail)) lines.push(`- ${name}: ${count}`);
  lines.push("", "## Mandatory coverage manifest", "", `Status: ${raw.requiredFunctionManifest.status}; required=${raw.requiredFunctionManifest.requiredCount}; missing=${raw.requiredFunctionManifest.missingCount}. Extractor fixture: ${raw.extractorFixture.status} (${raw.extractorFixture.caseCount} cases).`, "");
  lines.push("## Semantic high-risk signing and replay paths", "");
  lines.push("| Component | Signature | Signed fields | Digest | Domain | Missing domain | Replay timing | Ordered operations |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const r of raw.semanticHighRiskRows) lines.push(`| ${r.component} | ${r.canonicalSignature} | ${JSON.stringify(r.signedPayloadFields).replace(/\|/g, "\\|")} | ${r.signatureDigest} | ${JSON.stringify(r.domainFields).replace(/\|/g, "\\|")} | ${JSON.stringify(r.missingDomainFields).replace(/\|/g, "\\|")} | ${r.replayConsumptionTiming} | ${r.orderedOperations.join(" → ")} |`);
  lines.push("", "## Inherited dependency unknowns", "");
  for (const d of raw.externalInheritedDependencies) lines.push(`- **${d.component} / ${d.canonicalSignature}** — ${d.status}: ${d.assumption}`);
  lines.push("", "## Extracted function matrix", "");
  lines.push("| ID | Component / rail | Function | Range | Actor gate | Pause/reentrancy | Replay | Accounting | Backing implication |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const r of raw.functionRows) lines.push(`| ${r.id} | ${r.component} / ${r.rail} | ${r.functionSignature.replace(/\|/g, "\\|")} | ${r.functionSourceRange} | ${r.actorCallerGate} | ${r.pauseReentrancyGate} | ${r.replayKey} | ${r.accountingEffect} | ${r.backingLiabilityImplication} |`);
  lines.push("", "## Cross-component invariants", "");
  for (const r of raw.crossFunctionSummaries) lines.push(`- **${r.component}** — ${r.accountingEffect} Ranges: ${r.functionSourceRange}`);
  lines.push("", "## Watch candidates", "");
  for (const r of raw.watchCandidates) lines.push(`- **${r.id}** — ${r.statement}`);
  lines.push("", "## Explicit false-positive rejections", "");
  for (const r of raw.rejectedFalsePositives) lines.push(`- ${r.statement}`);
  lines.push("", "## Provenance", "", `- Scanner SHA-256: \`${raw.provenance.scanner.sha256}\`.`);
  for (const r of raw.provenance.sources) lines.push(`- \`${r.path}\`: SHA-256 \`${r.sha256}\`; blob \`${r.gitBlobId}\`.`);
  lines.push("", "## Closed gates / next step", "", `- evidenceComplete=${raw.evidenceComplete}; closureEligible=${raw.closureEligible}; executableNow=${raw.executableNow}; signedActionJustified=${raw.signedActionJustified}; forkJustified=${raw.forkJustified}.`, `- Required next step: ${raw.requiredNextStep}`, "");
  return lines.join("\n");
}

function selfCheck(raw, loaded) {
  const ids = [...raw.functionRows, ...raw.constructorRows, ...raw.crossFunctionSummaries].map((r) => r.id);
  const ranges = raw.functionRows.map((r) => r.functionSourceRange);
  if (raw.snapshotLabel !== SNAPSHOT || raw.sourceCheckout.head !== COMMIT) throw new Error("pin self-check failed");
  if (raw.sourceCheckout.statusShort.join("\n") !== "?? .yarnrc.yml" || raw.sourceCheckout.yarnrcRead !== false) throw new Error("dirty caveat self-check failed");
  if (new Set(ids).size !== ids.length) throw new Error("duplicate row ids");
  if (new Set(ranges).size !== ranges.length) throw new Error("duplicate extracted function rows");
  const canonicalKeys = raw.functionRows.map((r) => `${r.component}::${r.canonicalSignature}`);
  if (new Set(canonicalKeys).size !== canonicalKeys.length) throw new Error("duplicate canonical component/signature rows");
  if (!raw.functionRows.every((r) => r.id === `${r.component.toLowerCase().replace(/[^a-z0-9_]+/g, "-")}-${r.canonicalSignatureHash.slice(0, 20)}` && !Object.prototype.hasOwnProperty.call(r, "overloadOccurrence"))) throw new Error("canonical identity self-check failed");
  if (raw.functionRows.length !== SPECS.length || !raw.functionRows.every((r) => r.evidenceClass === "local-function-body-extracted-and-checked" && r.evidenceRefs[0].markers.every((m) => r.evidenceRefs[0].range && m))) throw new Error("function extraction/marker self-check failed");
  const requiredFields = ["component", "tokenIdentity", "rail", "functionSignature", "canonicalSignature", "canonicalSignatureHash", "functionSourceRange", "actorCallerGate", "localModifiers", "effectiveCallPathGates", "pauseReentrancyGate", "functionInputs", "signedPayloadFields", "signatureDigest", "domainFields", "missingDomainFields", "domainBinding", "replayKey", "replayConsumptionTiming", "survivesCaughtHandlerFailure", "accountingEffect", "orderedOperations", "externalCallsOrder", "adminOverride", "privilegedTrusted", "failureRetry", "backingLiabilityImplication", "evidenceRefs", "deployedStateDependency", "evidenceClass"];
  if (!raw.functionRows.every((r) => requiredFields.every((field) => Object.prototype.hasOwnProperty.call(r, field) && r[field] != null) && r.replayKey && r.replayConsumptionTiming && r.accountingEffect && r.backingLiabilityImplication)) throw new Error("value row completeness failed");
  if (!raw.crossFunctionSummaries.every((r) => r.evidenceClass === "local-cross-function-summary" && r.constituentRowIds.length && r.functionSourceRange)) throw new Error("summary self-check failed");
  const rowById = new Map(raw.functionRows.map((r) => [r.id, r]));
  for (const [invariantId, expected] of Object.entries(EXPECTED_INVARIANT_CONSTITUENTS)) {
    const summary = raw.crossFunctionSummaries.find((r) => r.id === invariantId);
    if (!summary) throw new Error(`missing invariant summary: ${invariantId}`);
    const actual = summary.constituentRowIds.map((id) => { const row = rowById.get(id); if (!row) throw new Error(`unknown invariant constituent ${id}`); return `${row.component}::${row.canonicalSignature}`; }).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) throw new Error(`invariant constituent mismatch ${invariantId}: ${actual.join("|")}`);
  }
  if (!raw.semanticHighRiskRows.every((r) => r.orderedOperationsFallback === false)) throw new Error("semantic high-risk fallback rows present");
  const highRiskRows = new Map(raw.functionRows.map((r) => [`${r.component}::${r.canonicalSignature}`, r]));
  for (const key of HIGH_RISK_KEYS) {
    const row = highRiskRows.get(key);
    if (!row) throw new Error(`high-risk registry row missing: ${key}`);
    if (operationSemantics(row.component, row.canonicalSignature).fallback !== false) throw new Error(`high-risk registry fallback: ${key}`);
  }
  if (raw.highRiskRegistryKeys !== HIGH_RISK_KEYS.size || raw.highRiskRegistryFallbacks !== 0) throw new Error("high-risk registry metrics failed");
  const scannerText = fs.readFileSync(path.join(ROOT, SCANNER), "utf8");
  const staleSelector = ["handlePayload(", "Payload)"].join("");
  const oldIbcWording = ["external IBC relayer", "/message replay"].join("");
  const oldIbcGeneric = ["external IBC", " semantics"].join("");
  if (scannerText.includes(staleSelector)) throw new Error("stale semantic selector present");
  if (operationSemantics("GMPUtils", "encodePayload(bytes32,uint256,bytes32,bytes32,bytes32,bytes)").fallback !== true) throw new Error("generic signed semantic template must be fallback");
  const authNotary = operationSemantics("Bridge", "authNotary(bytes,bytes)").orderedOperations.join(" -> ");
  if (!authNotary.includes("set notarized=true before Consortium.checkProof")) throw new Error("authNotary set-before-proof ordering missing");
  if (scannerText.includes(oldIbcWording) || scannerText.includes(oldIbcGeneric)) throw new Error("old IBC replay wording present");
  if (!raw.constructorRows.every((r) => r.evidenceClass === "local-constructor-body-extracted-and-checked" && r.privilegedTrusted && r.evidenceRefs[0].markers.length)) throw new Error("constructor semantic row failed");
  if (raw.extractorFixture.status !== "PASS" || raw.extractorFixture.caseCount !== 6 || !Object.values(raw.extractorFixture.cases).every(Boolean)) throw new Error("extractor fixture self-check failed");
  if (raw.requiredFunctionManifest.missingCount !== 0 || raw.requiredFunctionManifest.requiredCount !== STATIC_REQUIRED_KEYS.length + STATIC_REQUIRED_DEPENDENCY_KEYS.length || raw.requiredFunctionManifest.source !== "independent-static-expected-key-list") throw new Error("required manifest self-check failed");
  const selected = ["StakedLBTC::mint(address,uint256)", "StakedLBTC::mint(bytes,bytes)", "StakedLBTC::burn(address,uint256)", "BridgeV2::deposit(bytes32,address,address,bytes32,uint256,bytes32)", "BridgeV2::deposit(bytes32,address,address,bytes32,uint256,bytes32,bytes)", "BridgeV2::deposit(bytes32,address,bytes32,uint256,bytes32)", "BridgeV2::deposit(bytes32,address,bytes32,uint256,bytes32,bytes)", "IBCVoucher::wrapTo(address,uint256)", "IBCVoucher::wrapTo(address,uint256,uint256)"];
  if (!selected.every((key) => canonicalKeys.includes(key))) throw new Error("selected canonical signature self-check failed");
  if (!raw.externalInheritedDependencies.every((d) => d.status === "external-inherited-assumption-unverified")) throw new Error("inherited dependency labels failed");
  const privilegedIds = new Set(raw.privilegedPowers.map((p) => p.rowId));
  const allRestricted = [...raw.functionRows, ...raw.constructorRows].filter((r) => r.privilegedTrusted);
  if (!allRestricted.every((r) => privilegedIds.has(r.id)) || privilegedIds.size !== allRestricted.length) throw new Error("privileged coverage failed");
  if (!raw.provenance.sources.every((r) => /^[a-f0-9]{64}$/.test(r.sha256) && /^[a-f0-9]{40}$/.test(r.gitBlobId))) throw new Error("source provenance failed");
  if (raw.provenance.scanner.sha256 !== sha(fs.readFileSync(path.join(ROOT, SCANNER)))) throw new Error("scanner hash failed");
  if (raw.watchCandidates.some((r) => r.classification !== "watch-not-vulnerability" || r.sourceVulnerabilityClaim || r.permissionlessReachabilityProven)) throw new Error("candidate labels failed");
  if (raw.sourceVulnerabilityClaims || raw.permissionlessInvariantViolations || raw.routePositive || raw.routeEvidenceStatus !== "unknown" || raw.evidenceComplete || raw.closureEligible || raw.executableNow || raw.signedActionJustified || raw.forkJustified) throw new Error("gate self-check failed");
  if (Object.values(raw.safety).some(Boolean)) throw new Error("unsafe action self-check failed");
  JSON.parse(JSON.stringify(raw));
  return { status: "passed", commit: "passed", sourceHashes: raw.provenance.sources.length, gitBlobIds: raw.provenance.sources.length, extractorFixture: "PASS", fixtureCases: raw.extractorFixture.caseCount, requiredManifest: raw.requiredFunctionManifest.requiredCount, requiredManifestMissing: 0, invariantConstituentChecks: Object.keys(EXPECTED_INVARIANT_CONSTITUENTS).length, canonicalSignatures: canonicalKeys.length, semanticSigningRows: raw.semanticSigningRows.length, semanticHighRiskRows: raw.semanticHighRiskRows.length, semanticHighRiskFallbacks: 0, highRiskRegistryKeys: raw.highRiskRegistryKeys, highRiskRegistryFallbacks: raw.highRiskRegistryFallbacks, constructorRows: raw.constructorRows.length, inheritedDependencies: raw.externalInheritedDependencies.length, extractedBodies: raw.functionRows.length, perRowMarkers: raw.functionRows.reduce((n, r) => n + r.evidenceRefs[0].markers.length, 0) + raw.constructorRows.reduce((n, r) => n + r.evidenceRefs[0].markers.length, 0), uniqueRowIds: ids.length, duplicateFunctionRows: "none", valueRowCompleteness: "passed", privilegedCoverage: "passed", candidateLabels: "passed", gates: "passed-fail-closed", duplicateKeys: "passed-by-object-construction", unsafeActions: "none" };
}

function main() {
  const head = git("rev-parse", "HEAD");
  if (head !== COMMIT) throw new Error(`unexpected HEAD: ${head}`);
  const statusShort = git("status", "--short").split(/\r?\n/).filter(Boolean);
  const { loaded, manifest } = loadSources();
  const extractorFixture = extractorFixtureSelfTest();
  const functionRows = buildRows(loaded);
  const constructorRows = buildConstructorRows(loaded);
  const summaries = makeSummaries(functionRows);
  const mainnet = JSON.parse(loaded.mainnet);
  const privileged = [...functionRows, ...constructorRows].filter((r) => r.privilegedTrusted);
  const semanticSigningRows = functionRows.filter((r) => r.signatureDigest !== "not-applicable");
  const semanticHighRiskRows = functionRows.filter((r) => !r.orderedOperationsFallback && (HIGH_RISK_KEYS.has(`${r.component}::${r.canonicalSignature}`) || r.signatureDigest !== "not-applicable" || ["NativeLBTC", "Mailbox", "AssetRouter", "Bascule", "GMPBasculeV1", "BridgeV2", "Bridge", "IBCVoucher"].includes(r.component)));
  const highRiskRegistryRows = functionRows.filter((r) => HIGH_RISK_KEYS.has(`${r.component}::${r.canonicalSignature}`));
  const highRiskRegistryFallbacks = highRiskRegistryRows.filter((r) => r.orderedOperationsFallback).length;
  const actualRows = [...functionRows, ...constructorRows];
  const actualByKey = new Map(actualRows.map((r) => [`${r.component}::${r.canonicalSignature}`, r]));
  const dependencyByKey = new Map(EXTERNAL_DEPENDENCIES.map((d) => [`${d.component}::${d.canonicalSignature}`, d]));
  const expectedKeys = [...STATIC_REQUIRED_KEYS, ...STATIC_REQUIRED_DEPENDENCY_KEYS];
  const missing = expectedKeys.filter((key) => !actualByKey.has(key) && !dependencyByKey.has(key));
  const requiredEntries = expectedKeys.map((key) => { const row = actualByKey.get(key), dep = dependencyByKey.get(key); return { key, component: row?.component || dep?.component, canonicalSignature: row?.canonicalSignature || dep?.canonicalSignature, rowId: row?.id || null, status: row ? (row.evidenceClass === "local-constructor-body-extracted-and-checked" ? "covered-local-constructor-body-extracted-and-checked" : "covered-local-function-body-extracted-and-checked") : dep ? dep.status : "missing" }; });
  const requiredFunctionManifest = { source: "independent-static-expected-key-list", status: missing.length ? "FAIL" : "PASS", requiredCount: expectedKeys.length, coveredLocalCount: requiredEntries.filter((r) => r.status.startsWith("covered-local")).length, externalDependencyCount: requiredEntries.filter((r) => r.status === "external-inherited-assumption-unverified").length, missingCount: missing.length, missing, entries: requiredEntries };
  if (missing.length) throw new Error(`required manifest missing: ${missing.join(" | ")}`);
  const unresolved = ["proxy implementation/code match", "initializer/reinitializer version", "roles and owners", "Consortium epoch/validators/weights/threshold/rotation", "NativeLBTC and AssetRouter Bascule addresses/thresholds/report state", "StakedLBTCOracle Consortium/ratio/switch time/bounds", "Mailbox paths/senders/fees/pause", "BridgeV2 peers/tokens/senders/allowances/rate limits", "deprecated Bridge reachability/destinations/adapters/confirmation modes", "CCIP pools/remotes", "LayerZero endpoints/peers/rate limits", "IBC relayers/operators/rate state", "BTC backing versus canonical/native/multichain supply, escrow and vouchers"];
  const raw = {
    snapshotLabel: SNAPSHOT,
    scanner: SCANNER,
    signal: "🟠 WATCH",
    classification: "INCOMPLETE/WATCH — PINNED SOURCE AUTHORITY MAPPED, DEPLOYED STATE/BACKING BLOCKED",
    scope: "Deterministic offline brace-aware extraction of pinned Lombard source authority, replay and accounting order",
    sourceCheckout: { path: "targets/lombard-evm-smart-contracts", expectedHead: COMMIT, head, statusShort, pristine: false, yarnrcRead: false, caveat: ".yarnrc.yml observed only as untracked via Git status; not read and relevance not assessed" },
    tokenIdentity: { canonicalStakedLBTC: mainnet.mainnet.lombard.StakedLBTC, nativeLBTCBTCb: mainnet.mainnet.lombard.NativeLBTC, backingProven: false },
    safety: { network: false, endpoints: false, secrets: false, builds: false, tests: false, transactions: false, signing: false, forks: false, wallets: false, executor: false },
    provenance: { scanner: { path: SCANNER, sha256: sha(fs.readFileSync(path.join(ROOT, SCANNER))) }, sources: manifest },
    extractorFixture,
    canonicalIdentity: { parameterParsing: "balanced-parentheses/top-level commas", normalization: "remove data locations and parameter names; normalize uint/int aliases; preserve arrays, struct/tuple syntax and leading underscores", signatureHash: "SHA-256 UTF-8 canonical signature", rowId: "normalized component + first 20 hex characters of canonical signature SHA-256", overloadSelection: "canonical signature only; occurrence is never used" },
    requiredFunctionManifest,
    highRiskRegistryKeys: HIGH_RISK_KEYS.size,
    highRiskRegistryFallbacks,
    semanticSigningRows,
    semanticHighRiskRows,
    externalInheritedDependencies: EXTERNAL_DEPENDENCIES,
    functionRows,
    constructorRows,
    crossFunctionSummaries: summaries,
    invariants: summaries.map((r) => ({ id: r.id, statement: r.accountingEffect, evidenceClass: r.evidenceClass, constituentRowIds: r.constituentRowIds })),
    watchCandidates: WATCH,
    rejectedFalsePositives: REJECTED,
    privilegedPowers: privileged.map((r) => ({ rowId: r.id, component: r.component, functionSignature: r.functionSignature || r.constructorSignature, actor: r.actorCallerGate, classification: "trusted-authority-not-permissionless-finding" })),
    unresolvedDeployedDependencies: unresolved,
    summary: {
      sourceFiles: manifest.length,
      sourceHashes: manifest.length,
      gitBlobIds: manifest.length,
      extractedFunctions: functionRows.length,
      constructorRows: constructorRows.length,
      canonicalSignatures: functionRows.length,
      semanticSigningRows: semanticSigningRows.length,
      semanticHighRiskRows: semanticHighRiskRows.length,
      highRiskRegistryKeys: HIGH_RISK_KEYS.size,
      highRiskRegistryFallbacks,
      requiredManifest: expectedKeys.length,
      requiredManifestMissing: missing.length,
      inheritedDependencies: EXTERNAL_DEPENDENCIES.length,
      crossFunctionSummaries: summaries.length,
      invariants: summaries.length,
      watchCandidates: WATCH.length,
      rejectedFalsePositives: REJECTED.length,
      privilegedPowers: privileged.length,
      unresolvedDeployedDependencies: unresolved.length,
      functionsByComponent: groupCount(functionRows, "component"),
      functionsByRail: groupCount(functionRows, "rail"),
    },
    sourceVulnerabilityClaims: 0,
    permissionlessInvariantViolations: 0,
    routePositive: 0,
    routePositiveMeaning: "zero proven positive routes, not a negative assessment",
    routeEvidenceStatus: "unknown",
    evidenceComplete: false,
    closureEligible: false,
    executableNow: 0,
    signedActionJustified: false,
    forkJustified: false,
    requiredNextStep: "Separately authorized sanitized fixed-block read-only deployed implementation/roles/threshold/Bascule/oracle/bridge peer-limit-pause/deprecated reachability plus backing-vs-multichain supply/escrow/voucher reconciliation; no fork/executor.",
  };
  raw.selfChecks = selfCheck(raw, loaded);
  writeOwned(OUT_JSON, `${JSON.stringify(raw, null, 2)}\n`);
  writeOwned(OUT_MD, `${render(raw)}\n`);
  console.log(`wrote ${OUT_JSON} and ${OUT_MD}`);
  console.log(`sourceFiles=${raw.summary.sourceFiles} sourceHashes=${raw.summary.sourceHashes} gitBlobIds=${raw.summary.gitBlobIds} extractorFixture=${raw.extractorFixture.status} fixtureCases=${raw.extractorFixture.caseCount} requiredManifest=${raw.summary.requiredManifest} requiredMissing=${raw.summary.requiredManifestMissing} canonicalSignatures=${raw.summary.canonicalSignatures} semanticSigningRows=${raw.summary.semanticSigningRows} semanticHighRiskRows=${raw.summary.semanticHighRiskRows} highRiskRegistryKeys=${raw.highRiskRegistryKeys} highRiskRegistryFallbacks=${raw.highRiskRegistryFallbacks} extractedFunctions=${raw.summary.extractedFunctions} crossFunctionSummaries=${raw.summary.crossFunctionSummaries} invariants=${raw.summary.invariants} watchCandidates=${raw.summary.watchCandidates} rejectedFalsePositives=${raw.summary.rejectedFalsePositives} privilegedPowers=${raw.summary.privilegedPowers} inheritedDependencies=${raw.summary.inheritedDependencies} unresolvedDeployedDependencies=${raw.summary.unresolvedDeployedDependencies}`);
  console.log(`markers=${raw.selfChecks.perRowMarkers} uniqueRowIds=${raw.selfChecks.uniqueRowIds} selfChecks=${raw.selfChecks.status} privilegedCoverage=${raw.selfChecks.privilegedCoverage} unsafeActions=${raw.selfChecks.unsafeActions}`);
  console.log(`classification=${raw.classification} sourceVulnerabilityClaims=${raw.sourceVulnerabilityClaims} permissionlessInvariantViolations=${raw.permissionlessInvariantViolations} routePositive=${raw.routePositive} routeEvidenceStatus=${raw.routeEvidenceStatus} evidenceComplete=${raw.evidenceComplete} closureEligible=${raw.closureEligible} executableNow=${raw.executableNow} signedActionJustified=${raw.signedActionJustified} forkJustified=${raw.forkJustified}`);
}

try { main(); } catch (error) { console.error(`scan-lombard-lbtc-source-authority failed: ${error.message}`); process.exitCode = 1; }
