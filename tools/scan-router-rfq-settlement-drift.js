#!/usr/bin/env node
// Read-only router/RFQ/deprecated settlement drift scanner.
// Scans deployed router bytecode and optional local source checkouts for order-hash vs settlement-field drift.

const fs = require("fs");
const path = require("path");
const { rpcCall, resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "router-rfq-settlement-drift.json");
const OUT_MD = path.join(WORKSPACE, "reports", "router-rfq-settlement-drift-triage.md");
const QUIET = process.argv.includes("--quiet");

const DEPLOYED_TARGETS = [
  { name: "1inch Aggregation Router v5", protocol: "1inch", chainId: 1, chain: "Ethereum", address: "0x1111111254EEB25477B68fb85Ed929f73A960582", priority: 10, deprecated: true },
  { name: "1inch Router / LOP v4 style", protocol: "1inch", chainId: 1, chain: "Ethereum", address: "0x111111125421cA6dc452d289314280a0f8842A65", priority: 10, deprecated: false },
  { name: "0x Exchange Proxy", protocol: "0x / Matcha", chainId: 1, chain: "Ethereum", address: "0xDef1C0ded9bec7F1a1670819833240f027b25EfF", priority: 9, deprecated: false },
  { name: "CoW Protocol GPv2Settlement", protocol: "CoW Protocol", chainId: 1, chain: "Ethereum", address: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41", priority: 8, deprecated: false },
  { name: "Socket Gateway", protocol: "Socket / Bungee", chainId: 1, chain: "Ethereum", address: "0x3a23F943181408EAC424116Af7b7790c94Cb97a5", priority: 8, deprecated: false },
  { name: "LI.FI Diamond", protocol: "LI.FI", chainId: 1, chain: "Ethereum", address: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE", priority: 8, deprecated: false },
  { name: "ParaSwap Augustus", protocol: "ParaSwap", chainId: 1, chain: "Ethereum", address: "0xDEF171Fe48CF0115B1d80b88dc8eAB59176FEe57", priority: 7, deprecated: false },
  { name: "Odos Router v2", protocol: "Odos", chainId: 1, chain: "Ethereum", address: "0xCf5540fFFCdC3d510B18bFcA6d2b9987b0772559", priority: 7, deprecated: false },
  { name: "Stargate Router", protocol: "Stargate", chainId: 1, chain: "Ethereum", address: "0x8731d54E9D02c286767d56ac03e8037C07e01e98", priority: 6, deprecated: true },
  { name: "Uniswap Universal Router", protocol: "Uniswap", chainId: 1, chain: "Ethereum", address: "0xEf1c6E67703c7BD7107eed8303Fbe6EC2554BF6B", priority: 5, deprecated: false },
  { name: "LI.FI Diamond", protocol: "LI.FI", chainId: 42161, chain: "Arbitrum", address: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE", priority: 6, deprecated: false },
  { name: "Socket Gateway", protocol: "Socket / Bungee", chainId: 42161, chain: "Arbitrum", address: "0x3a23F943181408EAC424116Af7b7790c94Cb97a5", priority: 6, deprecated: false },
  { name: "0x Exchange Proxy", protocol: "0x / Matcha", chainId: 8453, chain: "Base", address: "0xDef1C0ded9bec7F1a1670819833240f027b25EfF", priority: 6, deprecated: false },
  { name: "LI.FI Diamond", protocol: "LI.FI", chainId: 8453, chain: "Base", address: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE", priority: 6, deprecated: false },
];

const SOURCE_TARGETS = [
  { name: "1inch Limit Order / Settlement", chain: "Ethereum", priority: 10, dirs: ["targets/limit-order-protocol/contracts", "targets/1inch-limit-order-protocol/contracts", "targets/1inch-aggregation-router/contracts"] },
  { name: "0x / Matcha", chain: "Ethereum/Base", priority: 9, dirs: ["targets/0x-protocol/contracts", "targets/protocol/packages/contract-addresses", "targets/protocol/contracts"] },
  { name: "CoW Protocol", chain: "Ethereum", priority: 8, dirs: ["targets/cow-protocol-contracts/src/contracts", "targets/gp-v2-contracts/src/contracts"] },
  { name: "Socket / Bungee", chain: "multi-chain", priority: 8, dirs: ["targets/socket-contracts/contracts", "targets/bungee-contracts/contracts"] },
  { name: "LI.FI", chain: "multi-chain", priority: 8, dirs: ["targets/lifi-contracts/src", "targets/lifi-contracts/contracts"] },
  { name: "ParaSwap", chain: "multi-chain", priority: 7, dirs: ["targets/paraswap-contracts/contracts", "targets/paraswap-dex-lib/contracts"] },
  { name: "Odos", chain: "multi-chain", priority: 7, dirs: ["targets/odos-router/contracts", "targets/odos-contracts/contracts"] },
  { name: "deBridge DLN", chain: "multi-chain", priority: 7, dirs: ["targets/dln-contracts/contracts", "targets/debridge-contracts/contracts"] },
];

const TEXT_EXTS = new Set([".sol", ".ts", ".js"]);
const EXCLUDED_DIRS = new Set([".git", "node_modules", "build", "dist", "out", "cache", "artifacts", "coverage", "generated", "abi", "lib"]);
const EXCLUDED_PATH_RE = /[\\/](test|tests|mock|mocks|script|scripts|docs?|examples?)[\\/]/i;

const FIELD_TERMS = ["maker", "taker", "sellToken", "buyToken", "srcToken", "dstToken", "sellAmount", "buyAmount", "amount", "receiver", "recipient", "resolver", "allowedSender", "permit", "deadline", "expiry", "salt", "nonce", "chainId", "verifyingContract"];
const ORDER_TERMS = ["order", "rfq", "fill", "settle", "settlement", "resolve", "resolver", "maker", "taker", "quote", "swap"];
const SIGNATURE_TERMS = ["ecrecover", "ECDSA", "SignatureChecker", "isValidSignature", "_hashTypedData", "hashTypedData", "EIP712", "DOMAIN_SEPARATOR", "permit", "signature", "signer"];
const TRANSFER_TERMS = ["transferFrom", "safeTransferFrom", "transfer", "approve", "permitTransferFrom", "allowance"];
const SETTLEMENT_TERMS = ["fillOrder", "settle", "settleOrder", "execute", "swap", "transformERC20", "fillRfq", "fillLimitOrder", "clipperSwap", "callBytes", "target", "executor", "interaction", "callback"];
const DRIFT_TERMS = ["assembly", "calldataload", "calldata", "offset", "slice", "mload", "delegatecall", "functionCall", "call{", ".call(", "arbitrary", "raw", "bytes"];
const CONSUMPTION_TERMS = ["filled", "remaining", "cancelled", "canceled", "invalidator", "bitInvalidator", "orderStatus", "filledAmount", "remainingAmount", "nonce", "permit2"];
const DOMAIN_TERMS = ["chainId", "block.chainid", "DOMAIN_SEPARATOR", "verifyingContract", "address(this)", "EIP712", "domainSeparator"];

const BYTECODE_SELECTORS = [
  { selector: "23b872dd", name: "transferFrom(address,address,uint256)", kind: "value-move" },
  { selector: "095ea7b3", name: "approve(address,uint256)", kind: "approval" },
  { selector: "d505accf", name: "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)", kind: "signature" },
  { selector: "5ae401dc", name: "multicall(bytes[])", kind: "batching" },
  { selector: "ac9650d8", name: "multicall(bytes[])", kind: "batching" },
  { selector: "3598d8ab", name: "execute(bytes,bytes[])", kind: "execution" },
  { selector: "1f0464d1", name: "fillOrder(...)", kind: "order" },
  { selector: "a2c6274b", name: "fillRfqOrder(...)", kind: "order" },
  { selector: "bc80f1a8", name: "swap(...)", kind: "swap" },
  { selector: "12aa3caf", name: "swap(...)", kind: "swap" },
];

function exists(filePath) {
  try { return fs.existsSync(filePath); } catch (_) { return false; }
}

function rel(filePath) {
  return path.relative(WORKSPACE, filePath).replace(/\\/g, "/");
}

function safeRead(filePath) {
  try { return fs.readFileSync(filePath, "utf8"); } catch (_) { return ""; }
}

function readJson(filePath, fallback = null) {
  try {
    if (!exists(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function walk(root, out = []) {
  if (!exists(root)) return out;
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    if (stat.size <= 2_000_000 && TEXT_EXTS.has(path.extname(root).toLowerCase()) && !EXCLUDED_PATH_RE.test(root)) out.push(root);
    return out;
  }
  if (!stat.isDirectory()) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
    walk(path.join(root, entry.name), out);
  }
  return out;
}

function stripComments(text) {
  return String(text || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1 ");
}

function lower(text) {
  return String(text || "").toLowerCase();
}

function matchedTerms(text, terms) {
  const l = lower(text);
  return terms.filter((term) => l.includes(lower(term)));
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function findBlockEnd(text, openBrace) {
  let depth = 0;
  for (let i = openBrace; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

function extractFunctions(text) {
  const rows = [];
  const re = /function\s+([A-Za-z0-9_]+)\s*\([^;{]*\)[^{;]*\{/g;
  let match;
  while ((match = re.exec(text))) {
    const open = text.indexOf("{", match.index);
    if (open === -1) continue;
    const end = findBlockEnd(text, open);
    const raw = text.slice(match.index, end);
    rows.push({ name: match[1], line: lineNumberAt(text, match.index), header: text.slice(match.index, open + 1), body: stripComments(raw) });
    re.lastIndex = end;
  }
  return rows;
}

function snippet(text, line, radius = 2) {
  const lines = text.split(/\r?\n/);
  const start = Math.max(0, line - 1 - radius);
  const end = Math.min(lines.length, line + radius);
  return lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l.trim()}`).join(" ").slice(0, 500);
}

function accessKind(header) {
  if (/\bexternal\b/i.test(header)) return "external";
  if (/\bpublic\b/i.test(header)) return "public";
  if (/\binternal\b/i.test(header)) return "internal";
  if (/\bprivate\b/i.test(header)) return "private";
  return "unknown";
}

let dlnOrderLibCache;
function dlnOrderLibText() {
  if (dlnOrderLibCache === undefined) dlnOrderLibCache = safeRead(path.join(WORKSPACE, "targets", "dln-contracts", "contracts", "libraries", "DlnOrderLib.sol"));
  return dlnOrderLibCache;
}

function hasAll(text, terms) {
  const l = lower(text);
  return terms.every((term) => l.includes(lower(term)));
}

function knownFieldBindingProof(filePath, fileText, fn, combined) {
  const file = rel(filePath);
  if (file.endsWith("targets/cow-protocol-contracts/src/contracts/GPv2Settlement.sol") && ["freePreSignatureStorage", "freeFilledAmountStorage"].includes(fn.name)) {
    const onlyInteractionBound = /modifier\s+onlyInteraction\s*\([\s\S]*?address\(this\)\s*==\s*msg\.sender/i.test(fileText);
    const hasValueMove = matchedTerms(combined, TRANSFER_TERMS).length > 0;
    if (onlyInteractionBound && !hasValueMove) {
      return {
        status: "closed-no-value-transfer-only-interaction",
        proof: [
          "onlyInteraction requires address(this) == msg.sender",
          "function only frees expired order storage and has no token transfer path",
        ],
        blocker: "Closed as source false positive: storage cleanup is callable only through settlement self-interaction and does not settle or transfer maker funds.",
      };
    }
  }

  if (file.endsWith("targets/dln-contracts/contracts/DLN/DlnDestination.sol") && fn.name === "fulfillOrder") {
    const lib = dlnOrderLibText();
    const hashCheck = hasAll(fileText, ["DlnOrderLib.getOrderId(_order)", "if (orderId != _orderId) revert MismatchedOrderId()"]);
    const transferUsesOrderFields = hasAll(fileText, ["_order.takeTokenAddress.toAddress()", "_order.receiverDst.toAddress()", "_safeTransferFrom(", "takerAmount"]);
    const libBindsSettlementFields = hasAll(lib, ["_order.takeChainId", "_order.takeTokenAddress", "_order.takeAmount", "_order.receiverDst", "_order.allowedTakerDst", "keccak256(_order.externalCall)"]);
    if (hashCheck && transferUsesOrderFields && libBindsSettlementFields) {
      return {
        status: "closed-order-hash-binds-settlement-fields",
        proof: [
          "fulfillOrder recomputes DlnOrderLib.getOrderId(_order) and rejects mismatched _orderId",
          "DlnOrderLib.encodeOrder binds take token, take amount, receiver, allowed taker, chain id, and external call hash",
          "destination transfer uses the same _order takeTokenAddress, receiverDst/externalCallAdapter, and takerAmount",
        ],
        blocker: "Closed as source false positive: no signed-field/settlement-field drift is visible; taker funds are moved according to the hashed order fields.",
      };
    }
  }

  if (file.endsWith("targets/dln-contracts/contracts/DLN/DlnSource.sol") && fn.name === "patchOrderGive") {
    const lib = dlnOrderLibText();
    const authorityCheck = hasAll(combined, ["_order.givePatchAuthoritySrc.toAddress() != msg.sender", "revert Unauthorized()"]);
    const hashCheck = hasAll(combined, ["DlnOrderLib.getOrderIdWithExternalCallHash(_order)"]);
    const selfFundedTransfer = hasAll(combined, ["_order.giveTokenAddress.toAddress()", "_safeTransferFrom(", "msg.sender", "address(this)", "_addGiveAmount"]);
    const libBindsGiveFields = hasAll(lib, ["_order.giveTokenAddress", "_order.giveAmount", "_order.givePatchAuthoritySrc", "_order.externalCall"]);
    if (authorityCheck && hashCheck && selfFundedTransfer && libBindsGiveFields) {
      return {
        status: "closed-authority-and-self-funded-patch",
        proof: [
          "patchOrderGive recomputes the external-call-hash order id",
          "caller must equal order.givePatchAuthoritySrc",
          "transferFrom pulls _addGiveAmount of the order give token from msg.sender into the contract",
        ],
        blocker: "Closed as source false positive: patching can only add caller-funded collateral and does not create a forged settlement transfer from a victim.",
      };
    }
  }

  if (file.endsWith("targets/debridge-contracts/contracts/periphery/WrappedAsset.sol") && fn.name === "permit") {
    const domainBound = hasAll(fileText, ["chainId", "address(this)", "DOMAIN_SEPARATOR"]);
    const permitBound = hasAll(combined, ["PERMIT_TYPEHASH", "owner", "spender", "value", "nonces[owner]++", "deadline", "ecrecover", "recoveredAddress == owner", "_approve(owner, spender, value)"]);
    if (domainBound && permitBound) {
      return {
        status: "closed-standard-permit-binding",
        proof: [
          "EIP-712 domain binds chainId and verifying contract",
          "permit digest binds owner, spender, value, owner nonce, and deadline",
          "approval is written only after ecrecover matches owner",
        ],
        blocker: "Closed as source false positive: this is a standard permit approval path, not an RFQ/order settlement drift path.",
      };
    }
  }

  return null;
}

function sourceFeatureScope(files) {
  const sample = files.map(safeRead).join("\n").slice(0, 10_000_000);
  return {
    hasDomainTerms: matchedTerms(sample, DOMAIN_TERMS).length > 0,
    hasConsumptionTerms: matchedTerms(sample, CONSUMPTION_TERMS).length > 0,
    hasTransferTerms: matchedTerms(sample, TRANSFER_TERMS).length > 0,
    hasDriftTerms: matchedTerms(sample, DRIFT_TERMS).length > 0,
    fieldTerms: matchedTerms(sample, FIELD_TERMS).slice(0, 14),
  };
}

function analyzeFunction(target, filePath, fileText, fn, scope) {
  const combined = `${fn.header}\n${fn.body}`;
  const orderTerms = matchedTerms(combined, ORDER_TERMS);
  const signatureTerms = matchedTerms(combined, SIGNATURE_TERMS);
  const transferTerms = matchedTerms(combined, TRANSFER_TERMS);
  const settlementTerms = matchedTerms(combined, SETTLEMENT_TERMS);
  const driftTerms = matchedTerms(combined, DRIFT_TERMS);
  const consumptionTerms = matchedTerms(combined, CONSUMPTION_TERMS);
  const domainTerms = matchedTerms(combined, DOMAIN_TERMS);
  const fieldTerms = matchedTerms(combined, FIELD_TERMS);
  const writeSurface = /\b(external|public)\b/i.test(fn.header) && (settlementTerms.length > 0 || orderTerms.length >= 2);
  const hasSignature = signatureTerms.length > 0 || /signature|permit|signer|recover|hash/i.test(combined);
  const hasSettlement = transferTerms.length > 0 || settlementTerms.length > 0;
  const hasDomain = domainTerms.length > 0 || scope.hasDomainTerms;
  const hasConsumption = consumptionTerms.length > 0 || scope.hasConsumptionTerms;
  const receiverBound = fieldTerms.some((term) => /receiver|recipient|taker|allowedSender/i.test(term));
  const tokenBound = fieldTerms.some((term) => /sellToken|buyToken|srcToken|dstToken|token/i.test(term));
  const resolverSurface = fieldTerms.some((term) => /resolver/i.test(term)) || /resolver|interaction|callback|target|executor/i.test(combined);
  const missing = [];
  if (!hasDomain) missing.push("domain/verifying-contract");
  if (!hasConsumption) missing.push("fill/cancel/nonce-consumption");
  if (!receiverBound) missing.push("receiver/allowed-sender-binding");
  if (!tokenBound) missing.push("token-binding");
  if (resolverSurface && !/resolver|interaction|callback/.test(fieldTerms.join("|"))) missing.push("resolver-binding");

  const bindingProof = knownFieldBindingProof(filePath, fileText, fn, combined);
  let confidence = "context";
  if (writeSurface && hasSignature && hasSettlement && driftTerms.length > 0 && missing.length >= 2) confidence = "high-static";
  else if (writeSurface && hasSignature && hasSettlement && missing.length >= 2) confidence = "medium-static";
  else if (writeSurface && (hasSignature || hasSettlement)) confidence = "review";
  else if (orderTerms.length >= 2 && (signatureTerms.length || transferTerms.length)) confidence = "context";
  if (bindingProof) confidence = "closed-field-bound";

  const openFieldDiff = ["high-static", "medium-static"].includes(confidence);

  const priorityScore = Math.round(
    target.priority * 6
    + (confidence === "high-static" ? 44 : confidence === "medium-static" ? 28 : confidence === "review" ? 16 : 5)
    + (writeSurface ? 8 : 0)
    + Math.min(8, driftTerms.length * 2)
    + (resolverSurface ? 5 : 0)
    - (hasDomain ? 5 : 0)
    - (hasConsumption ? 5 : 0)
    - (bindingProof ? 25 : 0)
  );
  const blocker = bindingProof
    ? bindingProof.blocker
    : confidence === "high-static"
    ? "Static source row has signature/order settlement plus calldata drift terms, but no deployed-path balance-delta proof or exact extraction economics."
    : confidence === "medium-static"
      ? "Static source row needs manual hash-vs-transfer field comparison before fork work."
      : "Context row is not enough for route-positive classification.";

  return {
    target: target.name,
    chain: target.chain,
    file: rel(filePath),
    line: fn.line,
    function: fn.name,
    access: accessKind(fn.header),
    writeSurface,
    confidence,
    priorityScore,
    orderTerms: orderTerms.slice(0, 8),
    signatureTerms: signatureTerms.slice(0, 8),
    transferTerms: transferTerms.slice(0, 8),
    settlementTerms: settlementTerms.slice(0, 8),
    driftTerms: driftTerms.slice(0, 8),
    fieldTerms: fieldTerms.slice(0, 14),
    missingBindings: missing,
    resolverSurface,
    hasDomain,
    hasConsumption,
    fieldBindingStatus: bindingProof?.status || (openFieldDiff ? "open-needs-manual-field-comparison" : "not-proven-relevant"),
    fieldBindingProof: bindingProof?.proof || [],
    openFieldDiff,
    routePositive: false,
    signedActionJustified: false,
    blocker,
    snippet: snippet(fileText, fn.line, 2),
  };
}

function scanSourceTarget(target) {
  const files = [];
  const existingDirs = [];
  for (const dir of target.dirs) {
    const abs = path.join(WORKSPACE, dir);
    if (exists(abs)) existingDirs.push(dir);
    walk(abs, files);
  }
  const scope = sourceFeatureScope(files);
  const rows = [];
  for (const filePath of files) {
    const text = safeRead(filePath);
    if (!text) continue;
    for (const fn of extractFunctions(text)) {
      const combined = `${fn.header}\n${fn.body}`;
      if (matchedTerms(combined, ORDER_TERMS).length < 1 && matchedTerms(combined, SETTLEMENT_TERMS).length < 1) continue;
      const row = analyzeFunction(target, filePath, text, fn, scope);
      if (row.confidence !== "context" || row.priorityScore >= target.priority * 6 + 8) rows.push(row);
    }
  }
  rows.sort((a, b) => b.priorityScore - a.priorityScore || a.file.localeCompare(b.file));
  return {
    name: target.name,
    chain: target.chain,
    dirs: target.dirs,
    existingDirs,
    filesScanned: files.length,
    sourceRows: rows.length,
    highStaticRows: rows.filter((row) => row.confidence === "high-static").length,
    mediumStaticRows: rows.filter((row) => row.confidence === "medium-static").length,
    fieldBindingProofRows: rows.filter((row) => row.fieldBindingProof?.length).length,
    openFieldDiffRows: rows.filter((row) => row.openFieldDiff).length,
    topRows: rows.slice(0, 20),
  };
}

function countOpcode(code, opcode) {
  const l = lower(code).replace(/^0x/, "");
  let count = 0;
  for (let idx = l.indexOf(opcode); idx !== -1; idx = l.indexOf(opcode, idx + opcode.length)) count++;
  return count;
}

async function scanDeployedTarget(target, rpcCache, routerApprovalArtifact) {
  if (!rpcCache[target.chainId]) rpcCache[target.chainId] = await resolveRpc(target.chainId);
  const rpc = rpcCache[target.chainId];
  const base = {
    name: target.name,
    protocol: target.protocol,
    chain: target.chain,
    chainId: target.chainId,
    address: target.address,
    deprecated: Boolean(target.deprecated),
    deployed: false,
    codeBytes: 0,
    selectorHits: [],
    delegatecallCount: 0,
    callCount: 0,
    confidence: "no-code-or-no-rpc",
    priorityScore: target.priority * 4,
    routePositive: false,
    signedActionJustified: false,
    blocker: "No deployed bytecode or no RPC available for read-only bytecode scan.",
  };
  if (!rpc) return base;
  const code = await rpcCall(rpc, "eth_getCode", [target.address, "latest"], 8000);
  if (!code || code === "0x") return base;
  const l = lower(code);
  const selectorHits = BYTECODE_SELECTORS.filter((probe) => l.includes(probe.selector));
  const delegatecallCount = countOpcode(code, "f4");
  const callCount = countOpcode(code, "f1");
  const oldArtifactRow = (routerApprovalArtifact?.results || []).find((row) => lower(row.addr) === lower(target.address) && Number(row.chain) === target.chainId);
  const hasValueMove = selectorHits.some((hit) => hit.kind === "value-move");
  const hasApproval = selectorHits.some((hit) => hit.kind === "approval");
  const hasBatching = selectorHits.some((hit) => hit.kind === "batching" || hit.kind === "execution");
  const isWatch = hasValueMove || hasApproval || hasBatching || delegatecallCount > 0 || target.deprecated || oldArtifactRow?.risk?.startsWith("LOW-MED");
  const priorityScore = Math.round(
    target.priority * 5
    + (isWatch ? 18 : 3)
    + (hasValueMove ? 8 : 0)
    + (hasApproval ? 6 : 0)
    + (hasBatching ? 6 : 0)
    + (delegatecallCount > 0 ? 5 : 0)
    + (target.deprecated ? 8 : 0)
  );
  return {
    ...base,
    deployed: true,
    codeBytes: (code.length - 2) / 2,
    selectorHits: selectorHits.map((hit) => hit.name),
    selectorKinds: [...new Set(selectorHits.map((hit) => hit.kind))],
    delegatecallCount,
    callCount,
    oldApprovalDrainRisk: oldArtifactRow?.risk || null,
    confidence: isWatch ? "deployed-bytecode-watch" : "deployed-low-signal",
    priorityScore,
    blocker: isWatch
      ? "Deployed router has settlement/approval/batching/delegatecall reachability, but bytecode selector presence does not prove forged order or extraction economics."
      : "Deployed code has no watched selector/opcode combination in this lightweight bytecode pass.",
  };
}

function table(rows, headers) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${headers.map((h) => String(row[h] ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "/")).join(" | ")} |`),
  ].join("\n");
}

function renderReport(artifact) {
  const sourceTop = artifact.rankedRows.filter((row) => row.kind === "source").slice(0, 8).map((row) => ({
    Target: row.target,
    Function: `${row.function}`,
    File: `${row.file}:${row.line}`,
    Confidence: row.confidence,
    Missing: (row.missingBindings || []).join(", "),
    Blocker: row.blocker,
  }));
  const proofTop = artifact.rankedRows.filter((row) => row.kind === "source" && row.fieldBindingProof?.length).slice(0, 8).map((row) => ({
    Target: row.target,
    Function: `${row.function}`,
    File: `${row.file}:${row.line}`,
    Status: row.fieldBindingStatus,
    Proof: row.fieldBindingProof.join("; "),
  }));
  const deployedTop = artifact.rankedRows.filter((row) => row.kind === "deployed").slice(0, 10).map((row) => ({
    Target: row.name,
    Chain: row.chain,
    Address: row.address,
    Confidence: row.confidence,
    Selectors: (row.selectorKinds || []).join(", "),
    Deprecated: row.deprecated ? "yes" : "no",
    Blocker: row.blocker,
  }));
  return [
    "# 🟢 DORMANT — Router/RFQ Settlement Drift Scan",
    "",
    `Date: ${artifact.generatedAt.slice(0, 10)}`,
    "",
    "## Result",
    "",
    `Scanned ${artifact.summary.deployedTargetsScanned} deployed router targets and ${artifact.summary.sourceFilesScanned} local source files for deprecated settlement reachability, RFQ/order field-binding gaps, resolver substitution, calldata slicing drift, and approval/escrow drain preconditions. Deployed selector inventory is research-only unless it maps to verified-source field drift and live balance-delta economics. Route gate remains closed: \`routePositive=0\`, \`executableNow=0\`, \`signedActionJustified=false\`.`,
    "",
    artifact.summary.sourceFilesScanned === 0
      ? "No local 1inch/0x/CoW/Socket/LI.FI source checkout is currently present under `targets/`, so this first pass is mostly deployed-bytecode reachability plus existing artifact correlation. Clone or add source checkouts before promoting any row."
      : `The source pass found ${artifact.summary.highStaticRows} unresolved high-static rows, ${artifact.summary.mediumStaticRows} medium-static rows, ${artifact.summary.fieldBindingProofRows} field-binding proof rows, and ${artifact.summary.openFieldDiffRows} open field-diff rows. Route-relevant gates are \`verifiedFieldDiffRows=${artifact.summary.verifiedFieldDiffRows}\`, \`liveApprovalOrEscrowRows=${artifact.summary.liveApprovalOrEscrowRows}\`, \`balanceDeltaMismatchRows=${artifact.summary.balanceDeltaMismatchRows}\`, \`exactEconomicsRows=${artifact.summary.exactEconomicsRows}\`, and \`forkProofRows=${artifact.summary.forkProofRows}\`.`,
    "",
    "## Deployed Inventory Rows",
    "",
    deployedTop.length ? table(deployedTop, ["Target", "Chain", "Address", "Confidence", "Selectors", "Deprecated", "Blocker"]) : "No deployed inventory rows.",
    "",
    "## Source Rows",
    "",
    sourceTop.length ? table(sourceTop, ["Target", "Function", "File", "Confidence", "Missing", "Blocker"]) : "No local source rows were available or relevant in this pass.",
    "",
    "## Field-Binding Proof Rows",
    "",
    proofTop.length ? table(proofTop, ["Target", "Function", "File", "Status", "Proof"]) : "No source rows had exact field-binding closure proof in this pass.",
    "",
    "## Route-Positive Gate",
    "",
    "Do not fork or build executors until a row proves: verified-source signed order fields differ from settlement transfer fields, the path is deployed and permissionlessly callable, live approvals/escrow/balances are reachable, exact balance-delta economics are positive after gas, and fork proof demonstrates extraction.",
    "",
    "## Artifacts",
    "",
    "- JSON: `reports/raw/fast/router-rfq-settlement-drift.json`",
    "- Scanner: `tools/scan-router-rfq-settlement-drift.js`",
    "- Related artifact: `reports/raw/fast/router-approval-drain.json`",
    "",
  ].join("\n");
}

async function main() {
  const routerApprovalArtifact = readJson(path.join(WORKSPACE, "reports", "raw", "fast", "router-approval-drain.json"), {});
  const sourceRows = SOURCE_TARGETS.map(scanSourceTarget);
  const rpcCache = {};
  const deployedRows = [];
  for (const target of DEPLOYED_TARGETS) deployedRows.push(await scanDeployedTarget(target, rpcCache, routerApprovalArtifact));

  const rankedRows = [
    ...sourceRows.flatMap((target) => target.topRows.map((row) => ({ kind: "source", ...row }))),
    ...deployedRows.map((row) => ({ kind: "deployed", ...row })),
  ].sort((a, b) => (b.priorityScore || 0) - (a.priorityScore || 0));

  const sourceFilesScanned = sourceRows.reduce((acc, row) => acc + row.filesScanned, 0);
  const highStaticRows = sourceRows.reduce((acc, row) => acc + row.highStaticRows, 0);
  const mediumStaticRows = sourceRows.reduce((acc, row) => acc + row.mediumStaticRows, 0);
  const fieldBindingProofRows = sourceRows.reduce((acc, row) => acc + row.fieldBindingProofRows, 0);
  const openFieldDiffRows = sourceRows.reduce((acc, row) => acc + row.openFieldDiffRows, 0);
  const deployedRouterInventoryRows = deployedRows.filter((row) => row.deployed).length;
  const deployedWatchRows = deployedRows.filter((row) => row.confidence === "deployed-bytecode-watch").length;
  const deprecatedReachabilityRows = deployedRows.filter((row) => row.deprecated && row.deployed).length;
  const verifiedFieldDiffRows = 0;
  const liveApprovalOrEscrowRows = 0;
  const balanceDeltaMismatchRows = 0;
  const exactEconomicsRows = 0;
  const forkProofRows = 0;

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-router-rfq-settlement-drift.js",
    scope: "Read-only router/RFQ/deprecated settlement drift scan",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      signedActionJustified: false,
    },
    summary: {
      sourceTargetsScanned: sourceRows.length,
      sourceFilesScanned,
      sourceRows: sourceRows.reduce((acc, row) => acc + row.sourceRows, 0),
      highStaticRows,
      mediumStaticRows,
      fieldBindingProofRows,
      openFieldDiffRows,
      deployedTargetsScanned: deployedRows.length,
      deployedRows: deployedRouterInventoryRows,
      deployedRouterInventoryRows,
      deployedWatchRows,
      deprecatedReachabilityRows,
      verifiedFieldDiffRows,
      liveApprovalOrEscrowRows,
      balanceDeltaMismatchRows,
      exactEconomicsRows,
      forkProofRows,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
      blocker: openFieldDiffRows > 0
        ? "Unresolved source rows still need exact signed-field-vs-settlement comparison plus deployed balance-delta economics."
        : "Deployed selector and bytecode rows are research-only; no row currently proves verified-source field diff, live approval/escrow reachability, balance-delta mismatch, exact economics, or fork proof.",
    },
    sourceTargets: sourceRows,
    deployedRows,
    rankedRows: rankedRows.slice(0, 100),
    requiredForRoutePositive: [
      "deployed router/RFQ/deprecated settlement path is permissionlessly callable",
      "verified-source field diff proves maker-signed fields differ from settlement transfer/callback fields",
      "live approvals, escrow, or protocol balances are reachable by the path",
      "exact balance-delta mismatch and simulation are positive after gas and fees",
      "fork proof demonstrates value extraction",
    ],
    nextReadOnlyStep: sourceFilesScanned === 0
      ? "Add or clone 1inch/0x/CoW/Socket/LI.FI source checkouts, then rerun this scanner for exact hash-vs-transfer field comparison."
      : openFieldDiffRows > 0
        ? "Manually inspect unresolved open field-diff rows for signed-field vs settlement-field mismatch; fork only after a deployed-path balance-delta route is positive."
        : "Treat deployed bytecode watch rows as inventory only; reopen only if verified source proves field drift and live approvals/escrow plus exact positive balance-delta economics are present.",
  };

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(artifact, null, 2)}\n`);
  fs.writeFileSync(OUT_MD, `${renderReport(artifact)}\n`);

  if (!QUIET) {
    console.log(`router-rfq-settlement-drift: inventory=${deployedRouterInventoryRows}/${artifact.summary.deployedTargetsScanned}; deployedWatch=${deployedWatchRows}; verifiedFieldDiff=${verifiedFieldDiffRows}; balanceDeltaMismatch=${balanceDeltaMismatchRows}; sourceFiles=${sourceFilesScanned}; highStatic=${highStaticRows}; routePositive=0`);
    console.log(`Report: ${rel(OUT_MD)}`);
  }
}

main().catch((err) => {
  console.error(`scan-router-rfq-settlement-drift failed: ${err?.message || String(err)}`);
  process.exit(1);
});
