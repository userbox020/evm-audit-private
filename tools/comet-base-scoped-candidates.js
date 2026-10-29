"use strict";

const { providerCapabilityRank } = require("./lib/rpc-provider-reliability");

const MAX_BYTES = 1024 * 1024;
const MAX_CANDIDATES = 8;
const MAX_PER_FAMILY = 2;
// Match the strict Base preflight's authenticated-family suffix allowlist, not
// the broader shared-rpc provider registry. Family identities never leave here.
const FAMILY_RULES = Object.freeze([
  ["alchemy.com", "alchemy"], ["infura.io", "infura"],
  ["quiknode.pro", "quicknode"], ["quicknode.com", "quicknode"],
  ["drpc.org", "drpc"], ["blastapi.io", "blastapi"],
  ["chainstack.com", "chainstack"], ["nodereal.io", "nodereal"],
  ["ankr.com", "ankr"], ["allnodes.com", "allnodes"],
  ["onfinality.io", "onfinality"], ["publicnode.com", "publicnode"],
  ["1rpc.io", "1rpc"], ["llamarpc.com", "llamarpc"],
  ["blockpi.network", "blockpi"], ["thirdweb.com", "thirdweb"],
  ["tenderly.co", "tenderly"], ["pokt.network", "pokt"],
]);
const INSUFFICIENT = Object.freeze({ status: "INSUFFICIENT_BASE_FAMILIES" });
const INVALID = Object.freeze({ status: "INVALID_INVENTORY" });
const BASE_LABEL = /^(?:Base(?:\s+Mainnet)?|8453|(?:Chain(?:\s+ID)?|Network(?:\s+(?:ID|Name))?)\s*[:=]?\s*(?:Base(?:\s+Mainnet)?|8453))(?:\s+(?:RPC|endpoint|endpoints|provider|providers))?$/i;
const URL_TOKEN = /[a-z][a-z0-9+.-]*:\/\/\S+/gi;

function bounded(value, maximum) {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : null;
}

function labelOf(prefix) {
  return prefix.trim()
    .replace(/^(?:[-*>]\s*)+/, "")
    .replace(/^\[([^\]]+)\]/, "$1")
    .replace(/[\s:;=|]+$/, "")
    .trim();
}

function familyOf(parsed) {
  const host = parsed.hostname.toLowerCase();
  const matches = new Set(FAMILY_RULES
    .filter(([domain]) => host === domain || host.endsWith(`.${domain}`))
    .map(([, family]) => family));
  if (matches.size !== 1) return null;
  if (!(parsed.username || parsed.password || parsed.search || (parsed.pathname && parsed.pathname !== "/"))) return null;
  return [...matches][0];
}

function success(urls) {
  // JSON.stringify(result) and JSON.stringify(result.candidates) omit URLs.
  // Consumers must keep the returned array in-process; never log or persist it.
  Object.defineProperty(urls, "toJSON", { value: () => "[REDACTED]" });
  Object.freeze(urls);
  const result = { status: "OK" };
  Object.defineProperty(result, "candidates", { value: urls, enumerable: false });
  return Object.freeze(result);
}

function selectBaseCandidates(inventoryText, options = {}) {
  if (typeof inventoryText !== "string" || Buffer.byteLength(inventoryText, "utf8") > MAX_BYTES
    || !options || typeof options !== "object" || Array.isArray(options)) return INVALID;
  const maxBytes = options.maxBytes === undefined ? MAX_BYTES : bounded(options.maxBytes, MAX_BYTES);
  const maxCandidates = options.maxCandidates === undefined ? MAX_CANDIDATES : bounded(options.maxCandidates, MAX_CANDIDATES);
  const maxPerFamily = options.maxPerFamily === undefined ? MAX_PER_FAMILY : bounded(options.maxPerFamily, MAX_PER_FAMILY);
  if (!maxBytes || !maxCandidates || !maxPerFamily || Buffer.byteLength(inventoryText, "utf8") > maxBytes) return INVALID;

  let inBaseSection = false;
  const seenScopes = new Map();
  const records = [];
  let order = 0;
  for (const rawLine of inventoryText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      // Any heading/comment ends the section; only the exact two headings open it.
      inBaseSection = /^#\s+Base(?:\s+Mainnet)?\s*$/i.test(line);
      continue;
    }
    // Section inheritance applies only to consecutive bare URL records. An
    // unheaded label/assignment (even without a URL) terminates it; an explicit
    // Base label below is eligible on its own line but never opens a section.
    const urlAt = line.search(/[a-z][a-z0-9+.-]*:\/\//i);
    if (urlAt < 0) {
      inBaseSection = false;
      continue;
    }
    const prefix = line.slice(0, urlAt).trim();
    const assignment = /^BASE_RPC\s*=\s*$/i.test(prefix);
    const baseLabel = BASE_LABEL.test(labelOf(prefix));
    if (prefix && !assignment && !baseLabel) inBaseSection = false;
    const tokens = line.match(URL_TOKEN) || [];
    // Also catch adjacent URLs swallowed by the first non-whitespace token.
    if (tokens.length !== 1 || (line.match(/[a-z][a-z0-9+.-]*:\/\//gi) || []).length !== 1) {
      inBaseSection = false;
      continue;
    }
    const token = tokens[0];
    if (!/^https:\/\//i.test(token)) {
      inBaseSection = false;
      continue;
    }
    const at = line.indexOf(token);
    if (at < 0 || line.slice(at + token.length).trim() !== "") {
      inBaseSection = false;
      continue;
    }
    const bareInSection = !prefix && inBaseSection;
    // Other assignments, tags or network hints never inherit section scope.
    const eligibleScope = assignment || baseLabel || bareInSection;
    let parsed;
    try { parsed = new URL(token); } catch (_) { continue; }
    if (parsed.protocol !== "https:" || token.includes("#") || !parsed.hostname) continue;
    const key = parsed.href;
    const oldScope = seenScopes.get(key);
    if (oldScope !== undefined && oldScope !== eligibleScope) return INSUFFICIENT;
    seenScopes.set(key, eligibleScope);
    if (!eligibleScope || oldScope !== undefined) continue;
    const family = familyOf(parsed);
    if (!family) continue;
    records.push({ url: key, family, rank: providerCapabilityRank(key), order: order++ });
  }

  records.sort((left, right) => left.rank - right.rank || left.order - right.order);
  const counts = new Map();
  const selected = [];
  for (const record of records) {
    if (selected.length >= maxCandidates) break;
    const count = counts.get(record.family) || 0;
    if (count >= maxPerFamily) continue;
    counts.set(record.family, count + 1);
    selected.push(record);
  }
  if (counts.size < 2) return INSUFFICIENT;
  return success(selected.map((record) => record.url));
}

module.exports = { selectBaseCandidates };
