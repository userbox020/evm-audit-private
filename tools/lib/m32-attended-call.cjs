"use strict";

// Attended trusted-host Stage2 only. No IO on import/no arguments; no automatic
// recovery, public fallback, CREATE authority reuse or generic authority bypass.
const STAGED = "../../staging/executor-readiness-m32-20261026/";
const GRANT_HASH = "77e75abeed6806ada8fb0e3f5c9ffc2bd87f99e14385efc211c8bac7c181f650";
const EXPIRY = "2026-11-02T09:30:00Z", RECORDED = "2026-10-27T02:53:19Z";
const SOURCE = "938b6c765e40b9d983ffc50b99ee65dca218b1bd96771ad8ae05165f67814777";
const NODE = "C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode\\m32-node-v24.13.0-902b80feae4c40eab5376ef15401e2f2\\node.exe";
const TEMP = "C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode";
const ID = "targetM32_Morpho_sUSDe_USDtb", KIND = "m32-attended-call/v1";
const BORROWER = "0xc17a3f83798c8dfe5b6bc4f05825fccf08889c65";
const MARKET = "0x88a18b2f4d94e7ad27a381b15531c06abf05a7c99dd5d3c3679875fed6f7e742";
const HARD_SEIZE = 9612702562092091172663n, GAS = 900000n, FEE_CAP = 1500000000n, TIP = 50000000n;
const DEPLOYMENT_COST = 181964359996876n, REQUEST_LIMIT = 512;
// Each current() reserves up to 20 physical reads: freshness/nonce/canonical 10,
// balance 2, runtime 2, owner 2, explicit latest+pending nonce 4. Seven cycles
// after PREPARED = 140; receipt verification <= 18, eight null polls = 16.
// Immutable runtime/owner caching reduces actual reads, never this reserve.
const CURRENT_READS = 20, RECEIPT_READS = 18, PREPARED_READS = 7 * CURRENT_READS + RECEIPT_READS + 16;
const ownErrors = new WeakSet();
function need(ok, code) { if (!ok) { const e = new Error("M32_CALL_" + code); ownErrors.add(e); throw e; } }
const integration = name => require(STAGED + "integration/" + name + ".cjs");
const identity = () => require("./m32-deployment.js");
const shared = () => require("./wallet-execution-guard.js");
const sha = bytes => require("node:crypto").createHash("sha256").update(bytes).digest("hex");
const wire = v => JSON.stringify(v, (_, x) => typeof x === "bigint" ? x.toString() : x);
const same = (a, b) => require("node:util").isDeepStrictEqual(a, b);
const freeze = v => { if (v && typeof v === "object" && !Buffer.isBuffer(v)) { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
function uint(v) { need(typeof v === "string" && /^(0|[1-9][0-9]{0,77})$/.test(v), "INTEGER_HOLD"); const n = BigInt(v); need(n < 1n << 256n, "INTEGER_HOLD"); return n; }
function paths(root) {
  const path = require("node:path"), d = identity();
  // Stable event identity excludes parent, nonce, amount and mutable run IDs.
  const event = sha(`M32_STAGE2_CALL:1:${d.EXECUTOR}:${BORROWER}:${MARKET}:${GRANT_HASH}`);
  const join = s => path.join(root, s);
  return freeze({ root, event, coordination: join("coordination"), lockRoot: join("coordination/wallet-execution-locks"),
    journalDir: join("reports/raw/fast/aave-v4-v3-morpho-liquidator-execution"),
    grant: join("reports/raw/fast/executor-readiness-m32-20261026/STAGE2-ATTENDED-AUTHORIZATION-20261027.json"),
    registry: join("coordination/live-execution-approvers.json"),
    marker: join(`coordination/m32-attended-call-consumed-${event}.json`),
    journal: join(`reports/raw/fast/aave-v4-v3-morpho-liquidator-execution/m32-call-${event}.json`) });
}
function checkedPath(file) {
  const fs = require("node:fs"), path = require("node:path");
  for (let at = path.resolve(file);;) {
    let stat; try { stat = fs.lstatSync(at); } catch (e) { need(e.code === "ENOENT", "PATH_HOLD"); }
    if (stat) need(!stat.isSymbolicLink() && fs.realpathSync(at).toLowerCase() === at.toLowerCase(), "PATH_HOLD");
    const parent = path.dirname(at); if (parent === at) break; at = parent;
  }
}
function read(file, maximum) {
  const fs = require("node:fs"); checkedPath(file); const fd = fs.openSync(file, "r");
  try {
    const before = fs.fstatSync(fd); need(before.isFile() && before.size > 0 && before.size <= maximum, "MATERIAL_SIZE_HOLD");
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) { const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); need(n > 0, "MATERIAL_CHANGED"); offset += n; }
    const after = fs.fstatSync(fd); need(before.size === after.size && before.mtimeMs === after.mtimeMs, "MATERIAL_CHANGED"); return bytes;
  } finally { fs.closeSync(fd); }
}
function grant(bytes, pin, now) {
  need(sha(bytes) === pin, "GRANT_PIN_HOLD"); const g = JSON.parse(bytes), d = identity(), e = require(STAGED + "proof/m32-live-evidence.cjs");
  need(g.schema === "m32-attended-stage2-conversation-authorization/v1" && g.status === "USER_AUTHORIZED_M32_CONTINUATION_BOUNDED_STAGE2" &&
    g.notMachineAttestation === true && g.liveDispatchAllowed === false && g.trustBoundary === "ATTENDED_TRUSTED_WINDOWS_HOST_AND_COOPERATING_LOCAL_PROCESSES" &&
    g.hostileLocalWriterIsolationProvided === false && g.chainId === 1 && g.chain === "ethereum" && g.account === d.OWNER && g.owner === d.OWNER &&
    g.executor === d.EXECUTOR && g.contract === d.CONTRACT_NAME && g.runtimeKeccak256 === d.RUNTIME_KECCAK256 && g.sourceSha256 === SOURCE &&
    g.deploymentTransactionHash === d.DEPLOYMENT_TX && g.recordedAt === RECORDED && g.expiresAt === EXPIRY && now >= Date.parse(RECORDED) && now < Date.parse(EXPIRY) &&
    same(g.targets, { morphoBlue: e.MORPHO, borrower: BORROWER, marketId: MARKET, curveRouterNg: e.CURVE_ROUTER_NG,
      routePools: [e.POOL_SUSDE_CRVUSD, e.POOL_USDC_CRVUSD, e.POOL_USDC_USDTB] }) &&
    same(g.caps, { valueWei: "0", ownerTokenPrincipalSpendRaw: "0", gasLimit: "900000", maxFeePerGasWei: "1500000000", maxPriorityFeePerGasWei: "300000000",
      maxGasReservationWei: "1350000000000000", maxSlippageBps: 50, maxSeizeRaw: HARD_SEIZE.toString(),
      maxRepayPolicy: "NO_MORE_THAN_AUTHENTICATED_PROJECTED_FULL_BORROWER_DEBT_AT_THE_BOUND_CHILD", repaymentBufferRaw: "0", minimumRetainedUsdTbRaw: "1",
      maxExecutions: 1, maxPhysicalSubmissionAttempts: 1 }) &&
    same(g.delivery, { method: "eth_sendBundle", privateOnly: true, exactOneBlockWindow: true, publicFallback: false, directCoinbasePaymentWei: "0", revertingTxHashes: [] }), "GRANT_SCOPE_HOLD");
  return g;
}
function materials(c, now) {
  const grantBytes = read(c.paths.grant, 32768), registryBytes = read(c.paths.registry, 65536);
  grant(grantBytes, c.grantHash, now); need("0x" + sha(registryBytes) === c.registryHash, "REGISTRY_PIN_HOLD");
  const r = JSON.parse(registryBytes), crypto = require("node:crypto"), ids = new Set(), keys = new Set();
  need(r.schema === "live-execution-approver-registry/v1" && Array.isArray(r.approvers) && r.approvers.length > 0 && r.approvers.length <= 32, "REGISTRY_HOLD");
  for (const row of r.approvers) {
    const der = Buffer.from(row.publicKeySpkiDerBase64, "base64"), key = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
    need(row.algorithm === "Ed25519" && key.asymmetricKeyType === "ed25519" && key.export({ format: "der", type: "spki" }).equals(der) &&
      der.toString("base64") === row.publicKeySpkiDerBase64 && !ids.has(row.approverId) && !keys.has(row.publicKeySpkiDerBase64), "REGISTRY_HOLD");
    ids.add(row.approverId); keys.add(row.publicKeySpkiDerBase64);
  }
  need(ids.has("windows-local-approver-20260912-01"), "REGISTRY_HOLD"); return { grantBytes, registryBytes };
}
function names(dir) { checkedPath(dir); try { return require("node:fs").readdirSync(dir); } catch (e) { need(e.code === "ENOENT", "STATE_HOLD"); return []; } }
function journals(c, record) {
  const path = require("node:path");
  // Completed Stage1 CREATE and its immutable consumed marker are distinct.
  // All Stage2 remnants, including partial writes and unsigned aborts, hold.
  for (const name of names(c.paths.coordination)) if (/^m32-(?:call-|stage2-|attended-call-)/i.test(name))
    need(record && name === path.basename(c.paths.marker), "ATTEMPT_OR_REVOCATION_HOLD");
  for (const name of names(c.paths.journalDir)) {
    need(!name.endsWith(".tmp") && (!/^m32-(?:call-|stage2-|attended-call-)/i.test(name) || record && name === path.basename(c.paths.journal)), "JOURNAL_REMNANT_HOLD");
    checkedPath(path.join(c.paths.journalDir, name));
  }
  const rows = shared().readJournals(c.paths.journalDir, identity().OWNER, 1);
  for (const row of rows) {
    if (record && row.file === c.paths.journal) { need(same(row.record, record), "JOURNAL_OWNERSHIP_HOLD"); continue; }
    const r = row.record, i = r.intent;
    need(!["PREPARED", "SENT", "UNCERTAIN"].includes(r.stage), "WALLET_PENDING_HOLD");
    need(r.kind !== KIND && i?.targetId !== ID && i?.m32CallEventKey !== c.paths.event &&
      !(i?.to?.toLowerCase() === identity().EXECUTOR || i?.executor?.toLowerCase() === identity().EXECUTOR), "ALREADY_ATTEMPTED");
  }
  if (record) need(rows.some(row => row.file === c.paths.journal), "JOURNAL_OWNERSHIP_HOLD");
}
function createDurable(file, value, before) {
  const fs = require("node:fs"), path = require("node:path"); checkedPath(file); fs.mkdirSync(path.dirname(file), { recursive: true });
  before(); const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, wire(value) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  // Never clean up any partial file. A crash cannot become retry authority.
}
function createCommand(load) {
  let busy = false;
  async function run(executing, watchController) {
    need(!busy, "BUSY"); busy = true;
    let c, qualification, session, record, marker, preparedBoundaryEntered = false, custodyEntered = false, walletEntered = false, physical = false;
    let failure, failureDiagnostic = null, failureContext = null, phase = "PREFLIGHT", checked = false, healthy = false, verifiedReceipt, preparation, preparationMetrics = null, preparationDiagnostics = null, remainingAtPrepared, headroomAtPrepared;
    let watchStopped = false;
    const stopWatch = () => { if (watchController) { watchStopped = true; integration("m32-watch-session").stopController(watchController); } };
    let deadline = Date.parse(EXPIRY), previousMono, effective;
    function now() {
      const wall = c.now(), mono = c.monotonicNow();
      need(Number.isSafeInteger(wall) && wall >= 0 && Number.isFinite(mono) && mono >= 0 && (previousMono === undefined || mono >= previousMono), "CLOCK_HOLD");
      effective = previousMono === undefined ? wall : Math.max(wall, effective + mono - previousMono); previousMono = mono; return Math.ceil(effective);
    }
    function time() { need(now() < deadline, "DEADLINE_HOLD"); }
    async function awaited(fn) { time(); const value = await fn(); time(); return value; }
    function diagnosticContext(classified) {
      const context = classified?.failureContext ?? preparationDiagnostics ?? integration("m32-qualification").m32FailureContext();
      return { ...context, rejectionClass: context.rejectionClass ?? "CALL_FAILURE" };
    }
    try {
      c = load(); c.host(); time(); const initial = materials(c, now()); journals(c);
      phase = "QUALIFICATION";
      qualification = await awaited(() => watchController ? integration("m32-watch-session").takeQualification(watchController) : c.qualify());
      need(qualification?.provenance === (c.testOnly ? "TEST_ONLY" : "BOUNDED_M32_CALL_QUALIFICATION") &&
        typeof qualification.prepareFreshCall === "function" && typeof qualification.close === "function", "QUALIFICATION_HOLD");
      function unchanged() {
        const current = materials(c, now()); need(current.grantBytes.equals(initial.grantBytes) && current.registryBytes.equals(initial.registryBytes), "MATERIAL_CHANGED");
      }
      phase = "PERMISSION"; unchanged(); journals(c);
      phase = "WALLET_EXCLUSION";
      await shared().withWalletLock({ chainId: 1, account: identity().OWNER, lockRoot: c.paths.lockRoot }, async lock => {
        journals(c); time(); phase = "FRESH_ACQUISITION";
        const lifecycleCosts = freeze({ deploymentWei: DEPLOYMENT_COST, exitGasWei: GAS * FEE_CAP, approvalGasWei: GAS * FEE_CAP,
          financingWei: 0n, otherWei: 0n });
        const fused = await awaited(async () => {
          const result = await qualification.prepareFreshCall({ lifecycleCosts });
          // Retain completed work even if awaited()'s unchanged post-await
          // deadline gate rejects before the caller can receive the result.
          preparationMetrics = result?.metrics ?? null;
          preparationDiagnostics = result?.diagnostics ?? result?.preparation?.diagnostics ?? null;
          return result;
        });
        session = fused?.session; preparation = fused?.preparation; preparationMetrics = fused?.metrics ?? null;
        preparationDiagnostics = fused?.diagnostics ?? preparation?.diagnostics ?? null;
        need(session?.provenance === (c.testOnly ? "TEST_ONLY" : "BOUNDED_M32_CALL_SESSION"), "SESSION_PROVENANCE_HOLD");
        phase = "POSITION";
        const parent = session.pinned.pin, d = identity();
        const child = freeze({ number: (BigInt(parent.number) + 1n).toString(), timestamp: (BigInt(parent.timestamp) + 12n).toString(), parentHash: parent.hash, context: "SIMULATED_CHILD_NOT_MINED" });
        deadline = Math.min(deadline, Number(child.timestamp) * 1000); time(); need(now() >= Number(parent.timestamp) * 1000 && Number(child.timestamp) * 1000 < Date.parse(EXPIRY), "WINDOW_HOLD");
        const projected = fused.projected;
        need(typeof projected.healthy === "boolean" && same(projected.child, child) &&
          ["number", "hash", "timestamp"].every(k => String(projected.pin?.[k]) === String(parent[k])), "PROJECTED_BINDING_HOLD");
        if (projected.healthy) { healthy = true; return; }
        stopWatch();
        const debt = uint(projected.projectedFullDebtRaw), seize = uint(projected.maxSeizeRaw);
        need(debt > 0n && seize > 0n, "PROJECTED_AMOUNT_HOLD");
        const maxSeize = seize < HARD_SEIZE ? seize : HARD_SEIZE;
        const proposed = 2n * BigInt(parent.baseFeePerGas) + TIP, fee = proposed < FEE_CAP ? proposed : FEE_CAP;
        phase = "PREPARATION";
        need(preparation.status === "PREPARED" && preparation.selected && same(preparation.child, child), "PREPARATION_HOLD");
        const selected = preparation.selected, expected = selected.expected, tx = expected.transaction, admission = integration("m32-admission");
        const context = freeze({ proof: selected.proof, expected, executor: d.EXECUTOR, owner: d.OWNER, expectedRuntimeKeccak256: d.RUNTIME_KECCAK256,
          targetBlock: child.number, deadline: child.timestamp, maxSeizeRaw: maxSeize, maxRepayUsdTbRaw: debt });
        phase = "APPROVAL_PREPARATION";
        const approval = c.verifier.prepareM32CallApproval({ ...initial, preparation, projectedFullDebtRaw: debt.toString(), runId: c.runId(), issuedAt: new Date(now()).toISOString() });
        c.verifier.assertM32CallApprovalPreparation(approval);
        need(approval.provenance === (c.testOnly ? "TEST_ONLY" : "PURE_CALL_PREPARATION"), "APPROVAL_PROVENANCE_HOLD");
        const profile = approval.unsignedProfile;
        function ownership() {
          const owner = JSON.parse(read(require("node:path").join(lock.directory, "owner.json"), 16384));
          need(owner.token === lock.token && owner.chainId === 1 && owner.account === d.OWNER, "LOCK_OWNERSHIP_HOLD");
          journals(c, preparedBoundaryEntered ? record : undefined); if (marker) need(same(JSON.parse(read(c.paths.marker, 32768)), marker), "MARKER_OWNERSHIP_HOLD");
        }
        function permission() {
          time(); need(c.now() >= Date.parse(profile.notBefore), "NOT_BEFORE_HOLD"); unchanged(); ownership();
          need(same(admission.assertM32ExecutionPlan(context), selected.validation) &&
            same(expected.economics.lifecycleCosts, lifecycleCosts) && expected.economics.netNativeWei > 0n &&
            BigInt(tx.maxFeePerGas) === fee && BigInt(tx.maxPriorityFeePerGas) === TIP && BigInt(tx.gasLimit) === GAS, "PROOF_OR_POLICY_HOLD"); time();
        }
        let boundaryPending = true;
        function remainingReads() {
          // Before consuming the seal, no public session operation may intervene.
          // The synchronous boundary authenticates this private closing snapshot.
          const count = boundaryPending ? preparationMetrics?.counters : session.counters();
          need(count && Number.isSafeInteger(count.requests) && count.requests >= 0 && count.requests <= REQUEST_LIMIT && count.active === 0 &&
            (count.limit === undefined || count.limit === REQUEST_LIMIT), "READ_BUDGET_HOLD");
          const left = REQUEST_LIMIT - count.requests;
          need(count.remainingRequests === undefined || count.remainingRequests === left, "READ_BUDGET_HOLD"); return left;
        }
        async function current() {
          const priorPhase = phase; phase = "CURRENT";
          permission(); need(remainingReads() >= CURRENT_READS + RECEIPT_READS, "READ_BUDGET_HOLD");
          await awaited(async () => {
            const ref = { blockHash: parent.hash, requireCanonical: true };
            const [freshRes, balRes, codeRes, ownerRes, nonceRes] = await Promise.allSettled([
              session.assertFresh(), session.balanceRpc(), session.codeAt(d.EXECUTOR, ref), session.ownerAt(d.EXECUTOR, ref), session.pinned.nonce(d.OWNER),
            ]);
            if (freshRes.status === "rejected") throw freshRes.reason;
            need(freshRes.value !== false, "FRESHNESS_HOLD");
            if (balRes.status === "rejected") throw balRes.reason;
            need(BigInt(balRes.value) >= GAS * fee, "BALANCE_HOLD");
            if (codeRes.status === "rejected") throw codeRes.reason;
            need(require("../node_modules/ethers").keccak256(codeRes.value) === d.RUNTIME_KECCAK256, "RUNTIME_HOLD");
            if (ownerRes.status === "rejected") throw ownerRes.reason;
            need(ownerRes.value?.toLowerCase() === d.OWNER, "OWNER_HOLD");
            if (nonceRes.status === "rejected") throw nonceRes.reason;
            need(BigInt(nonceRes.value) === BigInt(tx.nonce), "NONCE_HOLD");
          });
          permission(); phase = priorPhase; return true;
        }
        permission();
        function headroom() {
          phase = "HEADROOM";
          remainingAtPrepared = remainingReads(); headroomAtPrepared = deadline - now();
          need(remainingAtPrepared >= PREPARED_READS, "READ_BUDGET_HOLD"); need(headroomAtPrepared >= 8000, "PREPARED_BUDGET_HOLD");
        }
        headroom();
        // Read-only acceptance exercises the identical fresh session, all-size
        // preparation, pure approval preparation and sealed closing/budget gates.
        // It owns only the transient wallet exclusion: no durable attempt,
        // consumption, custody, owner signing or private transport is entered.
        if (!executing) {
          permission(); headroom(); need(session.assertPreparedBoundary(preparation) === true, "PREPARATION_SEAL_HOLD");
          boundaryPending = false; checked = true; return;
        }
        phase = "PREPARED";
        const { keccak256, id } = require("../node_modules/ethers");
        record = { schema: "wallet-execution-journal/v1", kind: KIND, stage: "PREPARED", chainId: 1, owner: d.OWNER, executedAt: new Date(now()).toISOString(),
          intent: { operation: "CALL", targetId: ID, m32CallEventKey: c.paths.event, to: d.EXECUTOR, borrower: BORROWER, marketId: MARKET,
            runtimeKeccak256: d.RUNTIME_KECCAK256, profitToken: require(STAGED + "proof/m32-live-evidence.cjs").USDTB,
            nonce: String(tx.nonce), valueWei: "0", gasLimit: String(tx.gasLimit), maxFeePerGasWei: String(tx.maxFeePerGas),
            maxPriorityFeePerGasWei: String(tx.maxPriorityFeePerGas), calldataHash: keccak256(tx.data), pin: preparation.parent, child,
            plan: selected.validation.plan, proofCommitment: selected.proof.commitment },
          grantSha256: c.grantHash, manifestCommitment: approval.manifestCommitment, unsignedScopeCommitment: approval.scopeCommitment,
          attemptOwnerToken: lock.token, authorityConsumption: "REQUESTED", txHash: null, signerInvoked: false, liquidationVerified: false, realizedNetProfit: "UNKNOWN" };
        createDurable(c.paths.journal, record, () => {
          permission(); headroom(); need(session.assertPreparedBoundary(preparation) === true, "PREPARATION_SEAL_HOLD");
          boundaryPending = false; phase = "PREPARED"; preparedBoundaryEntered = true;
          stopWatch();
        });
        phase = "CONSUMPTION";
        marker = { schema: "m32-attended-call-consumed/v1", eventKey: c.paths.event, grantSha256: c.grantHash,
          unsignedScopeCommitment: approval.scopeCommitment, manifestCommitment: approval.manifestCommitment, preparedSha256: sha(wire(record)), attemptOwnerToken: lock.token };
        createDurable(c.paths.marker, marker, time);
        function persist(changes) { ownership(); record = { ...record, ...changes }; shared().atomicJson(c.paths.journal, record); }
        persist({ authorityConsumption: "CONSUMED" }); await current();
        phase = "APPROVAL_SIGNING";
        const signedApproval = await awaited(() => { custodyEntered = true; return c.signApproval(Buffer.from(approval.messageUtf8), { expectedPublicKeySpkiDerBase64: approval.expectedPublicKeySpkiDerBase64 }); });
        need(Buffer.isBuffer(signedApproval.signature) && signedApproval.signature.length === 64 && signedApproval.publicKeySpkiDerBase64 === approval.expectedPublicKeySpkiDerBase64 &&
          signedApproval.publicKeyFingerprint === approval.keyFingerprint, "CUSTODY_RESPONSE_HOLD");
        const approvalBytes = Buffer.from(wire({ ...profile, approval: { scheme: "Ed25519", approverId: approval.approverId,
          scopeCommitment: approval.scopeCommitment, signature: signedApproval.signature.toString("base64") } }));
        phase = "APPROVAL_VERIFICATION";
        const verified = c.verifier.verifyM32CallApproval({ ...initial, approvalBytes, preparation, projectedFullDebtRaw: debt.toString() }); c.verifier.assertM32CallApproval(verified);
        need(verified.provenance === (c.testOnly ? "TEST_ONLY" : "PURE_CALL_VERIFICATION") && same(verified.unsignedProfile, profile) &&
          same(verified.transaction, profile.manifest.transaction) && ["manifestCommitment", "scopeCommitment", "registryFingerprint", "keyFingerprint", "approverId"].every(k => verified[k] === approval[k]), "APPROVAL_BINDING_HOLD");
        await current(); persist({ approvalCommitment: verified.approvalCommitment, signerInvoked: true }); permission();
        phase = "WALLET_SIGNING";
        const signed = await awaited(() => { walletEntered = true; return c.signTransaction(freeze({ type: 2, chainId: 1, to: d.EXECUTOR, data: tx.data, value: 0n,
          nonce: Number(tx.nonce), gasLimit: GAS, maxFeePerGas: fee, maxPriorityFeePerGas: TIP, accessList: [] })); });
        phase = "SIGNED_ADMISSION";
        const admitted = admission.assertM32SignedEnvelope({ ...context, signedTxHex: signed }); need(admitted.transactionHash === keccak256(signed), "SIGNED_HASH_HOLD");
        persist({ txHash: admitted.transactionHash });
        const bundle = admission.buildM32ProofBoundBundle({ ...context, signedTxHex: signed, replacementSeed: profile.runId, timestamp: child.timestamp });
        const requests = bundle.requests; let simulation;
        async function transportContext(value, sending) {
          need(same(admission.assertM32SignedEnvelope({ ...context, signedTxHex: signed }), admitted), "SIGNED_BINDING_HOLD");
          c.verifier.assertM32CallApproval(verified);
          const request = sending ? requests.ethSendBundle : requests.ethCallBundle;
          need(same(value, { method: sending ? "eth_sendBundle" : "eth_callBundle", transactionHash: record.txHash,
            targetBlockNumber: child.number, parentBlockNumber: String(parent.number), requestBodyKeccak256: id(JSON.stringify(request)) }), "TRANSPORT_BINDING_HOLD");
          if (sending) {
            need(simulation && BigInt(simulation.gasUsed) > 0n && BigInt(simulation.gasUsed) <= GAS, "SIMULATION_HOLD");
            const priority = (BigInt(simulation.gasUsed) * TIP).toString();
            need(same(simulation, { schema: "m32-private-simulation/v1", transactionHash: record.txHash, requestBodyKeccak256: id(JSON.stringify(requests.ethCallBundle)),
              parentBlockNumber: String(parent.number), targetBlockNumber: child.number, gasUsed: simulation.gasUsed, priorityFeePerGasWei: TIP.toString(),
              priorityGasFeesWei: priority, coinbaseDiffWei: priority, ethSentToCoinbaseWei: "0" }), "SIMULATION_BINDING_HOLD");
          }
          return current();
        }
        await current();
        phase = "PRIVATE_TRANSPORT";
        const transport = c.transport({ now, authenticate: fn => awaited(fn), physicalSend: fn => {
          permission(); need(!physical, "RETRY_HOLD"); persist({ stage: "UNCERTAIN" }); permission();
          return awaited(() => { physical = true; return fn(); });
        } });
        phase = "PRIVATE_SIMULATION";
        simulation = await awaited(() => transport.simulate({ request: requests.ethCallBundle, expectedTxHash: record.txHash,
          priorityFeePerGasWei: TIP.toString(), assertContext: value => transportContext(value, false) }));
        phase = "PRIVATE_SUBMISSION";
        const sent = await awaited(() => transport.submit({ request: requests.ethSendBundle, expectedTxHash: record.txHash,
          assertDispatch: value => transportContext(value, true) }));
        need(sent.transactionHash === record.txHash && physical, "ACK_HOLD"); persist({ stage: "SENT" });
        // Historical verification may finish after the signing deadline; it grants
        // no permission to sign/send again, even if the receipt stays unavailable.
        phase = "RECEIPT";
        const receiptDeadline = c.monotonicNow() + c.receiptWaitMs;
        do {
          ownership(); if (remainingReads() < RECEIPT_READS) break;
          const receipt = await session.receiptRpc(record.txHash);
          if (receipt !== null) {
            const result = await integration("m32-call-receipt").verifyM32CallReceipt({ record, receipt, child, expected,
              call: (key, ...args) => session[key](...args), signedHash: raw => admission.assertM32SignedEnvelope({ ...context, signedTxHex: raw }).transactionHash });
            ownership(); persist(result); verifiedReceipt = result; break;
          }
          if (remainingReads() <= RECEIPT_READS || c.monotonicNow() >= receiptDeadline) break;
          await c.pause(500);
        } while (c.monotonicNow() < receiptDeadline);
      });
    } catch (e) {
      failure = ownErrors.has(e) ? e.message : "M32_CALL_DEPENDENCY_HOLD";
      // Only the session's private issuance classifier may describe an external
      // exception. Never inspect its message, stack, code or diagnostic fields.
      let classified = null;
      if (!ownErrors.has(e)) try { classified = integration("m32-call-session").classifyM32CallSessionError(e); } catch {}
      if (classified?.preparationDiagnostics) {
        preparationDiagnostics = classified.preparationDiagnostics;
        preparationMetrics = preparationDiagnostics.metrics ?? preparationMetrics;
      }
      failureDiagnostic = { compositionPhase: phase, phase: classified?.phase ?? null,
        reasonCode: classified?.reasonCode ?? null, transportCode: classified?.transportCode ?? null };
      failureContext = diagnosticContext(classified);
    }
    finally {
      const terminalWatchFailure = !["QUALIFICATION", "WALLET_EXCLUSION", "FRESH_ACQUISITION", "POSITION"].includes(phase) ||
        ["M32_CALL_ATTEMPT_OR_REVOCATION_HOLD", "M32_CALL_JOURNAL_REMNANT_HOLD", "M32_CALL_ALREADY_ATTEMPTED", "M32_CALL_CLOSE_HOLD"].includes(failure);
      if (preparedBoundaryEntered || (!healthy && !failure) || (failure && terminalWatchFailure)) stopWatch();
      for (const resource of [session, qualification]) if (resource) try { await resource.close(); }
      catch { failure ||= "M32_CALL_CLOSE_HOLD"; stopWatch(); }
      if (watchController) {
        try { await integration("m32-watch-session").finishCycle(watchController); }
        catch { failure ||= "M32_CALL_CLOSE_HOLD"; stopWatch(); }
      }
      busy = false;
    }
    const success = !failure && verifiedReceipt?.liquidationVerified === true;
    // close()/watch-drain failures also need a record; no exception text escapes.
    if ((failure || !checked && !healthy && !success) && !failureDiagnostic) {
      failureDiagnostic = { compositionPhase: phase, phase: null, reasonCode: null, transportCode: null };
      failureContext = diagnosticContext(null);
    }
    return freeze({ schema: "m32-attended-call-result/v1", provenance: c?.testOnly ? "TEST_ONLY" : "ATTENDED_TRUSTED_HOST", targetId: ID,
      status: failure ? "HOLD" : checked ? "READY_READONLY_NOT_AUTHORITY" : healthy ? "HEALTHY_WAITING" : success ? c.testOnly ? "TEST_ONLY_VERIFIED" : "LIQUIDATION_VERIFIED" : "HOLD",
      failureCode: failure || null, failureDiagnostic, failureContext, preparationReason: preparation?.reason || null, liquidationVerified: success && !c.testOnly,
      fixtureLiquidationVerified: success && c.testOnly, liveDispatchAllowed: false, realizedNetProfit: "UNKNOWN",
      preparedBoundaryEntered, custodyEntered, walletEntered, physicalSubmissionAttempted: physical,
      irreversibleHold: preparedBoundaryEntered && !success || ["M32_CALL_ATTEMPT_OR_REVOCATION_HOLD", "M32_CALL_JOURNAL_REMNANT_HOLD", "M32_CALL_ALREADY_ATTEMPTED"].includes(failure),
      transactionHash: record?.txHash || null,
      remainingReadsAtPrepared: remainingAtPrepared ?? null, childHeadroomMsAtPrepared: headroomAtPrepared ?? null,
      preparationMetrics, preparationDiagnostics,
      ...(watchController ? { watchStopped, watchMetrics: qualification?.watchMetrics ?? null } : {}),
      costPolicy: "Actual deployment cost plus maximum liquidation gas; future exit and approval gas reserved, not measured or executed; collateral-funded callback has no financing principal; no other identified obligations; 50bps uncertainty and output haircuts.",
      ...(success ? { blockNumber: verifiedReceipt.blockNumber, blockHash: verifiedReceipt.blockHash, gasUsed: verifiedReceipt.gasUsed,
        effectiveGasPriceWei: verifiedReceipt.effectiveGasPriceWei, actualGasCostWei: verifiedReceipt.actualGasCostWei,
        actualTokenGainRaw: verifiedReceipt.actualTokenGainRaw, tokenGainEvidence: verifiedReceipt.tokenGainEvidence } : {}) });
  }
  function createWatchSession(options = {}) {
    need(arguments.length <= 1 && options && [Object.prototype, null].includes(Object.getPrototypeOf(options)) &&
      Reflect.ownKeys(options).every(key => key === "maxRuns" && Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), "value")), "OPTIONS_REJECTED");
    const maxRuns = options.maxRuns;
    need(maxRuns === undefined || Number.isSafeInteger(maxRuns) && maxRuns >= 1, "OPTIONS_REJECTED");
    const c = load(), watch = integration("m32-watch-session");
    const controller = c.testOnly ? watch.TEST_ONLY.createController({ maxRuns, qualify: () => c.qualify(), now: c.now,
      monotonicNow: c.monotonicNow, pause: c.pause }) : watch.createController({ maxRuns });
    let mode;
    function enter(nextMode) { need(mode === undefined || mode === nextMode, "MODE_HOLD"); mode = nextMode; }
    return Object.freeze({
      async nextCheck() { need(arguments.length === 0, "OPTIONS_REJECTED"); enter("CHECK"); return run(false, controller); },
      async nextExecute() { need(arguments.length === 0, "OPTIONS_REJECTED"); enter("EXECUTE"); return run(true, controller); },
      async close() { need(arguments.length === 0, "OPTIONS_REJECTED"); return watch.closeController(controller); },
    });
  }
  return Object.freeze({ async check() { need(arguments.length === 0, "OPTIONS_REJECTED"); return run(false); },
    async execute() { need(arguments.length === 0, "OPTIONS_REJECTED"); return run(true); }, createWatchSession });
}
function productionLoad() {
  const path = require("node:path"), { performance } = require("node:perf_hooks"), verifier = integration("m32-call-approval");
  return { testOnly: false, paths: paths(path.resolve(__dirname, "../..")), verifier, grantHash: GRANT_HASH, registryHash: verifier.CANONICAL_REGISTRY_SHA256,
    host() { need(process.platform === "win32" && process.arch === "x64" && process.version === "v24.13.0" && process.execPath.toLowerCase() === NODE.toLowerCase(), "PINNED_RUNTIME_REQUIRED"); },
    now: Date.now, monotonicNow: () => performance.now(), runId: () => require("node:crypto").randomUUID(),
    qualify: () => integration("m32-call-session").qualifyM32CallSession(),
    signApproval: (message, options) => require("../live-execution-custody-win32.js").signApprovalMessage(message, options),
    signTransaction: tx => shared().signWithProcessKey(tx, identity().OWNER),
    transport: ({ now, authenticate, physicalSend }) => {
      const auth = require("../node_modules/ethers").Wallet.createRandom();
      return require(STAGED + "delivery/m32-private-transport.cjs").createM32PrivateTransport({ authAddress: auth.address, now,
        signMessage: text => authenticate(() => auth.signMessage(text)), fetchImpl: (location, options) => JSON.parse(options.body).method === "eth_sendBundle"
          ? physicalSend(() => globalThis.fetch(location, options)) : globalThis.fetch(location, options) });
    }, receiptWaitMs: 30000, pause: ms => new Promise(resolve => setTimeout(resolve, ms)) };
}
const production = createCommand(productionLoad);
function createFixture(input) {
  const fs = require("node:fs"), path = require("node:path"), directory = fs.mkdtempSync(path.join(TEMP, "m32-call-test-")), p = paths(directory);
  try {
    for (const key of ["grant", "registry"]) {
      need(Buffer.isBuffer(input[key + "Bytes"]), "TEST_BYTES_REQUIRED"); fs.mkdirSync(path.dirname(p[key]), { recursive: true }); fs.writeFileSync(p[key], input[key + "Bytes"], { flag: "wx" });
    }
    const grantHash = sha(input.grantBytes), registryHash = "0x" + sha(input.registryBytes);
    const verifier = integration("m32-call-approval").TEST_ONLY.createVerifier({ registrySha256: registryHash, grantSha256: grantHash });
    const receiptWaitMs = input.adapters.receiptWaitMs ?? 0; need(Number.isSafeInteger(receiptWaitMs) && receiptWaitMs >= 0 && receiptWaitMs <= 30000, "TEST_WAIT_INVALID");
    let disposed = false;
    const load = () => { need(!disposed, "TEST_CLOSED"); return { ...input.adapters, testOnly: true, paths: p, verifier, grantHash, registryHash,
      host() { checkedPath(directory); }, receiptWaitMs }; };
    return Object.freeze({ ...createCommand(load), provenance: "TEST_ONLY", paths: p, restart: () => createCommand(load),
      cleanup() { if (!disposed) { disposed = true; fs.rmSync(directory, { recursive: true, force: true }); } } });
  } catch (e) { fs.rmSync(directory, { recursive: true, force: true }); throw e; }
}
module.exports = Object.freeze({ ...production, TEST_ONLY: Object.freeze({ createFixture }) });
if (require.main === module) {
  const args = process.argv.slice(2);
  if (!args.length) console.log("Usage: m32-attended-call.cjs --check | --execute (Stage2 only; no retries)");
  else if (args.length !== 1 || !["--check", "--execute"].includes(args[0])) { console.log("M32_CALL_ARGUMENTS_REJECTED"); process.exitCode = 2; }
  else production[args[0] === "--check" ? "check" : "execute"]().then(result => {
    console.log(JSON.stringify(result)); if (result.status === "HOLD") process.exitCode = 1;
  }, () => { console.log("M32_CALL_HOLD"); process.exitCode = 1; });
}
