#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  assertSanitized, sanitizedFailure, baseQualify, commonPinForPair, selectStage1Pair,
  adaptiveLogRanges, validateArtifactPresence, stable
} = require("./capture-spark-alm-mainnet-staging-otcbuffer-gate0-r2.js");

let checks = 0;
function ok(v, m) { checks++; assert.ok(v, m); }
async function rejects(fn, pattern, m) { checks++; await assert.rejects(fn, pattern, m); }
const hash = n => `0x${n.toString(16).padStart(64, "0")}`;
const pin = n => ({ number: String(n), hash: hash(n), stateRoot: hash(n + 1000), timestamp: String(1700000000 + n), parentHash: hash(n - 1) });
const candidate = (family, id) => ({ family, id });
const baseAdapter = {
  async chainId() { return 1n; }, async finalized(c) { return pin(c.id === "late" ? 105 : 100); }
};

(async () => {
  // Block-hash-form logs are deliberately unsupported; minimal Stage1 never calls logs.
  {
    let logCalls = 0;
    const adapter = { ...baseAdapter,
      async headerByNumber(_c, n) { return pin(Number(n)); },
      async material() { return { roots: 5, authorization: true }; },
      async terminal(_c, p) { return { pin: p.hash }; },
      async logs() { logCalls++; throw new Error("unsupported"); }
    };
    const base = await baseQualify([candidate("a.test", "a"), candidate("b.test", "b")], adapter, { attemptsPerFamily: 2, families: 4 });
    const selected = await selectStage1Pair(base, adapter, { pairAttempts: 4 });
    ok(selected.pin.hash === pin(100).hash && logCalls === 0, "Stage1 succeeds without block-hash logs");
  }

  // Adaptive history retries a rejected 20k request with smaller complete chunks.
  {
    let rejected = 0;
    const scan = await adaptiveLogRanges(1n, 20000n, async (a, z) => {
      if (z - a + 1n > 5000n) { rejected++; throw new Error("range cap"); }
      return [{ from: a.toString(), to: z.toString() }];
    }, 20000n, 250n, 32);
    ok(rejected >= 2, "large chunks rejected");
    ok(scan.complete && scan.intervals[0].fromBlock === "1" && scan.intervals.at(-1).toBlock === "20000", "adaptive union complete");
    for (let i = 1; i < scan.intervals.length; i++) ok(BigInt(scan.intervals[i].fromBlock) === BigInt(scan.intervals[i - 1].toBlock) + 1n, "adaptive intervals contiguous");
  }

  // Partial capability accounting remains separate from base-family qualification.
  {
    const rows = [candidate("a.test", "a"), candidate("b.test", "b"), candidate("c.test", "c")];
    const adapter = { ...baseAdapter,
      async headerByNumber(_c, n) { return pin(Number(n)); },
      async material(c) { if (c.id === "b") throw Object.assign(new Error("eip1898"), { code: "EIP1898" }); return { roots: 5 }; },
      async terminal(_c, p) { return { pin: p.hash }; }
    };
    const base = await baseQualify(rows, adapter, { attemptsPerFamily: 2, families: 4 });
    const selected = await selectStage1Pair(base, adapter, { pairAttempts: 6 });
    ok(base.accounting.baseQualifiedFamilies === 3, "three base-qualified families counted");
    ok(selected.accounting.stage1QualifiedFamilies === 2, "only successful Stage1 families counted");
    ok(selected.accounting.pairAttempts === 2, "failed pair retained in accounting");
  }

  // Common finalized pin uses floor/backoff and exact header equality.
  {
    const a = { candidate: candidate("a.test", "late"), finalized: pin(105) }, z = { candidate: candidate("b.test", "b"), finalized: pin(100) };
    const p = await commonPinForPair(a, z, { async headerByNumber(_c, n) { return pin(Number(n)); } });
    ok(p.number === "100" && p.hash === pin(100).hash, "common floor pin");
  }

  // Sanitized failure JSON is structured and never includes thrown text/provider material.
  {
    const f = sanitizedFailure("TIMEOUT", "STAGE1", { attempts: 2 });
    ok(stable(f) === stable({ result: "FAIL", failureClass: "TIMEOUT", stage: "STAGE1", attempts: 2 }), "sanitized failure shape");
    ok(!JSON.stringify(f).includes("provider-secret"), "failure omits raw detail");
    const unknown = sanitizedFailure("bad detail with spaces", "STAGE1");
    ok(unknown.failureClass === "UNEXPECTED_FAILURE", "invalid failure class normalized");
    assertSanitized(f, ["provider-secret"]); checks++;
  }

  // Family cap is charged only for a new family, allowing candidate two in family A.
  {
    const attempted = [];
    const adapter = { async chainId(c) { attempted.push(c.id); if (c.id === "a1") throw new Error("down"); return 1n; }, async finalized() { return pin(100); } };
    const base = await baseQualify([candidate("a.test", "a1"), candidate("a.test", "a2"), candidate("b.test", "b1")], adapter, { attemptsPerFamily: 2, families: 1 });
    ok(stable(attempted) === stable(["a1", "a2"]), "second existing-family candidate attempted at cap");
    ok(base.accounting.newFamiliesAdmitted === 1 && base.accounting.baseQualifiedCandidates === 1, "family cap accounting corrected");
  }

  // Published values reject provider material and URLs.
  {
    ok(assertSanitized({ family: "family-A", result: "PASS" }, ["provider-secret"]), "anonymous artifact accepted");
    checks++; assert.throws(() => assertSanitized({ value: "provider-secret" }, ["provider-secret"]), /PROVIDER_MATERIAL/);
    checks++; assert.throws(() => assertSanitized({ value: "https://example.invalid" }, []), /URL_REJECTED/);
  }

  // ERC1967Proxy artifact is an explicit build preflight gate.
  {
    const artifact = { deployedBytecode: { object: "00" } }, set = { OTCBuffer: artifact, MainnetController: artifact, ALMProxy: artifact, RateLimits: artifact, ERC1967Proxy: artifact };
    ok(validateArtifactPresence(set), "complete artifact set passes");
    const missing = { ...set }; delete missing.ERC1967Proxy;
    await rejects(async () => validateArtifactPresence(missing), /ERC1967PROXY_ARTIFACT_MISSING/, "missing proxy artifact fails preflight");
  }

  console.log(`PASS ${checks} checks`);
})().catch(e => { console.error(`FAIL ${e.message}`); process.exitCode = 1; });
