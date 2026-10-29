"use strict";
// Pure byte inspection only: no files, provider resolution or bytecode execution.
const crypto = require("node:crypto");
const { ethers } = require("ethers");
const NAMES = {
  0x00: "STOP", 0x01: "ADD", 0x02: "MUL", 0x03: "SUB", 0x04: "DIV", 0x05: "SDIV", 0x06: "MOD", 0x07: "SMOD",
  0x08: "ADDMOD", 0x09: "MULMOD", 0x0a: "EXP", 0x0b: "SIGNEXTEND", 0x10: "LT", 0x11: "GT", 0x12: "SLT", 0x13: "SGT",
  0x14: "EQ", 0x15: "ISZERO", 0x16: "AND", 0x17: "OR", 0x18: "XOR", 0x19: "NOT", 0x1a: "BYTE", 0x1b: "SHL", 0x1c: "SHR", 0x1d: "SAR",
  0x20: "KECCAK256", 0x30: "ADDRESS", 0x31: "BALANCE", 0x32: "ORIGIN", 0x33: "CALLER", 0x34: "CALLVALUE",
  0x35: "CALLDATALOAD", 0x36: "CALLDATASIZE", 0x37: "CALLDATACOPY", 0x38: "CODESIZE", 0x39: "CODECOPY",
  0x3a: "GASPRICE", 0x3b: "EXTCODESIZE", 0x3c: "EXTCODECOPY", 0x3d: "RETURNDATASIZE", 0x3e: "RETURNDATACOPY", 0x3f: "EXTCODEHASH",
  0x40: "BLOCKHASH", 0x41: "COINBASE", 0x42: "TIMESTAMP", 0x43: "NUMBER", 0x44: "PREVRANDAO", 0x45: "GASLIMIT",
  0x46: "CHAINID", 0x47: "SELFBALANCE", 0x48: "BASEFEE", 0x49: "BLOBHASH", 0x4a: "BLOBBASEFEE",
  0x50: "POP", 0x51: "MLOAD", 0x52: "MSTORE", 0x53: "MSTORE8", 0x54: "SLOAD", 0x55: "SSTORE", 0x56: "JUMP", 0x57: "JUMPI",
  0x58: "PC", 0x59: "MSIZE", 0x5a: "GAS", 0x5b: "JUMPDEST", 0x5c: "TLOAD", 0x5d: "TSTORE", 0x5e: "MCOPY", 0x5f: "PUSH0",
  0xf0: "CREATE", 0xf1: "CALL", 0xf2: "CALLCODE", 0xf3: "RETURN", 0xf4: "DELEGATECALL", 0xf5: "CREATE2", 0xfa: "STATICCALL", 0xfd: "REVERT", 0xfe: "INVALID", 0xff: "SELFDESTRUCT",
};
const TERMINALS = new Set(["STOP", "RETURN", "REVERT", "INVALID", "SELFDESTRUCT"]);
const KNOWN_ENTRIES = Object.freeze({
  "vault-manager": { "9e35de0f": [0xfde], "5f711bf9": [0x2461], "26041843": [0x3239], "40e9dcff": [0x2ca3],
    "4842eeaa": [0x29f0], "14e4bd1c": [0x3c15], "dfe8f671": [0x987], "eb02c301": [0x814] },
  "auction-house": { "c55d0f56": [0x16a, 0x129f], "82189551": [0x197, 0xc31], "36bfb6be": [0x1ce, 0x3bd], "b374fe76": [0x179, 0x10bd] },
});
class DecodeFailure extends Error { constructor(code) { super(code); this.code = code; } }
function need(value, code) { if (!value) throw new DecodeFailure(code); }
function hexBytes(hex, maximum = 65536) {
  need(typeof hex === "string" && /^0x(?:[0-9a-f]{2})+$/i.test(hex), "RUNTIME_HEX_INVALID");
  need((hex.length - 2) / 2 <= maximum, "RUNTIME_TOO_LARGE");
  return Buffer.from(hex.slice(2), "hex");
}
function validateRuntime(runtime, expected) {
  const bytes = hexBytes(runtime);
  const facts = { codeBytes: bytes.length, codeSha256: crypto.createHash("sha256").update(bytes).digest("hex"), codeKeccak256: ethers.keccak256(bytes) };
  need(expected && Number.isSafeInteger(expected.codeBytes) && /^[0-9a-f]{64}$/i.test(expected.codeSha256 || "")
    && /^0x[0-9a-f]{64}$/i.test(expected.codeKeccak256 || ""), "RUNTIME_COMMITMENTS_REQUIRED");
  need(expected.codeBytes === facts.codeBytes && expected.codeSha256.toLowerCase() === facts.codeSha256
    && expected.codeKeccak256.toLowerCase() === facts.codeKeccak256, "RUNTIME_COMMITMENT_MISMATCH");
  return facts;
}
function validateSourceArtifact(sourceBytes, runtime, expected) {
  need((Buffer.isBuffer(sourceBytes) || typeof sourceBytes === "string") && /^[0-9a-f]{64}$/i.test(expected?.sourceFileSha256 || ""), "SOURCE_BYTES_COMMITMENT_REQUIRED");
  const bytes = Buffer.isBuffer(sourceBytes) ? sourceBytes : Buffer.from(sourceBytes, "utf8");
  need(bytes.length <= 4_000_000 && crypto.createHash("sha256").update(bytes).digest("hex") === expected.sourceFileSha256.toLowerCase(), "SOURCE_FILE_COMMITMENT_MISMATCH");
  let source; try { source = JSON.parse(bytes.toString("utf8")); } catch (_) { throw new DecodeFailure("SOURCE_JSON_INVALID"); }
  need(typeof source.deployed_bytecode === "string" && source.deployed_bytecode.toLowerCase() === runtime.toLowerCase(), "SOURCE_RUNTIME_BYTES_MISMATCH");
  return { sourceFileSha256: expected.sourceFileSha256.toLowerCase(), sourceFileCommitmentVerified: true,
    verifiedContractSource: false, currentChainBindingVerified: false };
}
function disassemble(runtime) {
  const bytes = hexBytes(runtime), instructions = [];
  for (let pc = 0; pc < bytes.length;) {
    const opcode = bytes[pc], count = opcode >= 0x60 && opcode <= 0x7f ? opcode - 0x5f : 0;
    const available = Math.min(count, bytes.length - pc - 1);
    const name = count ? `PUSH${count}` : opcode >= 0x80 && opcode <= 0x8f ? `DUP${opcode - 0x7f}`
      : opcode >= 0x90 && opcode <= 0x9f ? `SWAP${opcode - 0x8f}` : opcode >= 0xa0 && opcode <= 0xa4 ? `LOG${opcode - 0xa0}`
        : NAMES[opcode] || `UNDEFINED_${opcode.toString(16).padStart(2, "0")}`;
    const row = { pc, opcode, name, size: 1 + available };
    if (count) { row.immediate = `0x${bytes.subarray(pc + 1, pc + 1 + available).toString("hex")}`; row.truncated = available !== count; }
    instructions.push(row); pc += row.size;
  }
  return instructions;
}
function dispatchComparisons(instructions) {
  const byPC = new Map(instructions.map(row => [row.pc, row])), result = [];
  for (let index = 0; index + 3 < instructions.length; index++) {
    const [push, eq, dest, jump] = instructions.slice(index, index + 4);
    if (push.name !== "PUSH4" || push.truncated || eq.name !== "EQ" || !/^PUSH[1-4]$/.test(dest.name)
        || dest.truncated || jump.name !== "JUMPI") continue;
    const entryPC = Number(BigInt(dest.immediate));
    result.push({ selector: push.immediate, comparisonPC: eq.pc, jumpPC: jump.pc, entryPC,
      validJumpdest: byPC.get(entryPC)?.name === "JUMPDEST", evidenceClass: "SELECTOR_COMPARISON_NOT_FUNCTION_NAME_OR_SEMANTIC_PROOF" });
  }
  return result;
}
function effect(name) {
  if (["ADD", "MUL", "SUB", "DIV", "SDIV", "MOD", "SMOD", "EXP", "SIGNEXTEND", "LT", "GT", "SLT", "SGT", "EQ", "AND", "OR", "XOR", "BYTE", "SHL", "SHR", "SAR", "KECCAK256"].includes(name)) return [2, 1];
  if (["ADDMOD", "MULMOD"].includes(name)) return [3, 1];
  if (["ISZERO", "NOT", "BALANCE", "CALLDATALOAD", "EXTCODESIZE", "EXTCODEHASH", "BLOCKHASH", "BLOBHASH", "MLOAD", "SLOAD", "TLOAD"].includes(name)) return [1, 1];
  if (["MSTORE", "MSTORE8", "SSTORE", "TSTORE", "RETURN", "REVERT", "JUMPI"].includes(name)) return [2, 0];
  if (["CALLDATACOPY", "CODECOPY", "RETURNDATACOPY", "MCOPY"].includes(name)) return [3, 0];
  if (name === "EXTCODECOPY") return [4, 0];
  if (["POP", "JUMP", "SELFDESTRUCT"].includes(name)) return [1, 0];
  if (/^LOG[0-4]$/.test(name)) return [2 + Number(name.slice(3)), 0];
  if (["CALL", "CALLCODE"].includes(name)) return [7, 1];
  if (["STATICCALL", "DELEGATECALL"].includes(name)) return [6, 1];
  if (name === "CREATE") return [3, 1];
  if (name === "CREATE2") return [4, 1];
  if (["JUMPDEST", "STOP", "INVALID"].includes(name)) return [0, 0];
  if (Object.values(NAMES).includes(name)) return [0, 1];
  return null;
}
function blockFacts(rows) {
  const stack = [], annotations = [];
  let jumpTarget = null;
  const pop = () => stack.length ? stack.pop() : null;
  for (const row of rows) {
    const name = row.name;
    if (name === "PUSH0") { stack.push(0n); continue; }
    if (/^PUSH\d+$/.test(name)) { stack.push(row.truncated ? null : BigInt(row.immediate)); continue; }
    if (/^DUP\d+$/.test(name)) { stack.push(stack[stack.length - Number(name.slice(3))] ?? null); continue; }
    if (/^SWAP\d+$/.test(name)) {
      const depth = Number(name.slice(4)); while (stack.length <= depth) stack.unshift(null);
      const top = stack.length - 1; [stack[top], stack[top - depth]] = [stack[top - depth], stack[top]]; continue;
    }
    const arity = effect(name);
    if (!arity) { annotations.push({ pc: row.pc, kind: "UNRESOLVED_OPCODE", opcode: row.opcode }); stack.length = 0; continue; }
    const args = Array.from({ length: arity[0] }, pop);
    if (["JUMP", "JUMPI"].includes(name)) jumpTarget = args[0];
    if (["CALLER", "ORIGIN", "CALLVALUE"].includes(name)) annotations.push({ pc: row.pc, kind: name, predicate: "UNRESOLVED" });
    if (["SLOAD", "SSTORE", "TLOAD", "TSTORE"].includes(name)) annotations.push({ pc: row.pc, kind: name,
      slotLiteral: args[0] === null ? null : ethers.toBeHex(args[0], 32), interpretation: "UNQUALIFIED_STORAGE_ACCESS" });
    if (["CALL", "CALLCODE", "DELEGATECALL", "STATICCALL"].includes(name)) annotations.push({ pc: row.pc, kind: name,
      targetLiteral: args[1] !== null && args[1] < (1n << 160n) ? ethers.toBeHex(args[1], 20) : null,
      argumentsAndReturnSemantics: "UNRESOLVED" });
    let constant = null;
    // Only exact, local constant operations; no inferred cross-block state.
    if (name === "AND" && args.every(value => value !== null)) constant = args[0] & args[1];
    if (name === "OR" && args.every(value => value !== null)) constant = args[0] | args[1];
    if (name === "SHL" && args.every(value => value !== null)) constant = args[0] >= 256n ? 0n : (args[1] << args[0]) & ((1n << 256n) - 1n);
    if (name === "SHR" && args.every(value => value !== null)) constant = args[0] >= 256n ? 0n : args[1] >> args[0];
    for (let index = 0; index < arity[1]; index++) stack.push(constant);
  }
  return { annotations, jumpTarget };
}
function decodeRuntime({ runtime, expected, sourceBytes, role, entries = KNOWN_ENTRIES[role] || {}, maxBlocks = 256, maxEdges = 512 } = {}) {
  const commitments = validateRuntime(runtime, expected), instructions = disassemble(runtime);
  const sourceArtifact = sourceBytes === undefined ? null : validateSourceArtifact(sourceBytes, runtime, expected);
  need(Number.isSafeInteger(maxBlocks) && maxBlocks > 0 && maxBlocks <= 4096
    && Number.isSafeInteger(maxEdges) && maxEdges > 0 && maxEdges <= 8192, "CFG_CAP_INVALID");
  const byPC = new Map(instructions.map(row => [row.pc, row])), dispatcher = dispatchComparisons(instructions);
  const explicitEntries = [];
  for (const [selector, pcs] of Object.entries(entries)) {
    need(/^(?:0x)?[0-9a-f]{8}$/i.test(selector) && Array.isArray(pcs) && pcs.length > 0 && pcs.length <= 8, "ENTRY_INVALID");
    for (const pc of pcs) {
      need(Number.isSafeInteger(pc) && byPC.get(pc)?.name === "JUMPDEST", "ENTRY_NOT_JUMPDEST");
      explicitEntries.push({ selector: `0x${selector.replace(/^0x/i, "")}`.toLowerCase(), pc, nameProven: false, origin: "EXPLICIT_INPUT_PC" });
    }
  }
  const starts = new Set([0]);
  for (const row of instructions) if (row.name === "JUMPDEST") starts.add(row.pc);
  for (let index = 0; index + 1 < instructions.length; index++) if (["JUMP", "JUMPI"].includes(instructions[index].name)
    || TERMINALS.has(instructions[index].name) || instructions[index].name.startsWith("UNDEFINED_")) starts.add(instructions[index + 1].pc);
  const queue = [...new Set([0, ...explicitEntries.map(row => row.pc), ...dispatcher.filter(row => row.validJumpdest).map(row => row.entryPC)])];
  const blocks = [], edges = [], seen = new Set(), unresolved = [];
  let truncated = false;
  while (queue.length) {
    const pc = queue.shift(); if (seen.has(pc)) continue;
    if (blocks.length >= maxBlocks) { truncated = true; break; }
    seen.add(pc); let cursor = pc; const rows = [];
    while (byPC.has(cursor)) {
      const row = byPC.get(cursor); if (rows.length && starts.has(cursor)) break;
      rows.push(row); cursor += row.size;
      if (["JUMP", "JUMPI"].includes(row.name) || TERMINALS.has(row.name) || row.name.startsWith("UNDEFINED_") || row.truncated) break;
    }
    if (!rows.length) continue;
    const last = rows[rows.length - 1], facts = blockFacts(rows);
    blocks.push({ pc, endPC: last.pc, instructionPCs: rows.map(row => row.pc), terminal: TERMINALS.has(last.name) ? last.name : null, annotations: facts.annotations });
    const edge = (to, kind) => {
      if (edges.length >= maxEdges) { truncated = true; return; }
      edges.push({ from: pc, atPC: last.pc, to, kind }); if (to !== null) queue.push(to);
    };
    if (["JUMP", "JUMPI"].includes(last.name)) {
      const target = facts.jumpTarget;
      if (target !== null && target <= BigInt(Number.MAX_SAFE_INTEGER) && byPC.get(Number(target))?.name === "JUMPDEST") edge(Number(target), "STATIC_TARGET");
      else { edge(null, "UNRESOLVED_DYNAMIC_OR_INVALID_JUMP"); unresolved.push({ pc: last.pc, predicate: "JUMP_DESTINATION_UNRESOLVED" }); }
      if (last.name === "JUMPI" && byPC.has(cursor)) edge(cursor, "CONDITION_UNRESOLVED_FALLTHROUGH");
    } else if (!TERMINALS.has(last.name) && !last.name.startsWith("UNDEFINED_") && !last.truncated && byPC.has(cursor)) edge(cursor, "FALLTHROUGH");
    if (last.truncated) unresolved.push({ pc: last.pc, predicate: "TRUNCATED_PUSH_OR_METADATA_UNCLASSIFIED" });
  }
  const literalFacts = instructions.filter(row => row.immediate && !row.truncated).map(row => ({ pc: row.pc, opcode: row.name, value: row.immediate }));
  return { schema: "surge-runtime-facts/v1", role: role || null, evidenceClass: "HISTORICAL_SUPPLIED_BYTES_NOT_CURRENT_CHAIN_BINDING",
    commitments, sourceArtifact, currentChainBindingVerified: false, instructions, dispatcher, explicitEntries, blocks, edges, literalFacts,
    oracleReferenceFacts: role === "oracle" ? { convergencePC: 0xc7, convergenceIsJumpdest: byPC.get(0xc7)?.name === "JUMPDEST",
      convergenceCallsites: instructions.flatMap((row, index) => row.immediate && !row.truncated && BigInt(row.immediate) === 0xc7n
        && instructions[index + 1]?.name === "JUMP" ? [{ pushPC: row.pc, jumpPC: instructions[index + 1].pc }] : []),
      literalFeedPCs: literalFacts.filter(row => BigInt(row.value) === 0x64c911996d3c6ac71f9b455b1e8e7266bcbd848fn).map(row => row.pc),
      latestRoundDataSelectorPCs: literalFacts.filter(row => row.opcode === "PUSH4" && row.value === "0xfeaf968c").map(row => row.pc),
      constant3600PCs: literalFacts.filter(row => BigInt(row.value) === 3600n).map(row => row.pc),
      timestampReadPCs: instructions.filter(row => row.name === "TIMESTAMP").map(row => row.pc),
      lexicalComparisonPCs: instructions.filter(row => ["LT", "GT", "SLT", "SGT", "EQ", "ISZERO"].includes(row.name)).map(row => row.pc),
      externalCalls: blocks.flatMap(block => block.annotations).filter(row => ["CALL", "STATICCALL", "DELEGATECALL"].includes(row.kind)),
      scalingAndFreshnessPredicate: "UNRESOLVED" } : null,
    unresolvedPredicates: [...unresolved, { pc: null, predicate: "LOAN_TUPLE_AUTHORITY_AUCTION_PRICING_BTC_SETTLEMENT_UNQUALIFIED" }],
    bounds: { maxBlocks, maxEdges, truncated }, completeCFG: false, semanticProof: false };
}
const BUY = new ethers.Interface(["function buy(uint256 id,bytes data)"]);
function encodeBuy(id, data) {
  need(typeof id === "bigint" && id >= 0n && id < (1n << 256n), "BUY_ID_INVALID");
  need(typeof data === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(data) && data.length <= 2 + 65536 * 2, "BUY_BYTES_INVALID");
  return BUY.encodeFunctionData("buy", [id, data]);
}
function decodeBuy(calldata) {
  need(typeof calldata === "string" && /^0x(?:[0-9a-f]{2})+$/i.test(calldata), "BUY_CALLDATA_INVALID");
  try {
    const [id, data] = BUY.decodeFunctionData("buy", calldata);
    need(encodeBuy(id, data).toLowerCase() === calldata.toLowerCase(), "BUY_NONCANONICAL_OFFSET_LENGTH");
    return { id: id.toString(), data, offsetBytes: 64, lengthBytes: (data.length - 2) / 2, executionPermitted: false };
  } catch (error) { if (error instanceof DecodeFailure) throw error; throw new DecodeFailure("BUY_CALLDATA_INVALID"); }
}
module.exports = { validateRuntime, validateSourceArtifact, disassemble, dispatchComparisons, decodeRuntime, encodeBuy, decodeBuy, KNOWN_ENTRIES, DecodeFailure };
