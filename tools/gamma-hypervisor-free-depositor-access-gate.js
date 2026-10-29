#!/usr/bin/env node
"use strict";

// Bounded finalized read-only access gate. Inventory URLs and credentials are
// process-only and rejected from persisted artifacts.
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
const { Interface, getAddress, id, keccak256 } = require("./node_modules/ethers");

const ROOT = path.resolve(__dirname, "..");
const INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const OUT = path.join(ROOT, "reports", "raw", "fast", "gamma-hypervisor-free-depositor-access-gate");
const CAPTURE = path.join(OUT, "capture.json"), CHECKPOINT = path.join(OUT, "checkpoint.json"), MANIFEST = path.join(OUT, "manifest.json");
const PRIOR_DIR = path.join(ROOT, "reports", "raw", "fast", "gamma-hypervisor-deployment-activity-gate");
const PRIOR_CHECKPOINT = path.join(PRIOR_DIR, "checkpoint.json"), PRIOR_MANIFEST = path.join(PRIOR_DIR, "manifest.json");
const DEPLOYED_SOURCES = path.join(ROOT, "targets", "gamma-hypervisor-deployed-d5f487", "sources", "contracts");
const ADDRESS = "0x57622d4c4be22ab9ad3da104dc281d738e6f5b6a";
const HYPE = "0xd5f4877263b736625ba363385983c2d02b41f35b", UNIPROXY = "0x911bfbaca43f117e52197ae62d439d6a645c8886";
const CLEARANCE = "0x09a8ebb5bf22b1da81835164d6653fa1d57dbbee", TOKEN0 = "0x6dea81c8171d0ba574754ef6f8b412f2ed88c54d", TOKEN1 = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const CHAIN = 1n, ZERO = `0x${"0".repeat(40)}`, ZERO32 = `0x${"0".repeat(64)}`;
const IMPLEMENTATION_SLOT = `0x${(BigInt(id("eip1967.proxy.implementation")) - 1n).toString(16).padStart(64, "0")}`;
const ADMIN_SLOT = `0x${(BigInt(id("eip1967.proxy.admin")) - 1n).toString(16).padStart(64, "0")}`;
const BEACON_SLOT = `0x${(BigInt(id("eip1967.proxy.beacon")) - 1n).toString(16).padStart(64, "0")}`;
const METHODS = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getStorageAt", "eth_getBalance", "eth_getTransactionCount", "eth_call", "eth_getLogs", "eth_getTransactionByHash", "eth_getTransactionReceipt"]);
const LIMITS = Object.freeze({ inventoryBytes: 1024 * 1024, candidates: 64, families: 24, calls: 500, responseBytes: 8 * 1024 * 1024, totalResponseBytes: 64 * 1024 * 1024, requestMs: 15000, wallMs: 8 * 60 * 1000 });
const hypeIface = new Interface(["event Deposit(address indexed sender,address indexed to,uint256 shares,uint256 amount0,uint256 amount1)", "event Transfer(address indexed from,address indexed to,uint256 value)",
  "function balanceOf(address) view returns(uint256)", "function totalSupply() view returns(uint256)", "function allowance(address,address) view returns(uint256)", "function withdraw(uint256,address,address,uint256[4]) returns(uint256,uint256)"]);
const uniIface = new Interface(["function deposit(uint256,uint256,address,address,uint256[4]) returns(uint256)", "function clearance() view returns(address)"]);
const clearIface = new Interface(["function freeDepositList(address,address) view returns(bool)"]);
const erc20 = new Interface(["function balanceOf(address) view returns(uint256)"]);
const generic = new Interface(["function owner() view returns(address)", "function admin() view returns(address)", "function manager() view returns(address)", "function governance() view returns(address)", "function asset() view returns(address)",
  "function underlying() view returns(address)", "function token() view returns(address)", "function vault() view returns(address)", "function hypervisor() view returns(address)", "function uniProxy() view returns(address)", "function clearance() view returns(address)",
  "function strategy() view returns(address)", "function want() view returns(address)", "function name() view returns(string)", "function symbol() view returns(string)", "function decimals() view returns(uint8)", "function totalSupply() view returns(uint256)",
  "function totalAssets() view returns(uint256)", "function pricePerShare() view returns(uint256)", "function getPricePerFullShare() view returns(uint256)", "function paused() view returns(bool)",
  "function maxDeposit(address) view returns(uint256)", "function maxMint(address) view returns(uint256)", "function maxWithdraw(address) view returns(uint256)", "function maxRedeem(address) view returns(uint256)"]);

function sha(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function addr(value) { try { return getAddress(value).toLowerCase(); } catch (_) { return null; } }
function qty(value) { return `0x${BigInt(value).toString(16)}`; }
function pinArg(pin) { return { blockHash: pin.hash, requireCanonical: true }; }
function serial(value) { if (typeof value === "bigint") return value.toString(); if (typeof value === "string") return /^0x[0-9a-fA-F]{40}$/u.test(value) ? value.toLowerCase() : value;
  if (Array.isArray(value)) return value.map(serial); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([k]) => !/^\d+$/u.test(k)).map(([k, v]) => [k, serial(v)])); return value; }
function bytes(hex) { return typeof hex === "string" && /^0x(?:[0-9a-fA-F]{2})*$/u.test(hex) ? Buffer.from(hex.slice(2), "hex") : null; }
function codeSummary(code) { const raw = bytes(code); return raw ? { present: raw.length > 0, bytes: raw.length, keccak256: raw.length ? keccak256(code) : null, sha256: raw.length ? sha(raw) : null } : null; }
function header(block) { return block?.hash ? { number: BigInt(block.number).toString(), hash: block.hash.toLowerCase(), timestamp: BigInt(block.timestamp).toString() } : null; }
function value(row) { return row?.reason === null ? row.value : null; }
function parseInventory(text) { if (Buffer.byteLength(text) > LIMITS.inventoryBytes) throw new Error("inventory cap"); const rows = [], seen = new Set(), lines = text.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i++) for (const m of lines[i].matchAll(/https:\/\/[^\s<'"`\])}]+/giu)) { let url; try { url = new URL(m[0].replace(/[>,.;]+$/u, "")); } catch (_) { continue; }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) continue; const headers = {}; for (const h of lines[i].matchAll(/\[header:\s*([^=\]\s]+)=([^\]]+)\]/giu)) headers[h[1].trim()] = h[2].trim();
    const key = `${url.href}\0${JSON.stringify(headers)}`; if (seen.has(key)) continue; seen.add(key); const context = lines.slice(Math.max(0, i - 3), i + 4).join(" "); rows.push({ url, headers, family: url.hostname.toLowerCase(), hint: /(?:ethereum|eth-mainnet|chain(?:id)?[^a-z0-9]{0,8}(?:1|0x1))(?!\d)/iu.test(context) }); }
  return rows.sort((a, b) => Number(b.hint) - Number(a.hint)).slice(0, LIMITS.candidates).map(({ url, headers, family }) => ({ url, headers, family })); }
function secretCorpus(rows) { const set = new Set(); for (const row of rows) for (const x of [row.url.href, ...row.url.pathname.split("/"), ...row.url.searchParams.values(), ...Object.values(row.headers)]) if (String(x).length >= 16) { set.add(String(x)); set.add(String(x).toLowerCase()); } return [...set]; }
function guard(object, secrets) { const text = JSON.stringify(object), low = text.toLowerCase(); if (/(?:https?|wss?):\/\//iu.test(text) || /"(?:endpoint|provider|hostname|domain|headers)"\s*:/iu.test(text)) throw new Error("secret guard");
  for (const s of secrets) if (text.includes(s) || low.includes(s.toLowerCase())) throw new Error("inventory leak"); }
class Budget { constructor() { this.start = Date.now(); this.calls = 0; this.responseBytes = 0; } use() { if (++this.calls > LIMITS.calls || Date.now() - this.start > LIMITS.wallMs) throw new Error("RPC budget"); }
  add(n) { this.responseBytes += n; if (n > LIMITS.responseBytes || this.responseBytes > LIMITS.totalResponseBytes) throw new Error("response cap"); } summary() { return { calls: this.calls, responseBytes: this.responseBytes, elapsedMs: Date.now() - this.start, withinLimits: true, limits: { calls: LIMITS.calls, wallMs: LIMITS.wallMs, responseBytes: LIMITS.totalResponseBytes } }; } }
async function rpc(ep, method, params, budget) { if (!METHODS.has(method)) throw new Error("method blocked"); budget.use(); const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: budget.calls, method, params }));
  return new Promise((resolve) => { let done = false, req; const finish = (x) => { if (done) return; done = true; clearTimeout(timer); try { req?.destroy(); } catch (_) {} resolve(x); }, timer = setTimeout(() => finish({ ok: false, reason: "TIMEOUT" }), LIMITS.requestMs);
    const options = { protocol: "https:", hostname: ep.url.hostname, port: ep.url.port || 443, path: `${ep.url.pathname}${ep.url.search}`, method: "POST", agent: false,
      headers: { ...ep.headers, "content-type": "application/json", accept: "application/json", "accept-encoding": "identity", "content-length": body.length } };
    try { req = https.request(options, (res) => { const chunks = []; let size = 0; res.on("data", (c) => { size += c.length; if (size > LIMITS.responseBytes) finish({ ok: false, reason: "RESPONSE_CAP" }); else chunks.push(Buffer.from(c)); }); res.on("end", () => {
      if (done) return; try { budget.add(size); } catch (e) { return finish({ ok: false, reason: e.message }); } if (res.statusCode !== 200) return finish({ ok: false, reason: "HTTP_STATUS" }); try { const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); finish(parsed.error ? { ok: false, reason: "RPC_ERROR" } : { ok: true, result: parsed.result }); } catch (_) { finish({ ok: false, reason: "INVALID_JSON" }); } }); }); req.on("error", () => finish({ ok: false, reason: "TRANSPORT" })); req.end(body); }
    catch (_) { finish({ ok: false, reason: "TRANSPORT" }); } }); }
async function call(ep, block, to, iface, fragment, args, budget) { let data; try { data = iface.encodeFunctionData(fragment, args || []); } catch (_) { return { value: null, reason: "ENCODE" }; } const row = await rpc(ep, "eth_call", [{ to, data }, block], budget); if (!row.ok) return { value: null, reason: row.reason };
  try { const decoded = iface.decodeFunctionResult(fragment, row.result); return { value: serial(decoded.length === 1 ? decoded[0] : [...decoded]), reason: null }; } catch (_) { return { value: null, reason: row.result === "0x" ? "NO_RETURN_DATA" : "DECODE" }; } }
async function qualify(candidates, budget) { const seen = new Set(); let tested = 0; for (const ep of candidates) { if (seen.has(ep.family) || tested >= LIMITS.families) continue; seen.add(ep.family); tested++; const chain = await rpc(ep, "eth_chainId", [], budget); if (!chain.ok || BigInt(chain.result) !== CHAIN) continue;
    const head = await rpc(ep, "eth_getBlockByNumber", ["finalized", false], budget), pin = head.ok ? header(head.result) : null; if (!pin) continue; const code = await rpc(ep, "eth_getCode", [ADDRESS, pinArg(pin)], budget), balance = await rpc(ep, "eth_getBalance", [ADDRESS, pinArg(pin)], budget), nonce = await rpc(ep, "eth_getTransactionCount", [ADDRESS, pinArg(pin)], budget), shares = await call(ep, pinArg(pin), HYPE, hypeIface, "balanceOf", [ADDRESS], budget);
    if (code.ok && balance.ok && nonce.ok && shares.reason === null) return { ep, pin, tested }; } return { ep: null, pin: null, tested }; }
function decodeEvent(row) { try { const parsed = hypeIface.parseLog({ topics: row.topics, data: row.data }); return { blockNumber: BigInt(row.blockNumber).toString(), transactionHash: row.transactionHash.toLowerCase(), logIndex: BigInt(row.logIndex).toString(), event: parsed.name,
    args: Object.fromEntries(parsed.fragment.inputs.map((x, i) => [x.name, serial(parsed.args[i])])) }; } catch (_) { return null; } }
function priorHistory() { const manifest = JSON.parse(fs.readFileSync(PRIOR_MANIFEST)), cpBytes = fs.readFileSync(PRIOR_CHECKPOINT), row = manifest.files.find((x) => x.name === "checkpoint.json");
  if (!row || row.bytes !== cpBytes.length || row.sha256 !== sha(cpBytes)) throw new Error("prior checkpoint integrity"); const cp = JSON.parse(cpBytes); if (!cp.complete) throw new Error("prior history incomplete"); return { cp, sha256: row.sha256 }; }
function txSummary(tx) { return tx ? { hash: tx.hash?.toLowerCase(), blockNumber: tx.blockNumber ? BigInt(tx.blockNumber).toString() : null, from: addr(tx.from), to: addr(tx.to), nonce: tx.nonce ? BigInt(tx.nonce).toString() : "0",
  value: tx.value ? BigInt(tx.value).toString() : "0", inputSelector: tx.input?.slice(0, 10).toLowerCase(), inputBytes: tx.input ? (tx.input.length - 2) / 2 : 0 } : null; }
function receiptSummary(receipt) { return receipt ? { status: receipt.status ? BigInt(receipt.status).toString() : null, blockNumber: BigInt(receipt.blockNumber).toString(), from: addr(receipt.from), to: addr(receipt.to), contractAddress: addr(receipt.contractAddress), logCount: receipt.logs?.length || 0 } : null; }
async function sourcifyStatus() { const checksum = getAddress(ADDRESS); return new Promise((resolve) => { const req = https.get(`https://sourcify.dev/server/v2/contract/1/${checksum}?fields=all`, { headers: { accept: "application/json", "accept-encoding": "identity" }, agent: false }, (res) => {
    let size = 0; res.on("data", (c) => { size += c.length; }); res.on("end", () => resolve({ attempted: true, available: res.statusCode === 200, status: res.statusCode, responseBytes: size })); }); req.on("error", () => resolve({ attempted: true, available: false, status: "TRANSPORT" })); }); }

async function main() {
  const inventory = fs.readFileSync(INVENTORY, "utf8"), candidates = parseInventory(inventory), secrets = secretCorpus(candidates), budget = new Budget(), q = await qualify(candidates, budget); if (!q.ep) throw new Error("no qualified chain-1 family");
  const { ep, pin } = q, block = pinArg(pin), codeRow = await rpc(ep, "eth_getCode", [ADDRESS, block], budget), code = codeSummary(codeRow.result), balanceRow = await rpc(ep, "eth_getBalance", [ADDRESS, block], budget), nonceRow = await rpc(ep, "eth_getTransactionCount", [ADDRESS, block], budget);
  const slots = {}; for (const [name, slot] of Object.entries({ implementation: IMPLEMENTATION_SLOT, admin: ADMIN_SLOT, beacon: BEACON_SLOT })) { const row = await rpc(ep, "eth_getStorageAt", [ADDRESS, slot, block], budget); slots[name] = { raw: row.ok ? row.result : null, zero: row.ok ? row.result === ZERO32 : null, reason: row.ok ? null : row.reason }; }
  const prior = priorHistory(), startTail = BigInt(prior.cp.pin.number) + 1n, tail = [];
  if (startTail <= BigInt(pin.number)) { const logs = await rpc(ep, "eth_getLogs", [{ address: HYPE, fromBlock: qty(startTail), toBlock: qty(BigInt(pin.number)), topics: [[hypeIface.getEvent("Deposit").topicHash, hypeIface.getEvent("Transfer").topicHash]] }], budget); if (!logs.ok) throw new Error("tail logs unavailable"); for (const log of logs.result || []) { const decoded = decodeEvent(log); if (decoded) tail.push(decoded); } }
  const priorRows = prior.cp.events.filter((row) => ["Deposit", "Transfer"].includes(row.event)), allRows = [...priorRows, ...tail], relevant = allRows.filter((row) => Object.values(row.args || {}).some((x) => typeof x === "string" && addr(x) === ADDRESS));
  const transactions = []; for (const hash of [...new Set(relevant.map((x) => x.transactionHash))]) { const tx = await rpc(ep, "eth_getTransactionByHash", [hash], budget), receipt = await rpc(ep, "eth_getTransactionReceipt", [hash], budget); const summary = tx.ok ? txSummary(tx.result) : null; let decodedInput = null;
    if (summary?.to === UNIPROXY) try { const parsed = uniIface.parseTransaction({ data: tx.result.input, value: tx.result.value }); decodedInput = { function: parsed.name, args: serial(parsed.args) }; } catch (_) {}
    const historicalCode = summary?.blockNumber ? await rpc(ep, "eth_getCode", [ADDRESS, qty(BigInt(summary.blockNumber))], budget) : null;
    transactions.push({ transaction: summary, receipt: receipt.ok ? receiptSummary(receipt.result) : null, decodedInput, addressCodeAtBlock: historicalCode?.ok ? codeSummary(historicalCode.result) : null,
      relatedEvents: relevant.filter((x) => x.transactionHash === hash) }); }
  const shareState = { balance: await call(ep, block, HYPE, hypeIface, "balanceOf", [ADDRESS], budget), totalSupply: await call(ep, block, HYPE, hypeIface, "totalSupply", [], budget),
    allowanceUniProxy: await call(ep, block, HYPE, hypeIface, "allowance", [ADDRESS, UNIPROXY], budget), allowanceClearance: await call(ep, block, HYPE, hypeIface, "allowance", [ADDRESS, CLEARANCE], budget) };
  const tokenState = { token0Balance: await call(ep, block, TOKEN0, erc20, "balanceOf", [ADDRESS], budget), token1Balance: await call(ep, block, TOKEN1, erc20, "balanceOf", [ADDRESS], budget) };
  const freeListed = await call(ep, block, CLEARANCE, clearIface, "freeDepositList", [HYPE, ADDRESS], budget), uniClearance = await call(ep, block, UNIPROXY, uniIface, "clearance", [], budget);
  const getterSpecs = [["owner", []], ["admin", []], ["manager", []], ["governance", []], ["asset", []], ["underlying", []], ["token", []], ["vault", []], ["hypervisor", []], ["uniProxy", []], ["clearance", []], ["strategy", []], ["want", []],
    ["name", []], ["symbol", []], ["decimals", []], ["totalSupply", []], ["totalAssets", []], ["pricePerShare", []], ["getPricePerFullShare", []], ["paused", []], ["maxDeposit", [ADDRESS]], ["maxMint", [ADDRESS]], ["maxWithdraw", [ADDRESS]], ["maxRedeem", [ADDRESS]]];
  const getters = {}; for (const [name, args] of getterSpecs) getters[name] = await call(ep, block, ADDRESS, generic, name, args, budget);
  const sourcify = code.present ? await sourcifyStatus() : { attempted: false, available: false, reason: "NO_RUNTIME_SOURCE_NOT_APPLICABLE" };
  const historicalDeposits = relevant.filter((x) => x.event === "Deposit"), initiated = transactions.filter((x) => x.transaction?.from === ADDRESS && x.transaction?.to === UNIPROXY && x.decodedInput?.function === "deposit");
  const received = transactions.filter((x) => x.transaction?.from !== ADDRESS && x.relatedEvents.some((e) => e.event === "Deposit" && addr(e.args?.to) === ADDRESS));
  const currentShares = BigInt(value(shareState.balance)), supply = BigInt(value(shareState.totalSupply)), holderBps = currentShares * 10000n / supply;
  const noRuntime = code.present === false, arbitraryCanCause = noRuntime ? false : null;
  const capture = { schema: "gamma-hypervisor-free-depositor-access-gate/v1", capturedAt: new Date().toISOString(), chainId: "1", pin,
    rpcPolicy: { inventory: "rpc_endpoints.txt", processOnly: true, candidateFamiliesTested: q.tested, selectedFamilies: 1,
      secondFamilyTrigger: "only-if-public-access-positive", secondIndependentFamilyUsed: false, permittedMethods: [...METHODS] },
    addresses: { freeListed: ADDRESS, hypervisor: HYPE, uniProxy: UNIPROXY, clearance: CLEARANCE, token0: TOKEN0, token1: TOKEN1 },
    identity: { code, accountType: noRuntime ? "EOA_OR_NO_CURRENT_RUNTIME" : "CONTRACT", nativeBalance: balanceRow.ok ? BigInt(balanceRow.result).toString() : null,
      transactionCount: nonceRow.ok ? BigInt(nonceRow.result).toString() : null, proxySlots: slots, implementation: null, beaconImplementation: null,
      publicSelectors: noRuntime ? [] : null, sourcify },
    current: { freeListed, uniProxyClearance: uniClearance, shares: shareState, holderBpsFloor: holderBps.toString(), tokens: tokenState, attemptedContractGetters: getters },
    history: { priorCompleteCheckpoint: { path: "reports/raw/fast/gamma-hypervisor-deployment-activity-gate/checkpoint.json", sha256: prior.sha256, throughBlock: prior.cp.pin.number },
      tailFromBlock: startTail.toString(), tailToBlock: pin.number, tailRows: tail.length, complete: true, relevantEvents: relevant, transactions,
      gammaDepositEventCount: historicalDeposits.length, directSignedUniProxyDepositCount: initiated.length, thirdPartyOuterTransactionDepositToAddressCount: received.length },
    exactCallGraph: { sourceEvidence: {
      uniProxy: { path: "targets/gamma-hypervisor-deployed-d5f487/sources/contracts/UniProxy.sol", sha256: sha(fs.readFileSync(path.join(DEPLOYED_SOURCES, "UniProxy.sol"))), lines: "51-63" },
      clearingV2: { path: "targets/gamma-hypervisor-deployed-d5f487/sources/contracts/ClearingV2.sol", sha256: sha(fs.readFileSync(path.join(DEPLOYED_SOURCES, "ClearingV2.sol"))), lines: "113-150" },
      hypervisor: { path: "targets/gamma-hypervisor-deployed-d5f487/sources/contracts/Hypervisor.sol", sha256: sha(fs.readFileSync(path.join(DEPLOYED_SOURCES, "Hypervisor.sol"))), lines: "110-164,217-262" } },
      uniProxy: "deposit() passes msg.sender as both ClearingV2 from and Hypervisor from; caller cannot supply an arbitrary from address",
      clearance: "freeDepositList[pos][from] is checked against the UniProxy caller forwarded as from",
      hypervisor: "deposit() requires msg.sender == whitelistedAddress and transferFrom(from); withdraw() requires from == msg.sender",
      consequence: noRuntime ? "Only a transaction signed by this account can make it msg.sender at UniProxy; choosing it as deposit recipient does not activate its free-list status." : "Contract callability requires authoritative source/control proof." },
    accessAssessment: { sourceAvailable: sourcify.available, sourceRequired: !noRuntime, arbitraryActorCanCauseFreeListedCall: arbitraryCanCause,
      directPublicCall: false, publicVaultDeposit: false, historicalEvidence: { signedByAddress: initiated.length, thirdPartyTriggered: received.length },
      withdrawalControl: noRuntime ? "Gamma shares can be withdrawn only by a transaction signed by this account under exact Hypervisor from==msg.sender semantics." : "UNKNOWN_WITHOUT_SOURCE",
      exitControl: noRuntime ? "EOA key control required; no public runtime selector or vault share path exists at the pin." : "UNKNOWN_WITHOUT_SOURCE" },
    gates: { identity: noRuntime, callGraph: noRuntime, publicAccess: arbitraryCanCause, holderMateriality: currentShares > 0n,
      withdrawalPublic: false, routePositive: false, executableNow: false, signedActionJustified: false },
    classification: noRuntime ? "CLOSED_FREE_LISTED_ADDRESS_IS_EOA_KEY_CONTROLLED" : "ACCESS_UNKNOWN_SOURCE_REQUIRED",
    limitations: ["Read-only finalized evidence only; no state-changing call, signature, fork, transaction, deposit, withdrawal, or exploit invocation.",
      "EOA classification is current-pin code evidence; future delegation or code changes would require reevaluation."], budget: budget.summary() };
  const terminal = await rpc(ep, "eth_getBlockByNumber", [qty(BigInt(pin.number)), false], budget); capture.rpcPolicy.terminalPinMatch = terminal.ok && terminal.result?.hash?.toLowerCase() === pin.hash;
  guard(capture, secrets); fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(CAPTURE, `${JSON.stringify(capture, null, 2)}\n`);
  const cp = { schema: "gamma-free-depositor-history-checkpoint/v1", pin, priorCheckpointSha256: prior.sha256, priorThroughBlock: prior.cp.pin.number, tailFromBlock: startTail.toString(), tailComplete: true,
    relevantEvents: relevant, transactionHashes: transactions.map((x) => x.transaction?.hash).filter(Boolean) }; guard(cp, secrets); fs.writeFileSync(CHECKPOINT, `${JSON.stringify(cp, null, 2)}\n`);
  const files = ["capture.json", "checkpoint.json"].map((name) => { const b = fs.readFileSync(path.join(OUT, name)); return { name, bytes: b.length, sha256: sha(b) }; });
  const manifest = { schema: "gamma-hypervisor-free-depositor-access-gate-manifest/v1", pin, files, gates: capture.gates, classification: capture.classification,
    terminalPinMatch: capture.rpcPolicy.terminalPinMatch, secretGuardPassed: true, jsonValidated: true }; guard(manifest, secrets); fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const file of [CAPTURE, CHECKPOINT, MANIFEST]) JSON.parse(fs.readFileSync(file)); process.stdout.write(`free depositor gate complete: type=${capture.identity.accountType} publicAccess=${arbitraryCanCause} deposits=${historicalDeposits.length} routePositive=false\n`);
}

main().catch((error) => { process.stderr.write(`free depositor gate failed: ${String(error.message || error).replace(/https?:\/\/\S+/giu, "[redacted]")}\n`); process.exitCode = 1; });
