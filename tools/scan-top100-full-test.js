#!/usr/bin/env node
// scan-top100-full-test.js - Artifact-only top-100 full-test readiness scan.
// No RPC/endpoint/env reads, no network calls, no signed actions.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const ROUTE_SWEEP = path.join(WORKSPACE, "reports", "raw", "fast", "route-positive-sweep.json");
const OUT_RAW = path.join(WORKSPACE, "reports", "raw", "fast", "top100-full-test.json");
const OUT_REPORT = path.join(WORKSPACE, "reports", "top100-full-test.md");
const GAP_FILL_BATCH_GLOB_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const GAP_FILL_BATCH_PREFIX = "top100-full-test-gap-fill-batch-";

const QUIET = process.argv.includes("--quiet");
const TOP_LIMIT = Number(process.env.TOP100_FULL_TEST_LIMIT || "100");
const MAX_ARRAY_SCAN = Number(process.env.TOP100_FULL_TEST_MAX_ARRAY_SCAN || "32");

const CHECKLIST = {
  sourceInventory: {
    label: "Scope and source inventory",
    patterns: [
      /scanned|scan|discovery|discovered|discovery|inventory|mapped|join|mapped|artifact|artifacts|targets|targets?|sources?|sourceRows|contracts?|tokens?|rows?|chains?|markets?/i,
    ],
  },
  verifiedAbi: {
    label: "Verified ABI/source-aware probing",
    patterns: [
      /abi|bytecode|source.?code|verified|implementation|proxy|selector|selectors?|function.?signatures?|access.?control|interface/i,
    ],
  },
  eventLogs: {
    label: "Event/log active-surface discovery",
    patterns: [
      /event|log|topic|paircreated|poolcreated|mint|burn|swap|exchange|factory|emit|emit\(|event\(/i,
    ],
  },
  proxyRoleGraph: {
    label: "Proxy/admin/role graph",
    patterns: [
      /proxy|implementation|admin|owner|timelock|upgrad|role|accesscontrol|multisig|authority|governance|pauser|guardian/i,
    ],
  },
  accessControlValidation: {
    label: "Access control validation",
    patterns: [
      /access.?control|onlyOwner|onlyRole|auth|authority|permissioned|role|admin|guardian|pauser|minter|burner|upgrader|whitelist|blacklist|owner|governance/i,
    ],
  },
  tokenSemantics: {
    label: "Token semantics battery",
    patterns: [
      /token|symbol|decimals|supply|totalsupply|blacklist|whitelist|pause|paused|mint|burn|transfer(able)?|permit|allowance|rebase|fee|rebasing|soulbound/i,
    ],
  },
  donationErC4626: {
    label: "Donation/ERC4626/share accounting",
    patterns: [
      /erc4626|convertTo(assets|shares)|totalAssets|maxDeposit|maxMint|maxWithdraw|maxRedeem|donation|vault|share|asset\(|sharePrice|pricePerShare/i,
    ],
  },
  oracleDiscovery: {
    label: "Oracle/feed/scalar discovery",
    patterns: [
      /oracle|pricefeed|aggregator|latestRoundData|latestAnswer|getPrice|getAssetPrice|feed|price|stalen|heartbeat|scalar|multiplier|decim|chainlink/i,
    ],
  },
  bridgeProof: {
    label: "Bridge/proof/backing invariants",
    patterns: [
      /bridge|proof|custody|escrow|message|retryable|l1|l2|inbox|outbox|proof.*binding|binding|mint|unlock|release|withdraw|deposit|backing|supply|fake.?mint|forged.?proof|forged.?message|root.?membership|domain.?separation|message.?ordering/i,
    ],
  },
  dexConsumer: {
    label: "DEX/liquidity and consumer graph",
    patterns: [
      /dex|amm|router|pool|liquidity|swap|consumer|borrow|lend|market|redeem|liquidation|vault|join|consumer/i,
    ],
  },
  balanceReachability: {
    label: "Balance reachability and public entrypoints",
    patterns: [
      /balance|balances?|allowance|approve|approval|transferFrom|permit|public|entrypoint|selector|value.?moving|permissionless|route|reachable|fallback/i,
    ],
  },
  exactEconomics: {
    label: "Exact-quote/fork economics",
    patterns: [
      /quote|quotes|bestNet|bestGap|bestNetProfit|netGap|gas|slippage|premium|profit|liquidity|edgeBps|measured|exact|minOut|minProfit/i,
    ],
  },
  forkProof: {
    label: "Fork/value-delta proof",
    patterns: [
      /fork|staticcall|staticCall|simulate|simulation|valueDelta|balanceDelta|stateDiff|prestate|poststate|proofRows|forkProof|forkProofRows/i,
    ],
  },
  liveStateSnapshot: {
    label: "Live state snapshot",
    patterns: [
      /live.?state|latest|blockNumber|block.?number|blockTag|timestamp|ageSeconds|fresh|current|generatedAt|rpcBlocked|rpc.?available|sampled/i,
    ],
  },
  reviewAndGates: {
    label: "Review and gates",
    patterns: [
      /requiredForRoutePositive|nextReadOnlyStep|forkGate|blocker|blockers|routePositive|executableNow|signedActionJustified|gate|review|completion|readonly|nextAction/i,
    ],
  },
  nonBorrowVaultDrain: {
    label: "Non-borrow vault-drain surfaces",
    patterns: [
      /drain|vault.*drain|without borrow|no.?borrow|sweep|migrate|migration|strategy|rebalanc|allocator|withdraw.*assets|rescue|public.*vault|permissionless.*vault/i,
    ],
  },
  publicAllocatorExploitation: {
    label: "Public allocator/rebalancing exploitation",
    patterns: [
      /public.?allocator|allocator|reallocate|reallocateTo|rebalance|front.?run.*rebalanc|allocator.*mev|force.?feed|curator|queue.*allocator/i,
    ],
  },
  strategyMigrationAttacks: {
    label: "Strategy migration/sweep attacks",
    patterns: [
      /strategy|adapter|migrate|migration|sweep|harvest|rebalance|withdrawFromStrategy|setStrategy|replaceStrategy|permissionless.*strategy/i,
    ],
  },
  feeOnTransferAmplification: {
    label: "Fee-on-transfer/rebase amplification",
    patterns: [
      /fee.?on.?transfer|transfer.?fee|rebase|rebasing|deflationary|inflationary|tax|received.*less|balance.?delta|share.*drift/i,
    ],
  },
  vaultSharePriceManipulation: {
    label: "Vault share-price manipulation",
    patterns: [
      /share.?price|pricePerShare|exchangeRate|convertToAssets|convertToShares|totalAssets|donat|flash.?loan.*share|virtual.?offset|low.?tvl|empty.?vault/i,
    ],
  },
  routerRfqSettlementApprovalDrain: {
    label: "Router/RFQ settlement drift and approval drains",
    patterns: [
      /router|rfq|settlement|approval.?drain|deprecated.*path|allowance|permit2|transferFrom|spender|order|signature|fill/i,
    ],
  },
  fakeAssetPoolValidation: {
    label: "Fake asset/pool validation",
    patterns: [
      /fake.?asset|fake.?pool|fake.?lp|lp.?token|asset.?validation|pool.?validation|collateral.?validation|trusted.?asset|trusted.?pool|oracle.?pool|pool.?oracle|canonical.?factory|whitelist|factory.?validation|canonical|counterfeit/i,
    ],
  },
  governanceAttacks: {
    label: "Governance and flash-loan voting attacks",
    patterns: [
      /governance|proposal|vote|voting|flash.?loan.*vote|snapshot|timelock|delegate|delegation|quorum|malicious.?proposal/i,
    ],
  },
  airdropClaimReplay: {
    label: "Airdrop/claim/merkle replay exploitation",
    patterns: [
      /airdrop|claim|merkle|proof|replay|distributor|reward.*claim|sweep.*claim|claimable|receiver|recipient/i,
    ],
  },
  mevSandwichRebalancing: {
    label: "MEV/sandwich on allocators/rebalancing",
    patterns: [
      /mev|sandwich|front.?run|back.?run|rebalanc|allocator|auction|batch|solver|slippage|order.*economics/i,
    ],
  },
  roundingPredictionMarket: {
    label: "Rounding and prediction-market attacks",
    patterns: [
      /rounding|precision|dust|truncat|ceil|floor|mulDiv|round.?up|round.?down|wad|ray|fixed.?point|prediction|ctf|conditional|market.*maker|payout|condition|redeem.?position/i,
    ],
  },
  oracleSandwich: {
    label: "Oracle sandwich/manipulate-exploit-revert",
    patterns: [
      /oracle.*sandwich|manipulat.*oracle|oracle.*manipulat|manipulat.*exploit.*revert|exploit.*revert|same.?block.*oracle|twap|spot.*oracle|stale.*oracle|update.*price|revert.*manipulation|price.*impact/i,
    ],
  },
  permissionlessReturndataControl: {
    label: "Permissionless surface with returndata/random-selector controls",
    patterns: [
      /permissionless|returndata|random.?selector|selector|unknown.?selector|fallback|public.*entry|mutative.?probe|static.?call|control/i,
    ],
  },
  consumerGraphValidation: {
    label: "Consumer graph validation",
    patterns: [
      /consumer.?graph|consumer|join|accepted.?value|trusted.?consumer|lending.?consumer|vault.?consumer|oracle.?consumer|external.?consumer/i,
    ],
  },
  dexExitValidation: {
    label: "DEX exit validation",
    patterns: [
      /dex.?exit|exit.?liquidity|unwind|swap|router|pool|quote|slippage|exact.?output|exact.?input|liquidity/i,
    ],
  },
  economicModelValidation: {
    label: "Economic model validation",
    patterns: [
      /economic|model|net|profit|loss|negative|positive|ev|break.?even|haircut|ltv|gas|fee|slippage|capacity|cap/i,
    ],
  },
  forkTestValidation: {
    label: "Fork test / local value-delta validation",
    patterns: [
      /fork.?test|fork|local.?proof|value.?delta|balance.?delta|staticCall|estimateGas|simulation|prestate|poststate/i,
    ],
  },
  crossFunctionAccountingInvariants: {
    label: "Cross-function accounting invariants",
    patterns: [
      /invariant|accounting|deposit.*borrow|borrow.*repay|repay.*withdraw|deposit.*withdraw|sequence|cross.?function|state.?machine/i,
    ],
  },
  epochQueueWindowTransitions: {
    label: "Epoch/queue/window state transitions",
    patterns: [
      /epoch|queue|window|cooldown|delay|same.?epoch|withdrawal.?queue|claim.?window|maturity|requestWithdraw|pending/i,
    ],
  },
  rewardIndexIncentiveAccounting: {
    label: "Reward-index/incentive accounting",
    patterns: [
      /reward|incentive|index|rewardPerToken|rewardDebt|checkpoint|cumulative|indexDelta|unclaimed|accReward|claimRewards|emission|gauge|staking|distributor/i,
    ],
  },
  callbackReentrancy: {
    label: "Cross-function/callback reentrancy",
    patterns: [
      /reentr|callback|hook|beforeSwap|afterSwap|flash.?loan.*callback|onFlashLoan|uniswapV3SwapCallback|uniswapV3MintCallback|ERC777|tokensReceived|onERC|receive|fallback|external.?call/i,
    ],
  },
  upgradeModuleInitialization: {
    label: "Upgrade/module initialization state",
    patterns: [
      /upgrade|initialize|initializer|uninitialized|module|implementation|beacon|proxy|admin|upgradeTo|upgradeToAndCall/i,
    ],
  },
  permitDelegatedAuthorization: {
    label: "Permit/delegated authorization edge cases",
    patterns: [
      /permit|delegate|delegated|delegation|authorization|allowance|signature|nonce|eip.?2612|permit2|approve/i,
    ],
  },
  strategyAdapterAccountingMismatch: {
    label: "Strategy adapter accounting mismatch",
    patterns: [
      /strategy.*adapter|adapter.*accounting|adapter.*mismatch|nav.*mismatch|asset.*mismatch|share.*mismatch|reported.*assets|actual.*assets/i,
    ],
  },
  liquidationAuctionSequencing: {
    label: "Liquidation/auction sequencing",
    patterns: [
      /liquidat|auction|bid|seize|repay|health.?factor|collateral.?factor|close.?factor|auction.*sequence|settle/i,
    ],
  },
  crossChainMessageOrdering: {
    label: "Cross-chain message ordering",
    patterns: [
      /cross.?chain|message.?ordering|nonce|sequence|retryable|inbox|outbox|bridge|domain|source.?chain|destination.?chain|replay/i,
    ],
  },
};

const CHECKLIST_KEYS = Object.keys(CHECKLIST);

const FLAG_REQUIREMENTS = {
  routePositive: ["sourceInventory", "permissionlessReturndataControl", "balanceReachability", "economicModelValidation", "exactEconomics", "reviewAndGates"],
  executableNow: ["sourceInventory", "accessControlValidation", "liveStateSnapshot", "permissionlessReturndataControl", "exactEconomics", "balanceReachability", "forkProof", "reviewAndGates"],
  signedActionJustified: ["sourceInventory", "accessControlValidation", "liveStateSnapshot", "permissionlessReturndataControl", "exactEconomics", "forkProof", "balanceReachability", "reviewAndGates"],
};

function safeRelative(file) {
  return path.relative(WORKSPACE, file).replace(/\\/g, "/");
}

function normalizeArtifactPath(relativeFile) {
  const normalized = String(relativeFile || "").replace(/[\\/]+/g, path.sep).trim();
  if (!normalized) return null;
  if (path.isAbsolute(normalized)) return normalized;
  return path.join(WORKSPACE, normalized);
}

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const text = fs.readFileSync(file, "utf8");
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

function readText(file, fallback = "") {
  try {
    if (!fs.existsSync(file)) return fallback;
    return fs.readFileSync(file, "utf8");
  } catch (_) {
    return fallback;
  }
}

function isGapFillBatchFile(file) {
  const base = path.basename(String(file || "")).toLowerCase();
  return base.startsWith(GAP_FILL_BATCH_PREFIX) && base.endsWith(".json");
}

function normalizeRowRef(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return null;
}

function loadGapFillBatchArtifacts() {
  const out = {
    files: [],
    byRowId: {},
  };

  try {
    if (!fs.existsSync(GAP_FILL_BATCH_GLOB_DIR)) return out;
    const dirEntries = fs.readdirSync(GAP_FILL_BATCH_GLOB_DIR);
    const files = dirEntries
      .filter((name) => /^top100-full-test-gap-fill-batch-\d+\.json$/i.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    for (const name of files) {
      const absolutePath = path.join(GAP_FILL_BATCH_GLOB_DIR, name);
      const batch = readJson(absolutePath, null);
      if (!batch || typeof batch !== "object") continue;

      out.files.push(absolutePath);

      const rows = Array.isArray(batch.rows) ? batch.rows : (Array.isArray(batch.pairs) ? batch.pairs : []);
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;

        const rowId = normalizeRowRef(row.rowId) || normalizeRowRef(row.id);
        if (!rowId) continue;

        if (!out.byRowId[rowId]) out.byRowId[rowId] = new Set();
        out.byRowId[rowId].add(absolutePath);

        if (Array.isArray(row.categories)) {
          // Keep per-row row-specific refs explicit for future-proof schema.
          for (const category of row.categories) {
            const cat = normalizeRowRef(category);
            if (cat) {
              const catKey = `${rowId}::${cat}`;
              if (!out.byRowId[catKey]) out.byRowId[catKey] = new Set();
              out.byRowId[catKey].add(absolutePath);
            }
          }
        }
      }
    }
  } catch (_) {
    return out;
  }

  return out;
}

function normalizeSourceArtifactRef(entry) {
  if (entry == null) return null;

  if (typeof entry === "string") {
    const p = entry.trim();
    return p ? { path: p } : null;
  }

  if (typeof entry === "object") {
    if (typeof entry.path === "string" && entry.path.trim()) {
      return {
        path: entry.path,
        scope: entry.scope || null,
        parsed: Boolean(entry.parsed),
        nonJson: Boolean(entry.nonJson),
        error: entry.error || null,
      };
    }
    if (typeof entry.file === "string" && entry.file.trim()) {
      return {
        path: entry.file,
        scope: entry.scope || null,
        parsed: Boolean(entry.parsed),
        nonJson: Boolean(entry.nonJson),
        error: entry.error || null,
      };
    }
  }

  return null;
}

function dedupeArtifacts(artifacts) {
  const out = [];
  const seen = new Set();
  for (const item of artifacts || []) {
    const normalized = normalizeSourceArtifactRef(item);
    if (!normalized) continue;
    const pathKey = String(normalized.path || "").trim().replace(/[\\/]+/g, "/").toLowerCase();
    const scopeKey = String(normalized.scope || "").trim().toLowerCase();
    const key = `${pathKey}::${scopeKey}`;
    if (!key) continue;
    if (seen.has(key.toLowerCase())) continue;
    seen.add(key.toLowerCase());
    out.push(normalized);
  }
  return out;
}

function rowScopeMatches(rowArtifact, scope) {
  if (!scope) return true;
  const target = String(scope).trim();
  if (!target) return true;

  if (rowArtifact.category === target) return true;
  if (rowArtifact.categoryLabel === target) return true;
  if (rowArtifact.categoryKey === target) return true;
  if (Array.isArray(rowArtifact.categories) && rowArtifact.categories.some((item) => String(item || "").trim() === target)) return true;
  return Object.prototype.hasOwnProperty.call(rowArtifact, target);
}

function artifactMatchesRow(artifactRow, rowContext) {
  if (!artifactRow || !rowContext || typeof artifactRow !== "object") return false;
  const rowId = normalizeRowRef(rowContext.id);
  const rank = normalizeRowRef(rowContext.rank);
  const candidates = [
    artifactRow.rowId,
    artifactRow.id,
    artifactRow.routeId,
    artifactRow.targetId,
  ];
  if (candidates.some((candidate) => normalizeRowRef(candidate) === rowId)) return true;
  if (rank && candidates.some((candidate) => normalizeRowRef(candidate) === rank)) return true;
  if (typeof artifactRow.rank !== "undefined" && artifactRow.rank !== null && rank !== null && String(artifactRow.rank) === rank) return true;
  return false;
}

function selectGapFillArtifactScope(artifact, rowContext, scope = null) {
  if (!artifact || !rowContext || typeof artifact !== "object") return artifact;

  if (artifactMatchesRow(artifact, rowContext)) return artifact;

  if (Array.isArray(artifact.rows)) {
    for (const item of artifact.rows) {
      if (!artifactMatchesRow(item, rowContext)) continue;
      if (!scope || rowScopeMatches(item, scope)) return item;
    }
  }

  if (Array.isArray(artifact.pairs)) {
    for (const item of artifact.pairs) {
      if (!artifactMatchesRow(item, rowContext)) continue;
      if (!scope || rowScopeMatches(item, scope)) return item;
    }
  }

  return null;
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const n = Number(String(value).replace(/[^0-9+-.eE]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function asBoolean(value) {
  if (value === true || value === 1 || value === "1" || /true/i.test(String(value))) return true;
  if (value === false || value === 0 || value === "0" || /false/i.test(String(value))) return false;
  return false;
}

function markdownBool(value) {
  return value ? "✅" : "⚪";
}

function artifactAgeHours(generatedAt) {
  if (!generatedAt) return null;
  const t = Date.parse(generatedAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (Date.now() - t) / 36e5);
}

function updateMax(stats, key, value) {
  const n = asNumber(value);
  if (n === null) return;
  stats[key] = Math.max(stats[key] || 0, n);
}

function blankSignals() {
  return {
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: 0,
    watchCandidates: 0,
    exactEconomicsRows: 0,
    forkProofRows: 0,
    consumerJoinRows: 0,
    rpcBlocked: false,
  };
}

function extractSignals(value, stats = null, depth = 0) {
  const out = stats || blankSignals();
  if (depth > 12 || value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, MAX_ARRAY_SCAN)) extractSignals(item, out, depth + 1);
    return out;
  }
  if (typeof value !== "object") return out;
  for (const [key, child] of Object.entries(value)) {
    if (/^routePositive$/i.test(key)) updateMax(out, "routePositive", child);
    if (/^executableNow$/i.test(key)) updateMax(out, "executableNow", child);
    if (/^signedActionJustified$/i.test(key)) updateMax(out, "signedActionJustified", child);
    if (/watchCandidates|watchRows|watchOnlyRows/i.test(key)) updateMax(out, "watchCandidates", child);
    if (/exactEconomicsRows|exactPositiveRows|exactQuoteRows|rowsWithExact|positiveEconomicsRows/i.test(key)) updateMax(out, "exactEconomicsRows", child);
    if (/forkProofRows|forkRows|forkPositiveRows|forkProof/i.test(key)) updateMax(out, "forkProofRows", child);
    if (/consumerJoinRows|consumerRows|directConsumerRows|materialConsumerRows/i.test(key)) updateMax(out, "consumerJoinRows", child);
    if (/rpcBlocked|rpcUnavailable|missingRpc|requiredEndpointUnavailable|unsupportedChains/i.test(key)) {
      if ((Array.isArray(child) && child.length) || child === true || (asNumber(child) || 0) > 0) out.rpcBlocked = true;
    }
    extractSignals(child, out, depth + 1);
  }
  return out;
}

function pickTopByRank(rows, limit) {
  return rows
    .map((row) => ({ ...row }))
    .sort((a, b) => {
      const rankA = asNumber(a.rank);
      const rankB = asNumber(b.rank);
      if (rankA !== null && rankB !== null && rankA !== rankB) return rankA - rankB;
      const pA = asNumber(a.priorityScore) || 0;
      const pB = asNumber(a.priorityScore) || 0;
      if (pA !== pB) return pB - pA;
      const protoA = String(a.protocol || "").localeCompare(String(b.protocol || ""));
      if (protoA !== 0) return protoA;
      return 0;
    })
    .slice(0, limit);
}

function candidateArrayScore(items) {
  if (!Array.isArray(items)) return -1;
  const sample = items.slice(0, 30);
  let score = 0;
  for (const item of sample) {
    if (!item || typeof item !== "object") continue;
    if ("id" in item) score += 3;
    if ("rank" in item) score += 4;
    if ("protocol" in item) score += 1;
    if ("status" in item) score += 1;
    if ("priorityScore" in item) score += 1;
    if ("routePositive" in item) score += 2;
    if ("sourceArtifacts" in item) score += 1;
  }
  return score;
}

function extractRows(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];

  const directKeys = [
    "ranked",
    "candidates",
    "rows",
    "items",
    "entries",
    "branches",
    "targets",
    "surfaces",
    "results",
    "routeRows",
    "top",
  ];

  for (const key of directKeys) {
    if (Array.isArray(data[key])) return data[key];
  }

  let best = null;
  let bestScore = -1;
  for (const [key, value] of Object.entries(data)) {
    if (!Array.isArray(value)) continue;
    const score = candidateArrayScore(value);
    if (score > bestScore) {
      bestScore = score;
      best = value;
    }
  }

  return best || [];
}

function mkBlankEvidence() {
  const out = {};
  for (const key of CHECKLIST_KEYS) {
    out[key] = { covered: false, score: 0, samples: [] };
  }
  return out;
}

function scanPatternsForText(evidence, text, sample) {
  const lower = String(text || "").toLowerCase();
  for (const key of CHECKLIST_KEYS) {
    const item = CHECKLIST[key];
    const matched = item.patterns.some((pattern) => pattern.test(lower));
    if (!matched) continue;
    const state = evidence[key];
    state.covered = true;
    state.score += 1;
    if (sample && state.samples.length < 3) {
      state.samples.push(sample.slice(0, 220));
    }
  }
}

function analyzeForChecklist(value, evidence, contextPath = "", depth = 0) {
  if (depth > 18 || value === null || value === undefined) return;

  if (Array.isArray(value)) {
    scanPatternsForText(evidence, contextPath, contextPath);
    const limit = Math.min(value.length, MAX_ARRAY_SCAN);
    for (let i = 0; i < limit; i++) {
      analyzeForChecklist(value[i], evidence, `${contextPath}[${i}]`, depth + 1);
    }
    return;
  }

  if (typeof value === "object") {
    for (const key of Object.keys(value)) {
      const nextPath = contextPath ? `${contextPath}.${key}` : key;
      scanPatternsForText(evidence, nextPath, nextPath);
      analyzeForChecklist(value[key], evidence, nextPath, depth + 1);
    }
    return;
  }

  if (
    typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
  ) {
    scanPatternsForText(evidence, String(value), `${contextPath}=${String(value)}`);
  }
}

function summarizeArtifact(file, rowContext = null, scope = null) {
  const absPath = normalizeArtifactPath(file);
  const relative = absPath ? safeRelative(absPath) : String(file || "");

  if (!absPath) {
    return {
      path: relative,
      exists: false,
      parsed: false,
      error: "invalid-path",
      coverage: mkBlankEvidence(),
      signals: blankSignals(),
      generatedAt: null,
      topLevel: {},
    };
  }

  if (!fs.existsSync(absPath)) {
    return {
      path: relative,
      exists: false,
      parsed: false,
      error: "missing",
      coverage: mkBlankEvidence(),
      signals: blankSignals(),
      generatedAt: null,
      topLevel: {},
    };
  }

  if (path.extname(absPath).toLowerCase() !== ".json") {
    const text = readText(absPath, "");
    const evidence = mkBlankEvidence();
    scanPatternsForText(evidence, path.basename(absPath), path.basename(absPath));
    scanPatternsForText(evidence, text.slice(0, 12000), `${path.basename(absPath)}:text`);
    return {
      path: relative,
      exists: true,
      parsed: true,
      nonJson: true,
      generatedAt: null,
      topLevel: {
        keys: [],
        summaryKeys: 0,
        topRows: 0,
        itemCount: null,
        contentType: "text",
      },
      coverage: evidence,
      signals: blankSignals(),
    };
  }

  const artifact = readJson(absPath, null);
  if (artifact === null) {
    return {
      path: relative,
      exists: true,
      parsed: false,
      error: "invalid-json",
      coverage: mkBlankEvidence(),
      signals: blankSignals(),
      generatedAt: null,
      topLevel: {},
    };
  }

  const evidence = mkBlankEvidence();
  const isGapFillBatch = isGapFillBatchFile(absPath);
  const scopedArtifact = isGapFillBatch ? selectGapFillArtifactScope(artifact, rowContext, scope) : artifact;
  if (scopedArtifact === null) {
    return {
      path: relative,
      exists: true,
      parsed: true,
      generatedAt: artifact.generatedAt || null,
      topLevel: {
        keys: Object.keys(artifact).slice(0, 40),
        summaryKeys: 0,
        topRows: 0,
        itemCount: null,
        contentType: "json",
      },
      coverage: mkBlankEvidence(),
      signals: blankSignals(),
    };
  }

  analyzeForChecklist(scopedArtifact, evidence, path.basename(absPath));

  const summary = artifact.summary || artifact.meta || artifact.resultSummary || {};
  const summaryKeys = Array.isArray(summary) ? summary.length : (typeof summary === "object" && summary ? Object.keys(summary).length : 0);
  const topRows = Array.isArray(artifact.topRows)
    ? artifact.topRows.length
    : Array.isArray(artifact.rows)
      ? artifact.rows.length
      : 0;

  return {
    path: relative,
    exists: true,
    parsed: true,
    generatedAt: artifact.generatedAt || null,
    topLevel: {
      keys: Object.keys(artifact).slice(0, 40),
      summaryKeys,
      topRows,
      itemCount: Array.isArray(artifact.rows)
        ? artifact.rows.length
        : Array.isArray(artifact.topRows)
          ? artifact.topRows.length
          : null,
    },
    coverage: evidence,
    signals: extractSignals(artifact),
  };
}

function normalizeArtifactSummaryInput(entry) {
  if (!entry) return null;
  if (typeof entry === "string") return entry.trim();
  if (typeof entry === "object") {
    return (typeof entry.path === "string" ? entry.path : typeof entry.file === "string" ? entry.file : null);
  }
  return null;
}

function mergeSignals(artifacts) {
  const out = blankSignals();
  for (const artifact of artifacts || []) {
    const sig = artifact.signals || blankSignals();
    for (const key of ["routePositive", "executableNow", "signedActionJustified", "watchCandidates", "exactEconomicsRows", "forkProofRows", "consumerJoinRows"]) {
      out[key] = Math.max(out[key] || 0, asNumber(sig[key]) || 0);
    }
    out.rpcBlocked = Boolean(out.rpcBlocked || sig.rpcBlocked);
  }
  return out;
}

function mergeEvidence(items) {
  const merged = mkBlankEvidence();
  for (const artifact of items) {
    if (!artifact || !artifact.parsed || !artifact.coverage) continue;
    for (const key of CHECKLIST_KEYS) {
      const target = merged[key];
      const source = artifact.coverage[key] || { covered: false, score: 0, samples: [] };
      if (source.covered) {
        target.covered = true;
        target.score += source.score;
        for (const sample of source.samples || []) {
          if (target.samples.length >= 4) break;
          if (sample) target.samples.push(sample);
        }
      }
    }
  }
  return merged;
}

function flattenReason(list) {
  const out = new Set();
  for (const item of list || []) {
    const text = String(item || "").trim();
    if (!text) continue;
    out.add(text);
  }
  return Array.from(out);
}

function hasAllEvidence(evidence, requiredKeys) {
  return requiredKeys.every((key) => Boolean(evidence[key] && evidence[key].covered));
}

function analyzeRow(row, gapFillArtifactsByRow = {}) {
  const rank = asNumber(row.rank) != null ? asNumber(row.rank) : null;
  const priority = asNumber(row.priorityScore) != null ? asNumber(row.priorityScore) : 0;

  const declared = {
    routePositive: asBoolean(row.routePositive),
    executableNow: asBoolean(row.executableNow),
    signedActionJustified: asBoolean(row.signedActionJustified),
  };

  const rowArtifactRefs = dedupeArtifacts(
    (Array.isArray(row.sourceArtifacts) ? row.sourceArtifacts : [])
      .concat(Array.from((gapFillArtifactsByRow[row.id] || [])).map((artifact) => ({ path: artifact, scope: null })))
      .concat(Array.from((row.missingChecklistItems || [])).flatMap((category) => {
        const scoped = Array.from((gapFillArtifactsByRow[`${row.id}::${category}`] || []));
        return scoped.map((artifact) => ({ path: artifact, scope: category }));
      })),
  );

  const sourceArtifacts = rowArtifactRefs
    .map((entry) => {
      const file = normalizeArtifactSummaryInput(entry);
      return summarizeArtifact(file, row, entry && typeof entry === "object" ? (entry.scope || null) : null);
    })
    .filter(Boolean);
  const evidence = mergeEvidence(sourceArtifacts);
  const artifactSignals = mergeSignals(sourceArtifacts);
  const missingEvidence = CHECKLIST_KEYS.filter((key) => !evidence[key].covered);

  const rowChecklist = {
    covered: CHECKLIST_KEYS.filter((key) => evidence[key].covered),
    missing: missingEvidence,
    coveragePercent: round(
      (CHECKLIST_KEYS.filter((key) => evidence[key].covered).length / CHECKLIST_KEYS.length) * 100,
      2,
    ),
    details: evidence,
  };

  const failReasons = [];
  const effective = { ...declared };

  const parseFailures = sourceArtifacts.filter((artifact) => !artifact.parsed && artifact.error === "invalid-json");
  const missingArtifacts = sourceArtifacts.filter((artifact) => artifact.error === "missing" || artifact.error === "invalid-path");
  const nonJsonArtifacts = sourceArtifacts.filter((artifact) => artifact.nonJson);
  const staleArtifacts = sourceArtifacts.filter((artifact) => {
    const age = artifactAgeHours(artifact.generatedAt);
    return age !== null && age > 72;
  });
  if (!rowArtifactRefs.length) {
    if (effective.routePositive) failReasons.push("No sourceArtifacts listed for route-positive row.");
    if (effective.executableNow) failReasons.push("No sourceArtifacts listed for executable row.");
    if (effective.signedActionJustified) failReasons.push("No sourceArtifacts listed for signed-action-justified row.");
  }

  if (parseFailures.length > 0) {
    const missing = parseFailures.map((artifact) => artifact.path).filter(Boolean).join(", ");
    if (missing) {
      if (effective.routePositive) failReasons.push(`Failed to parse source artifact(s): ${missing}`);
      if (effective.executableNow) failReasons.push(`Failed to parse source artifact(s): ${missing}`);
      if (effective.signedActionJustified) failReasons.push(`Failed to parse source artifact(s): ${missing}`);
    }
  }

  if (declared.routePositive && !hasAllEvidence(evidence, FLAG_REQUIREMENTS.routePositive)) {
    const missing = FLAG_REQUIREMENTS.routePositive.filter((key) => !evidence[key].covered);
    failReasons.push(`Missing required open-route evidence: ${missing.join(", ")}.`);
    effective.routePositive = false;
  }

  if (declared.executableNow && !declared.routePositive) {
    failReasons.push("executableNow declared without route-positive declaration.");
    effective.executableNow = false;
  }

  if (declared.executableNow && !hasAllEvidence(evidence, FLAG_REQUIREMENTS.executableNow)) {
    const missing = FLAG_REQUIREMENTS.executableNow.filter((key) => !evidence[key].covered);
    failReasons.push(`Missing required execution evidence: ${missing.join(", ")}.`);
    effective.executableNow = false;
  }

  if (declared.signedActionJustified && !declared.executableNow && !declared.routePositive) {
    failReasons.push("signedActionJustified declared without executable-now/route-positive declaration.");
    effective.signedActionJustified = false;
  }

  if (declared.signedActionJustified && !hasAllEvidence(evidence, FLAG_REQUIREMENTS.signedActionJustified)) {
    const missing = FLAG_REQUIREMENTS.signedActionJustified.filter((key) => !evidence[key].covered);
    failReasons.push(`Missing required signed-action evidence: ${missing.join(", ")}.`);
    effective.signedActionJustified = false;
  }

  if (declared.routePositive && (!Array.isArray(row.requiredForRoutePositive) || row.requiredForRoutePositive.length === 0)) {
    failReasons.push("missing requiredForRoutePositive list; fail-closed route-positive flag.");
    effective.routePositive = false;
  }

  if (declared.routePositive && !row.nextReadOnlyStep) {
    failReasons.push("missing nextReadOnlyStep; fail-closed route-positive/executable classification.");
    effective.routePositive = false;
  }

  if (parseFailures.length > 0 && (effective.routePositive || effective.executableNow || effective.signedActionJustified)) {
    effective.routePositive = false;
    effective.executableNow = false;
    effective.signedActionJustified = false;
  }

  const uniqueFailReasons = flattenReason(failReasons);

  const exactEconomicsRows = Math.max(
    asNumber(row.distance?.exactEconomicsRows) || 0,
    asNumber(row.distance?.quoteRows) || 0,
    asNumber(row.distance?.rowsWithAnyQuote) || 0,
    asNumber(row.economics?.exactEconomicsRows) || 0,
    artifactSignals.exactEconomicsRows || 0,
  );
  const forkProofRows = Math.max(
    asNumber(row.distance?.forkProofRows) || 0,
    asNumber(row.economics?.forkProofRows) || 0,
    artifactSignals.forkProofRows || 0,
  );
  const watchCandidates = Math.max(
    asNumber(row.distance?.watchCandidates) || 0,
    artifactSignals.watchCandidates || 0,
  );
  const rowText = `${row.status || ""} ${(row.blockers || []).join(" ")} ${row.nextReadOnlyStep || ""}`;
  const rpcBlocked = Boolean(artifactSignals.rpcBlocked || /rpc[-\s]?blocked|required endpoint|endpoint unavailable|missing rpc|rpc unavailable|not publicly accessible/i.test(rowText));
  const reviewNeeded = Boolean(
    effective.routePositive
    || effective.executableNow
    || effective.signedActionJustified
    || uniqueFailReasons.length
    || rowChecklist.coveragePercent < 80
    || parseFailures.length
    || missingArtifacts.length
  );
  const forkQueue = Boolean(effective.routePositive && exactEconomicsRows > 0 && forkProofRows === 0);
  const finalClassification = effective.signedActionJustified
    ? "signed-action-gate-open-needs-authorization"
    : effective.executableNow
      ? "executable-now-needs-final-gates"
      : effective.routePositive
        ? "route-positive-needs-fork-proof"
        : rpcBlocked || missingArtifacts.length
          ? "blocked-needs-data"
          : rowChecklist.coveragePercent < 80
            ? "watch-only-partial-full-test"
            : "watch-only-route-negative";

  return {
    rank,
    id: row.id || `missing-id-rank-${rank}`,
    protocol: row.protocol || null,
    chain: row.chain || null,
    surface: row.surface || null,
    status: row.status || null,
    priorityScore: priority,
    forkGate: row.forkGate || null,
    routePositive: row.routePositive ?? null,
    executableNow: row.executableNow ?? null,
    signedActionJustified: row.signedActionJustified ?? null,
    declaredFlags: declared,
    effectiveFlags: effective,
    finalClassification,
    reviewNeeded,
    forkQueue,
    rpcBlocked,
    staleOrMissingArtifacts: [...staleArtifacts, ...missingArtifacts].map((artifact) => artifact.path),
    sourceArtifactsMissing: missingArtifacts.map((artifact) => artifact.path),
    sourceArtifactErrors: parseFailures.map((artifact) => ({ path: artifact.path, error: artifact.error })),
    sourceArtifactsNonJson: nonJsonArtifacts.map((artifact) => artifact.path),
    missingChecklistItems: rowChecklist.missing,
    watchCandidates,
    exactEconomicsRows,
    forkProofRows,
    failClosed: {
      reasons: uniqueFailReasons,
      triggered: uniqueFailReasons.length > 0,
    },
    requiredForRoutePositive: flattenReason(row.requiredForRoutePositive),
    nextReadOnlyStep: row.nextReadOnlyStep || null,
    blockers: flattenReason(row.blockers),
    sourceArtifacts: sourceArtifacts.map((artifact) => ({
      path: artifact.path,
      exists: artifact.exists,
      parsed: artifact.parsed,
      nonJson: Boolean(artifact.nonJson),
      generatedAt: artifact.generatedAt || null,
      error: artifact.error || null,
      topLevel: artifact.topLevel,
    })),
    summary: {
      distanceRows: Array.isArray(row.topRows) ? row.topRows.length : 0,
      routePositiveInDistance: asNumber(row.distance?.routePositive) || 0,
      watchCandidates: asNumber(row.distance?.watchCandidates) || 0,
      rowsWithQuote: asNumber(row.distance?.quoteRows || row.distance?.rowsWithAnyQuote) || 0,
      bestNetUsd: asNumber(row.economics?.bestNetProfitUsd || row.economics?.bestNetUsd || row.distance?.bestNetUsd),
      bestGapToPositiveUsd: asNumber(row.economics?.bestNetGapToPositiveUsd || row.distance?.bestNetGapToPositiveUsd),
      consumerJoinRows: Math.max(asNumber(row.distance?.consumerJoinRows) || 0, artifactSignals.consumerJoinRows || 0),
    },
    checklist: {
      covered: rowChecklist.covered,
      missing: rowChecklist.missing,
      coveragePercent: rowChecklist.coveragePercent,
      evidence: rowChecklist.details,
    },
    sourceArtifactsCount: rowArtifactRefs.length,
    parseFailed: parseFailures.length,
    missingArtifacts: missingArtifacts.length,
  };
}

function round(value, decimals = 2) {
  const numeric = asNumber(value);
  if (numeric === null) return null;
  const factor = 10 ** decimals;
  return Math.round(numeric * factor) / factor;
}

function markdownTable(rows, headers) {
  const line = (row) => headers.map((header) => String(row[header] ?? "").replace(/\r?\n/g, " ")).join(" | ");
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${line(row)} |`),
  ].join("\n");
}

function renderReport(payload) {
  const { source, summary, rows } = payload;
  const effectiveOpen = summary.effectiveFlagsSummary.routePositive + summary.effectiveFlagsSummary.executableNow + summary.effectiveFlagsSummary.signedActionJustified;
  const failClosedRows = rows.filter((row) => row.failClosed.triggered);
  const openRows = rows.filter((row) => row.effectiveFlags.routePositive || row.effectiveFlags.executableNow || row.effectiveFlags.signedActionJustified);
  const reviewRows = rows.filter((row) => row.reviewNeeded);

  const heading = effectiveOpen > 0
    ? "# ⚠️ FULL-TEST ROWS OPEN (FAIL-CLOSED CHECK)"
    : "# 🟢 DORMANT - Top-100 Full-Test Readiness Scan";

  const topRows = rows.slice(0, 25).map((row) => ({
    Rank: row.rank,
    Surface: row.surface || row.protocol || "",
    Status: row.status || "",
    "Route+": markdownBool(row.effectiveFlags.routePositive),
    "Exec+": markdownBool(row.effectiveFlags.executableNow),
    "Signed+": markdownBool(row.effectiveFlags.signedActionJustified),
    "Checklist": `${row.checklist.coveragePercent.toFixed(2)}%`,
    "Closed": markdownBool(!row.failClosed.triggered),
  }));

  const catRows = CHECKLIST_KEYS.map((key) => ({
    Category: CHECKLIST[key].label,
    CoveredRows: payload.categorySummary[key].covered,
    TotalRows: payload.categorySummary[key].total,
  }));

  const catTable = markdownTable(catRows, ["Category", "CoveredRows", "TotalRows"]);
  const rowTable = markdownTable(topRows, ["Rank", "Surface", "Status", "Route+", "Exec+", "Signed+", "Checklist", "Closed"]);

  const lines = [];
  lines.push(heading);
  lines.push("");
  lines.push(`Date: ${payload.generatedAt.slice(0, 10)}`);
  lines.push("");
  lines.push("## Result");
  lines.push("");
  lines.push(`Top rows analyzed: ${summary.rowsAnalyzed}.`);
  lines.push(`Source: ${safeRelative(ROUTE_SWEEP)}.`);
  lines.push(`Effective route-positive: ${summary.effectiveFlagsSummary.routePositive}.`);
  lines.push(`Effective executable-now: ${summary.effectiveFlagsSummary.executableNow}.`);
  lines.push(`Effective signed-action-justified: ${summary.effectiveFlagsSummary.signedActionJustified}.`);
  lines.push(`Fail-closed rows: ${failClosedRows.length}.`);
  lines.push(`Review queue rows: ${reviewRows.length}.`);
  lines.push(`Source artifact JSON errors: ${summary.sourceArtifactErrors}.`);
  lines.push(`Non-JSON report references: ${summary.sourceArtifactsNonJson}.`);
  lines.push("");
  lines.push("Safety scope: artifact-only scan; no RPC/env/key reads; no fork/signed actions.");
  lines.push("");
  lines.push("## Route-positive / executable / signed effective state");
  lines.push("");
  lines.push(openRows.length
    ? `${openRows.length} row(s) currently remain open after evidence verification.`
    : "No rows remain open after evidence verification. Report is `DORMANT` (fail-closed).");
  lines.push("");

  lines.push("## Top rows");
  lines.push("");
  lines.push(rowTable);
  lines.push("");

  lines.push("## Checklist coverage by category (top 100)");
  lines.push("");
  lines.push(catTable);
  lines.push("");

  lines.push("## Fail-closed reasons");
  lines.push("");
  if (!failClosedRows.length) {
    lines.push("No top-100 row had hard fail-closed reasons.");
  } else {
    for (const row of failClosedRows.slice(0, 20)) {
      lines.push(`- Rank ${row.rank} ${row.id}:`);
      for (const reason of row.failClosed.reasons.slice(0, 6)) {
        lines.push(`  - ${reason}`);
      }
    }
  }

  lines.push("");
  lines.push("## Review queue / partial rows");
  lines.push("");
  if (!reviewRows.length) {
    lines.push("No top-100 row requires immediate reviewer escalation from artifact-only evidence.");
  } else {
    for (const row of reviewRows.slice(0, 20)) {
      lines.push(`- Rank ${row.rank} ${row.id}: ${row.finalClassification}; checklist ${row.checklist.coveragePercent.toFixed(2)}%; missing ${row.missingChecklistItems.slice(0, 8).join(", ") || "none"}`);
    }
  }

  lines.push("");
  lines.push("## Sources");
  lines.push("");
  lines.push(`- Raw: \`${safeRelative(OUT_RAW)}\``);
  lines.push(`- Route sweep source: \`${safeRelative(source.routeSweep)}\``);
  if (Array.isArray(source.gapFillBatches) && source.gapFillBatches.length) {
    for (const batch of source.gapFillBatches) {
      lines.push(`- Gap-fill batch: \`${batch}\``);
    }
  }
  if (rows.length) {
    lines.push("");
    lines.push("## Next read-only step");
    lines.push("");
    const best = rows.find((row) => row.nextReadOnlyStep) || null;
    lines.push(best
      ? `Prioritize rank ${best.rank} (${best.id}): ${best.nextReadOnlyStep}`
      : "No explicit read-only next step is present in analyzed rows.");
  }

  return lines.join("\n");
}

function categorySummary(rows) {
  const out = {};
  for (const key of CHECKLIST_KEYS) {
    out[key] = { total: rows.length, covered: 0 };
  }
  for (const row of rows) {
    const covered = new Set(row.checklist.covered);
    for (const key of CHECKLIST_KEYS) {
      if (covered.has(key)) out[key].covered += 1;
    }
  }
  return out;
}

function main() {
  const sweep = readJson(ROUTE_SWEEP, {});
  const gapFill = loadGapFillBatchArtifacts();
  const gapFillArtifactByRow = gapFill.byRowId;
  const gapFillBatchFiles = gapFill.files;
  const rows = extractRows(sweep).map((row) => row || {});
  const limit = Number.isFinite(TOP_LIMIT) && TOP_LIMIT > 0 ? Math.min(1000, TOP_LIMIT) : 100;

  const topRows = pickTopByRank(rows, limit);
  const analyzedRows = topRows.map((row) => analyzeRow(row, gapFillArtifactByRow));

  const catSummary = categorySummary(analyzedRows);
  const summary = {
    sourceGeneratedAt: sweep.generatedAt || null,
    rowsAvailable: rows.length,
    rowsRequested: limit,
    rowsAnalyzed: analyzedRows.length,
    effectiveFlagsSummary: {
      routePositive: analyzedRows.reduce((acc, row) => acc + (row.effectiveFlags.routePositive ? 1 : 0), 0),
      executableNow: analyzedRows.reduce((acc, row) => acc + (row.effectiveFlags.executableNow ? 1 : 0), 0),
      signedActionJustified: analyzedRows.reduce((acc, row) => acc + (row.effectiveFlags.signedActionJustified ? 1 : 0), 0),
    },
    declaredFlagsSummary: {
      routePositive: analyzedRows.reduce((acc, row) => acc + (row.declaredFlags.routePositive ? 1 : 0), 0),
      executableNow: analyzedRows.reduce((acc, row) => acc + (row.declaredFlags.executableNow ? 1 : 0), 0),
      signedActionJustified: analyzedRows.reduce((acc, row) => acc + (row.declaredFlags.signedActionJustified ? 1 : 0), 0),
    },
    failClosedRows: analyzedRows.reduce((acc, row) => acc + (row.failClosed.triggered ? 1 : 0), 0),
    sourceArtifactErrors: analyzedRows.reduce((acc, row) => acc + (row.parseFailed || 0), 0),
    sourceArtifactsMissing: analyzedRows.reduce((acc, row) => acc + (row.missingArtifacts || 0), 0),
    sourceArtifactsNonJson: analyzedRows.reduce((acc, row) => acc + (row.sourceArtifactsNonJson?.length || 0), 0),
    rpcBlockedRows: analyzedRows.reduce((acc, row) => acc + (row.rpcBlocked ? 1 : 0), 0),
    reviewQueue: analyzedRows.reduce((acc, row) => acc + (row.reviewNeeded ? 1 : 0), 0),
    forkQueue: analyzedRows.reduce((acc, row) => acc + (row.forkQueue ? 1 : 0), 0),
    watchRows: analyzedRows.reduce((acc, row) => acc + (row.watchCandidates > 0 ? 1 : 0), 0),
    exactEconomicsRows: analyzedRows.reduce((acc, row) => acc + (row.exactEconomicsRows || 0), 0),
    forkProofRows: analyzedRows.reduce((acc, row) => acc + (row.forkProofRows || 0), 0),
    fullEnough: analyzedRows.reduce((acc, row) => acc + (row.finalClassification === "watch-only-route-negative" ? 1 : 0), 0),
    partial: analyzedRows.reduce((acc, row) => acc + (row.finalClassification === "watch-only-partial-full-test" ? 1 : 0), 0),
    blocked: analyzedRows.reduce((acc, row) => acc + (row.finalClassification === "blocked-needs-data" ? 1 : 0), 0),
    routeSweepRows: Array.isArray(sweep.ranked) ? sweep.ranked.length : 0,
    routeSweepRoutePositive: asNumber(sweep.summary?.routePositive) || 0,
    gapFillBatchesLoaded: gapFillBatchFiles.length,
    gapFillBatches: gapFillBatchFiles.map(safeRelative),
  };

  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-top100-full-test.js",
    scope: "Artifact-only top-100 full-test scanner with fail-closed route/executable/signed gate checks",
    safety: {
      rpcInventoryRead: false,
      rpcUrlsStored: false,
      envFilesRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: summary.effectiveFlagsSummary.routePositive > 0,
      executableNow: summary.effectiveFlagsSummary.executableNow > 0,
      signedActionJustified: summary.effectiveFlagsSummary.signedActionJustified > 0,
    },
    source: {
      routeSweep: safeRelative(ROUTE_SWEEP),
      rawOut: safeRelative(OUT_RAW),
      gapFillBatches: gapFillBatchFiles.map(safeRelative),
    },
    summary,
    categorySummary: catSummary,
    rows: analyzedRows,
    targets: analyzedRows,
  };

  fs.mkdirSync(path.dirname(OUT_RAW), { recursive: true });
  fs.writeFileSync(OUT_RAW, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  fs.writeFileSync(OUT_REPORT, renderReport(out), "utf8");

  if (!QUIET) {
    console.log(`Top-100 full-test scan written: ${safeRelative(OUT_RAW)} and ${safeRelative(OUT_REPORT)}`);
    console.log(`rowsAnalyzed=${summary.rowsAnalyzed} effectiveFlags: routePositive=${summary.effectiveFlagsSummary.routePositive}, executable=${summary.effectiveFlagsSummary.executableNow}, signedAction=${summary.effectiveFlagsSummary.signedActionJustified}`);
    console.log(`failClosedRows=${summary.failClosedRows} sourceArtifactErrors=${summary.sourceArtifactErrors}`);
  }
}

main();
