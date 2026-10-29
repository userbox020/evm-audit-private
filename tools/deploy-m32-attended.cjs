"use strict";

// One attended Stage1 CREATE, on the explicitly approved trusted Windows host.
// Not hostile-local-writer isolation, machine conversation attestation, a native
// authority bypass, or Stage2 permission. Import/no arguments perform no IO.
const OWNER = "0x24e46e91dfaad1fa3d49c48aa85ca9306885ce0a";
const SOURCE = "938b6c765e40b9d983ffc50b99ee65dca218b1bd96771ad8ae05165f67814777";
const INITCODE = "0x443ee2c21d4446104064262852718486c0cf785663d72bec6fde3190c101d9a5";
const RUNTIME = "0x2b3e40560e4e0ce96999b35d6f0141def9d7cba00baf7aa3caa7f22cd3f4a191";
const GRANT_SHA256 = "6d6b9d7257ab92754997c335b32d850bcbc5fb76d227b614566e14e7b6b28d01";
const EXPIRY = "2026-10-27T18:00:00Z", APPROVER = "windows-local-approver-20260912-01";
const NODE = "C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode\\m32-node-v24.13.0-902b80feae4c40eab5376ef15401e2f2\\node.exe";
const TEMP = "C:\\Users\\MiPC\\AppData\\Local\\Temp\\opencode";
const STAGED = "../staging/executor-readiness-m32-20261026/";
const KIND = "m32-attended-create/v1", TIP = 50000000n;
// Two-family reads: current() = assertFresh(10) + balance(2) + code(2).
// Seven post-PREPARED cycles cost 98; receiptRpc(6) + receipt verifier(10)
// cost 16. Reserve 128 = 98 + 16 + 14 (seven null receipt polls at 2 each).
const PREPARED_READ_RESERVE = 128, RECEIPT_READ_RESERVE = 16;
const ownErrors = new WeakSet();
function need(ok, code) { if (!ok) { const e = new Error("M32_ATTENDED_" + code); ownErrors.add(e); throw e; } }
const sha = bytes => require("node:crypto").createHash("sha256").update(bytes).digest("hex");
const wire = v => JSON.stringify(v, (_, x) => typeof x === "bigint" ? x.toString() : x);
const same = (a, b) => require("node:util").isDeepStrictEqual(a, b);
const freeze = v => { if (v && typeof v === "object" && !Buffer.isBuffer(v)) { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
const commit = v => "0x" + sha(require("./live-execution-batch.js").canonical(v));
const integration = name => require(STAGED + "integration/" + name + ".cjs");
function paths(root) {
  const p = require("node:path"), join = s => p.join(root, s);
  const attempt = integration("m32-create-guard").getM32CreateAttemptKey(INITCODE).slice(2);
  return freeze({ root, coordination: join("coordination"), lockRoot: join("coordination/wallet-execution-locks"),
    journalDir: join("reports/raw/fast/aave-v4-v3-morpho-liquidator-execution"), evidence: join("reports/raw/fast/executor-readiness-m32-20261026"),
    grant: join("reports/raw/fast/executor-readiness-m32-20261026/STAGE1-ATTENDED-AUTHORIZATION-20261027.json"),
    registry: join("coordination/live-execution-approvers.json"),
    source: join("staging/executor-readiness-m32-20261026/contract/MorphoM32CurveUnwindLiquidator.sol"),
    compiledArtifact: join("staging/executor-readiness-m32-20261026/contract/MorphoM32CurveUnwindLiquidator.compiled.json"),
    rehearsal: join("reports/raw/fast/executor-readiness-m32-20261026/m32-fork-rehearsal-26275799-crossed.json"),
    marker: join(`coordination/m32-attended-create-${attempt}.json`),
    journal: join(`reports/raw/fast/aave-v4-v3-morpho-liquidator-execution/m32-attended-${attempt}.json`) });
}
// Trusted-host path/type/size checks, NOT ACL qualification. No env path input.
function checkedPath(file) {
  const fs = require("node:fs"), path = require("node:path");
  for (let at = path.resolve(file);;) {
    let s; try { s = fs.lstatSync(at); } catch (e) { need(e.code === "ENOENT", "PATH_HOLD"); }
    if (s) need(!s.isSymbolicLink() && fs.realpathSync(at).toLowerCase() === at.toLowerCase(), "PATH_HOLD");
    const parent = path.dirname(at); if (parent === at) break; at = parent;
  }
}
function read(file, maximum) {
  const fs = require("node:fs"); checkedPath(file);
  const fd = fs.openSync(file, "r");
  try {
    const s = fs.fstatSync(fd); need(s.isFile() && s.size > 0 && s.size <= maximum, "MATERIAL_SIZE_HOLD");
    const bytes = Buffer.alloc(s.size); let at = 0;
    while (at < bytes.length) { const n = fs.readSync(fd, bytes, at, bytes.length - at, at); need(n > 0, "MATERIAL_CHANGED"); at += n; }
    const after = fs.fstatSync(fd);
    need(s.size === after.size && s.mtimeMs === after.mtimeMs, "MATERIAL_CHANGED"); return bytes;
  } finally { fs.closeSync(fd); }
}
function grant(bytes, expectedHash, now) {
  need(sha(bytes) === expectedHash, "GRANT_PIN_HOLD"); const g = JSON.parse(bytes);
  need(g.schema === "m32-attended-stage1-conversation-authorization/v1" && g.status === "USER_APPROVED_ATTENDED_STAGE1_ONLY" &&
    g.notMachineAttestation === true && g.liveDispatchAllowed === false &&
    g.trustBoundary === "ATTENDED_TRUSTED_WINDOWS_HOST_AND_COOPERATING_LOCAL_PROCESSES" && g.hostileLocalWriterIsolationProvided === false &&
    g.chainId === 1 && g.chain === "ethereum" && g.account === OWNER && g.owner === OWNER &&
    g.contract === "MorphoM32CurveUnwindLiquidator" && g.sourceSha256 === SOURCE && g.constructorInitcodeKeccak256 === INITCODE &&
    g.creationBytecodeKeccak256 === "0x2daf944be5d0035c92bca66082f2ba282a8f29c083217d7fa0587e2740f81098" && g.expectedOwnerRuntimeKeccak256 === RUNTIME &&
    same(g.caps, { valueWei: "0", gasLimit: "2000000", maxFeePerGasWei: "1500000000", maxPriorityFeePerGasWei: "300000000",
      maxGasReservationWei: "3000000000000000", slippage: "NOT_APPLICABLE_NO_SWAP", maxDeployments: 1, maxPrivateSubmissionAttempts: 1 }) &&
    g.expiresAt === EXPIRY && Number.isFinite(Date.parse(g.recordedAt)) && now >= Date.parse(g.recordedAt) && now < Date.parse(EXPIRY), "GRANT_SCOPE_HOLD");
  return g;
}
function material(c) {
  const limits = c.verifier.LIMITS || integration("m32-create-approval").LIMITS;
  return Object.fromEntries(["registry", "source", "compiledArtifact", "rehearsal"].map(k => [k + "Bytes", read(c.paths[k], limits[k + "Bytes"])]));
}
function profileFor(chain, rehearsalBytes, now, ids) {
  const { getCreateAddress } = require("./node_modules/ethers"), parent = chain.parent;
  const child = BigInt(parent.timestamp) + 12n, nonce = BigInt(chain.nonce), predicted = getCreateAddress({ from: OWNER, nonce }).toLowerCase();
  const proposed = 2n * BigInt(parent.baseFeePerGas) + TIP, fee = proposed < 1500000000n ? proposed : 1500000000n;
  const childFee = integration("m32-stage1-chain").computeM32ChildBaseFee(parent);
  need(chain.predictedAddress === predicted && chain.childBaseFeeWei === childFee.toString() && fee >= childFee + TIP &&
    BigInt(chain.balanceWei) >= fee * 2000000n && now >= Number(parent.timestamp) * 1000 && now < Number(child) * 1000 && Number(child) * 1000 < Date.parse(EXPIRY), "CHAIN_FEE_WINDOW_HOLD");
  const m = { operation: "CREATE", type: "2", chainId: "1", owner: OWNER, to: null, accessList: [], value: "0", sourceSha256: SOURCE,
    initcodeKeccak256: INITCODE, runtimeKeccak256: RUNTIME, nonce: nonce.toString(), predictedAddress: predicted, gasLimit: "2000000",
    maxFeePerGas: fee.toString(), maxPriorityFeePerGas: TIP.toString(), maxNativeSpendWei: (fee * 2000000n).toString(),
    pin: { number: String(parent.number), hash: parent.hash, timestamp: String(parent.timestamp) }, targetBlock: (BigInt(parent.number) + 1n).toString(), targetTimestamp: child.toString(),
    delivery: { method: "eth_sendBundle", privateOnly: true, publicFallback: false, revertingTxHashes: [], directCoinbasePaymentWei: "0" },
    maxExecutions: "1", deploymentAttemptKey: integration("m32-create-guard").getM32CreateAttemptKey(INITCODE), runId: ids.runId,
    rehearsal: { kind: "PINNED_MAINNET_FORK_DEPLOYMENT", evidenceSha256: sha(rehearsalBytes) } };
  const issuedAt = new Date(Math.floor(now / 1000) * 1000).toISOString().replace(".000Z", "Z");
  return freeze({ schema: "m32-stage1-create-approval/v1", batchId: ids.batchId, issuedAt, notBefore: issuedAt, expiresAt: EXPIRY,
    manifest: m, manifestCommitment: commit(m) });
}
function prepare(c, inputs, p) {
  const prepared = c.verifier.prepareM32CreateApproval({ ...inputs, unsignedApprovalBytes: Buffer.from(wire(p)), approverId: APPROVER });
  c.verifier.assertM32CreateApprovalPreparation(prepared);
  need(prepared.provenance === (c.testOnly ? "TEST_ONLY" : "PURE_BYTES_PREPARATION") && same(prepared.unsignedProfile, p), "PREPARATION_HOLD");
  need(same(c.verifier.buildM32CreateSigningMessage(p, APPROVER), Object.fromEntries(
    ["scheme", "approverId", "manifestCommitment", "scopeCommitment", "messageUtf8"].map(k => [k, prepared[k]]))), "PREPARATION_HOLD");
  return prepared;
}
function preflight(c, now) {
  c.host(); const grantBytes = read(c.paths.grant, 32768); grant(grantBytes, c.grantHash, now);
  const inputs = material(c), { getCreateAddress } = require("./node_modules/ethers");
  // Pure material validation BEFORE qualification/fresh pin. This dummy envelope
  // is never signed, persisted, admitted or used as chain evidence.
  const parent = { number: "1", hash: "0x" + c.grantHash, timestamp: String(Math.floor(now / 1000)), baseFeePerGas: "1", gasLimit: "30000000", gasUsed: "15000000" };
  prepare(c, inputs, profileFor({ parent, nonce: "0", predictedAddress: getCreateAddress({ from: OWNER, nonce: 0 }).toLowerCase(),
    childBaseFeeWei: "1", balanceWei: "3000000000000000" }, inputs.rehearsalBytes, now, { batchId: "0".repeat(24), runId: "material-preflight-not-authority" }));
  return { inputs, grantBytes };
}
function names(dir) {
  const fs = require("node:fs"); checkedPath(dir);
  try { return fs.readdirSync(dir); } catch (e) { need(e.code === "ENOENT", "STATE_HOLD"); return []; }
}
function remnants(c, owned = false) {
  const path = require("node:path");
  for (const name of names(c.paths.coordination)) if (/^m32-(?:stage1-|create-|attended-)/i.test(name)) {
    need(owned && name === path.basename(c.paths.marker), "NATIVE_OR_ATTEMPT_HOLD");
  }
  for (const name of names(c.paths.evidence)) need(!/^m32-(?:deploy(?:ment)?|create-receipt|attended-attempt)/i.test(name), "DEPLOYMENT_HOLD");
  for (const name of names(c.paths.journalDir)) {
    need(!name.endsWith(".tmp") && (!/^m32-(?:create-|attended-)/i.test(name) || owned && name === path.basename(c.paths.journal)), "JOURNAL_REMNANT_HOLD");
    checkedPath(path.join(c.paths.journalDir, name));
  }
}
function journals(c, ownedRecord) {
  const shared = require("./lib/wallet-execution-guard.js"); remnants(c, !!ownedRecord);
  const rows = shared.readJournals(c.paths.journalDir, OWNER, 1);
  for (const { file, record } of rows) {
    if (ownedRecord && file === c.paths.journal) { need(same(record, ownedRecord), "JOURNAL_OWNERSHIP_HOLD"); continue; }
    need(!["PREPARED", "SENT", "UNCERTAIN"].includes(record.stage), "WALLET_PENDING_HOLD");
    const i = record.intent;
    need(!record.kind?.startsWith("m32-") || i?.sourceSha256 && i?.initcodeKeccak256, "UNKNOWN_M32_HOLD");
    if (i?.sourceSha256 && i?.initcodeKeccak256) need(!(String(i.sourceSha256).replace(/^0x/i, "").toLowerCase() === SOURCE &&
      String(i.initcodeKeccak256).toLowerCase() === INITCODE), "ALREADY_ATTEMPTED");
  }
  if (ownedRecord) need(rows.some(row => row.file === c.paths.journal), "JOURNAL_OWNERSHIP_HOLD");
}
function createDurable(file, value, beforeCreate) {
  const fs = require("node:fs"), path = require("node:path"); checkedPath(file); fs.mkdirSync(path.dirname(file), { recursive: true });
  beforeCreate(); // Last synchronous gate before the irreversible wx create.
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, wire(value) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  // No cleanup on ANY failure, including partial/empty files. Cooperating-process
  // crash exclusion via fsync + immutable wx marker, not hostile-writer protection.
}
function projections(p) {
  const m = p.manifest, common = { chainId: 1, owner: OWNER, sourceSha256: SOURCE, initcodeKeccak256: INITCODE, runtimeKeccak256: RUNTIME,
    nonce: m.nonce, predictedAddress: m.predictedAddress, gasLimit: m.gasLimit, maxFeePerGas: m.maxFeePerGas, maxPriorityFeePerGas: m.maxPriorityFeePerGas,
    value: "0", pin: m.pin, manifestCommitment: p.manifestCommitment.slice(2), runId: m.runId };
  return freeze({ scope: { operation: "CREATE", type: 2, to: null, accessList: [], ...common, expiresAt: EXPIRY,
    deploymentAttemptKey: m.deploymentAttemptKey, targetBlock: m.targetBlock, targetTimestamp: m.targetTimestamp },
    delivery: { ...common, targetBlockNumber: m.targetBlock, childTimestamp: m.targetTimestamp,
      expiresAt: new Date(Number(m.targetTimestamp) * 1000).toISOString(), batchId: p.batchId } });
}
function createCommand(load) {
  let busy = false;
  async function run(executing) {
    need(!busy, "BUSY"); busy = true;
    let c, qualification, chain, record, marker, preparedRisk = false, physical = false, custodyEntered = false, walletEntered = false, verifiedReceipt;
    let failure, checked = false, deadline = Date.parse(EXPIRY), previousMono, effective;
    function now() {
      const wall = c.now(), mono = c.monotonicNow();
      need(Number.isSafeInteger(wall) && wall >= 0 && Number.isFinite(mono) && mono >= 0 && (previousMono === undefined || mono >= previousMono), "CLOCK_HOLD");
      effective = previousMono === undefined ? wall : Math.max(wall, effective + mono - previousMono); previousMono = mono; return effective;
    }
    function time() { need(now() < deadline, "DEADLINE_HOLD"); }
    async function awaited(fn) { time(); const v = await fn(); time(); return v; }
    try {
      c = load(); time(); const initial = preflight(c, now()); remnants(c);
      qualification = await awaited(() => c.qualify());
      need(qualification && qualification.provenance === (c.testOnly ? "TEST_ONLY" : "BOUNDED_CORROBORATED_CREATE_QUALIFICATION") &&
        typeof qualification.acquireFreshParent === "function" && typeof qualification.close === "function", "QUALIFICATION_HOLD");
      function unchangedMaterials() {
        const bytes = read(c.paths.grant, 32768); grant(bytes, c.grantHash, now()); need(bytes.equals(initial.grantBytes), "GRANT_CHANGED");
        const current = material(c); need(Object.keys(current).every(k => current[k].equals(initial.inputs[k])), "MATERIAL_CHANGED");
      }
      unchangedMaterials(); remnants(c); time(); // Qualification never refreshes public permission or pins.
      if (!executing) { checked = true; }
      else await require("./lib/wallet-execution-guard.js").withWalletLock({ chainId: 1, account: OWNER, lockRoot: c.paths.lockRoot }, async lock => {
        time(); journals(c);
        chain = await awaited(() => qualification.acquireFreshParent());
        need(chain.provenance === (c.testOnly ? "TEST_ONLY" : "BOUNDED_CORROBORATED_CREATE_READER"), "CHAIN_PROVENANCE_HOLD");
        deadline = Math.min(deadline, (Number(chain.parent.timestamp) + 12) * 1000); time();
        const profile = profileFor(chain, initial.inputs.rehearsalBytes, now(), c.ids()), prepared = prepare(c, initial.inputs, profile);
        const { scope, delivery } = projections(profile);
        const { keccak256, Interface, id } = require("./node_modules/ethers"), artifact = JSON.parse(initial.inputs.compiledArtifactBytes);
        const initcode = artifact.creationBytecode + new Interface(artifact.abi).encodeDeploy([OWNER]).slice(2);
        const runtimeBytes = Buffer.from(artifact.deployedBytecode.slice(2), "hex");
        for (const ref of Object.values(artifact.immutableReferences)[0]) Buffer.from(OWNER.slice(2).padStart(64, "0"), "hex").copy(runtimeBytes, ref.start);
        const runtime = "0x" + runtimeBytes.toString("hex"); need(keccak256(initcode) === INITCODE && keccak256(runtime) === RUNTIME, "ARTIFACT_HOLD");
        function ownership() {
          const owner = JSON.parse(read(require("node:path").join(lock.directory, "owner.json"), 16384));
          need(owner.token === lock.token && owner.chainId === 1 && owner.account === OWNER, "LOCK_OWNERSHIP_HOLD");
          journals(c, record);
          if (marker) need(same(JSON.parse(read(c.paths.marker, 32768)), marker), "MARKER_OWNERSHIP_HOLD");
        }
        function permission() {
          time(); need(c.now() >= Date.parse(profile.notBefore), "NOT_BEFORE_HOLD");
          unchangedMaterials();
          ownership(); time();
        }
        async function current() {
          permission(); await awaited(() => chain.assertFresh());
          const funds = await awaited(() => chain.balanceRpc({ account: OWNER, blockTag: "pending" }));
          need(BigInt(funds) >= BigInt(scope.gasLimit) * BigInt(scope.maxFeePerGas), "BALANCE_HOLD");
          need(await awaited(() => chain.codeAt(scope.predictedAddress, { blockHash: scope.pin.hash, requireCanonical: true })) === "0x", "ADDRESS_OCCUPIED");
          permission(); return true;
        }
        function remainingReads() {
          need(typeof chain.counters === "function", "READ_BUDGET_HOLD");
          const counters = chain.counters();
          need(counters && Number.isSafeInteger(counters.requests) && counters.requests >= 0 && counters.active === 0, "READ_BUDGET_HOLD");
          return integration("m32-stage1-chain").LIMITS.requests - counters.requests;
        }
        await current(); need(deadline - now() >= 8000, "PREPARED_BUDGET_HOLD");
        need(remainingReads() >= PREPARED_READ_RESERVE, "READ_BUDGET_HOLD");
        record = { schema: "wallet-execution-journal/v1", kind: KIND, stage: "PREPARED", chainId: 1, owner: OWNER,
          executedAt: new Date(Math.floor(now())).toISOString(), intent: { ...scope, calldataHash: INITCODE,
            maxFeePerGasWei: scope.maxFeePerGas, maxPriorityFeePerGasWei: scope.maxPriorityFeePerGas },
          grantSha256: c.grantHash, unsignedScopeCommitment: prepared.scopeCommitment, attemptOwnerToken: lock.token,
          authorityConsumption: "REQUESTED", txHash: null, signerInvoked: false, activationAllowed: false };
        createDurable(c.paths.journal, record, () => {
          need(remainingReads() >= PREPARED_READ_RESERVE, "READ_BUDGET_HOLD");
          need(deadline - now() >= 8000, "PREPARED_BUDGET_HOLD"); preparedRisk = true;
        }); // FIRST durable PREPARED.
        marker = { schema: "m32-attended-create-consumed/v1", deploymentAttemptKey: scope.deploymentAttemptKey,
          grantSha256: c.grantHash, unsignedScopeCommitment: prepared.scopeCommitment, manifestCommitment: profile.manifestCommitment,
          preparedSha256: sha(wire(record)), attemptOwnerToken: lock.token };
        createDurable(c.paths.marker, marker, time); // THEN immutable one-use consumption.
        const shared = require("./lib/wallet-execution-guard.js");
        function persist(changes) { ownership(); record = { ...record, ...changes }; shared.atomicJson(c.paths.journal, record); }
        persist({ authorityConsumption: "CONSUMED" });
        await current();
        const signedApproval = await awaited(() => { custodyEntered = true; return c.signApproval(Buffer.from(prepared.messageUtf8),
          { expectedPublicKeySpkiDerBase64: prepared.expectedPublicKeySpkiDerBase64 }); });
        need(Buffer.isBuffer(signedApproval.signature) && signedApproval.signature.length === 64 &&
          signedApproval.publicKeySpkiDerBase64 === prepared.expectedPublicKeySpkiDerBase64 && signedApproval.publicKeyFingerprint === prepared.keyFingerprint, "CUSTODY_RESPONSE_HOLD");
        const approvalBytes = Buffer.from(wire({ ...profile, approval: { scheme: "Ed25519", approverId: APPROVER,
          scopeCommitment: prepared.scopeCommitment, signature: signedApproval.signature.toString("base64") } }));
        const verified = c.verifier.verifyM32CreateApproval({ ...initial.inputs, approvalBytes }); c.verifier.assertM32CreateApproval(verified);
        need(verified.provenance === (c.testOnly ? "TEST_ONLY" : "PURE_BYTES_VERIFICATION") &&
          ["manifestCommitment", "scopeCommitment", "registryFingerprint", "keyFingerprint", "approverId"].every(k => verified[k] === prepared[k]) &&
          same(verified.deliveryProjection, delivery) && same({ ...verified.guardProjection, targetBlock: scope.targetBlock, targetTimestamp: scope.targetTimestamp }, scope), "APPROVAL_BINDING_HOLD");
        await current(); persist({ approvalCommitment: verified.approvalCommitment, signerInvoked: true });
        permission();
        const signed = await awaited(() => { walletEntered = true; return c.signTransaction(freeze({ type: 2, chainId: 1, to: null, nonce: Number(scope.nonce), data: initcode, value: 0n,
          gasLimit: BigInt(scope.gasLimit), maxFeePerGas: BigInt(scope.maxFeePerGas), maxPriorityFeePerGas: BigInt(scope.maxPriorityFeePerGas), accessList: [] })); });
        const admission = integration("m32-create-admission").admitM32CreateSignedEnvelope({ signedTransaction: signed, expected: delivery });
        need(admission.transactionHash === keccak256(signed), "SIGNED_HASH_HOLD"); persist({ txHash: admission.transactionHash });
        const requests = require(STAGED + "delivery/m32-private-delivery.cjs").buildExactBlockBundleRequests({ targetBlockNumber: scope.targetBlock,
          parentBlockNumber: scope.pin.number, parentBlockHash: scope.pin.hash, signedTxHex: signed, replacementSeed: scope.runId, timestamp: scope.targetTimestamp });
        requests.ethSendBundle.params[0].minTimestamp = Number(scope.targetTimestamp); requests.ethSendBundle.params[0].maxTimestamp = Number(scope.targetTimestamp); freeze(requests);
        let simulation;
        async function context(value, sending) {
          integration("m32-create-admission").assertM32CreateSignedEnvelope(admission, { signedTransaction: signed, expected: delivery });
          const expected = { method: sending ? "eth_sendBundle" : "eth_callBundle", transactionHash: record.txHash,
            targetBlockNumber: scope.targetBlock, parentBlockNumber: scope.pin.number, requestBodyKeccak256: id(JSON.stringify(sending ? requests.ethSendBundle : requests.ethCallBundle)),
            kind: "M32_STAGE1_CREATE", admissionCommitment: admission.commitment, admissionBinding: admission.binding,
            parentBlockHash: scope.pin.hash, parentTimestamp: scope.pin.timestamp, childTimestamp: scope.targetTimestamp, expiresAt: delivery.expiresAt,
            ...(sending ? { simulationRequestBodyKeccak256: simulation?.requestBodyKeccak256 } : {}) };
          need(same(value, expected) && same(admission.binding.scope, delivery), "TRANSPORT_BINDING_HOLD");
          if (sending) {
            need(simulation && BigInt(simulation.gasUsed) > 0n && BigInt(simulation.gasUsed) <= BigInt(scope.gasLimit), "SIMULATION_BINDING_HOLD");
            const priorityFees = (BigInt(simulation.gasUsed) * TIP).toString();
            need(same(simulation, { schema: "m32-private-create-simulation/v1", transactionHash: record.txHash,
              requestBodyKeccak256: id(JSON.stringify(requests.ethCallBundle)), parentBlockNumber: scope.pin.number, targetBlockNumber: scope.targetBlock,
              gasUsed: simulation.gasUsed, priorityFeePerGasWei: scope.maxPriorityFeePerGas, priorityGasFeesWei: priorityFees, coinbaseDiffWei: priorityFees,
              ethSentToCoinbaseWei: "0", kind: "M32_STAGE1_CREATE", admissionCommitment: admission.commitment, parentBlockHash: scope.pin.hash,
              childTimestamp: scope.targetTimestamp, liveDispatchAllowed: false, deploymentVerified: false }), "SIMULATION_BINDING_HOLD");
          }
          return current();
        }
        await current();
        const transport = c.transport({ now: () => Math.floor(now()), authenticate: fn => awaited(fn), physicalSend: fn => {
          // Transport invokes this after its post-auth assertion. No await between
          // these final synchronous permission/ownership gates and physical send.
          permission(); need(!physical, "RETRY_HOLD");
          persist({ stage: "UNCERTAIN" }); permission(); return awaited(() => { physical = true; return fn(); });
        } });
        simulation = await awaited(() => transport.simulateCreate({ request: requests.ethCallBundle, admission, signedTransaction: signed,
          expected: delivery, priorityFeePerGasWei: scope.maxPriorityFeePerGas, assertContext: value => context(value, false) }));
        const sent = await awaited(() => transport.submitCreate({ request: requests.ethSendBundle, admission, signedTransaction: signed,
          expected: delivery, simulation, assertDispatch: value => context(value, true) }));
        need(sent.transactionHash === record.txHash && physical, "ACK_HOLD"); persist({ stage: "SENT" });
        // Receipts may arrive AFTER the signing window. Historical ownership, not
        // fresh signing permission, is required; no retry is ever made.
        const receiptDeadline = c.monotonicNow() + c.receiptWaitMs;
        do {
          ownership();
          if (remainingReads() < RECEIPT_READ_RESERVE) break;
          const receipt = await chain.receiptRpc(record.txHash);
          if (receipt !== null) {
            const canonical = async expected => {
              const header = await chain.recheckCanonical(expected);
              need(header && String(header.number) === expected.number && header.hash === expected.hash &&
                (expected.timestamp === undefined || String(header.timestamp) === expected.timestamp), "RECEIPT_CANONICAL_HOLD"); return header;
            };
            const result = await integration("m32-create-receipt").verifyM32CreateReceipt({ scope, artifact: { runtime }, record, receipt,
              call: (key, ...args) => chain[key](...args), canonical,
              signedHash: raw => integration("m32-create-admission").admitM32CreateSignedEnvelope({ signedTransaction: raw, expected: delivery }).transactionHash });
            ownership(); need(result.txHash === record.txHash && result.intent.deploymentAttemptKey === marker.deploymentAttemptKey, "HISTORICAL_BINDING_HOLD");
            persist(result); verifiedReceipt = result; break;
          }
          // After null polls, leave the full verification reserve untouched.
          if (remainingReads() <= RECEIPT_READ_RESERVE) break;
          if (c.monotonicNow() >= receiptDeadline) break;
          await c.pause(500);
        } while (c.monotonicNow() < receiptDeadline);
      });
    } catch (e) { failure = ownErrors.has(e) ? e.message : "M32_ATTENDED_DEPENDENCY_HOLD"; }
    finally { if (qualification) try { await qualification.close(); } catch { failure ||= "M32_ATTENDED_CLOSE_HOLD"; } busy = false; }
    const success = !failure && verifiedReceipt?.stage === "RECEIPT_VERIFIED" && verifiedReceipt.deploymentVerified === true;
    return freeze({ schema: "m32-attended-create-result/v1", provenance: c?.testOnly ? "TEST_ONLY" : "ATTENDED_TRUSTED_HOST",
      status: failure ? "HOLD" : checked ? "CHECKED_NOT_EXECUTION_READY" : success ? c.testOnly ? "TEST_ONLY_VERIFIED" : "DEPLOYMENT_VERIFIED" : "HOLD",
      deploymentVerified: success && !c.testOnly, fixtureDeploymentVerified: success && c.testOnly, activationAllowed: false,
      liveDispatchAllowed: false, failureCode: failure || null, preparedBoundaryEntered: preparedRisk, custodyEntered, walletEntered,
      physicalSubmissionAttempted: physical, irreversibleHold: preparedRisk && !success, transactionHash: record?.txHash || null,
      ...(success ? { contractAddress: verifiedReceipt.contractAddress, blockNumber: verifiedReceipt.blockNumber, blockHash: verifiedReceipt.blockHash,
        runtimeKeccak256: verifiedReceipt.runtimeKeccak256, owner: OWNER, gasUsed: verifiedReceipt.gasUsed,
        effectiveGasPriceWei: verifiedReceipt.effectiveGasPriceWei, actualGasCostWei: verifiedReceipt.actualGasCostWei } : {}) });
  }
  return Object.freeze({ async check() { need(arguments.length === 0, "OPTIONS_REJECTED"); return run(false); },
    async execute() { need(arguments.length === 0, "OPTIONS_REJECTED"); return run(true); } });
}
function productionLoad() {
  const path = require("node:path"), { performance } = require("node:perf_hooks"), crypto = require("node:crypto");
  return { testOnly: false, paths: paths(path.resolve(__dirname, "..")), verifier: integration("m32-create-approval"), grantHash: GRANT_SHA256,
    host() { need(process.platform === "win32" && process.arch === "x64" && process.version === "v24.13.0" &&
      process.execPath.toLowerCase() === NODE.toLowerCase(), "PINNED_RUNTIME_REQUIRED"); },
    now: Date.now, monotonicNow: () => performance.now(), ids: () => ({ batchId: crypto.randomBytes(12).toString("hex"), runId: crypto.randomUUID() }),
    qualify: () => integration("m32-stage1-chain").qualifyM32Stage1Chain(),
    // Lazy custody import only after durable PREPARED + immutable consumption.
    signApproval: (message, options) => require("./live-execution-custody-win32.js").signApprovalMessage(message, options),
    signTransaction: tx => require("./lib/wallet-execution-guard.js").signWithProcessKey(tx, OWNER),
    transport: ({ now, authenticate, physicalSend }) => {
      const identity = require("./node_modules/ethers").Wallet.createRandom();
      return require(STAGED + "delivery/m32-private-create-transport.cjs").createM32PrivateCreateTransport({ authAddress: identity.address, now,
        signMessage: text => authenticate(() => identity.signMessage(text)),
        fetchImpl: (location, options) => JSON.parse(options.body).method === "eth_sendBundle"
          ? physicalSend(() => globalThis.fetch(location, options)) : globalThis.fetch(location, options) });
    }, receiptWaitMs: 30000, pause: ms => new Promise(resolve => setTimeout(resolve, ms)) };
}
const production = createCommand(productionLoad);
// Owned temporary fixture only; no production loader/verifier/root/clock injection.
function createFixture(input) {
  const fs = require("node:fs"), path = require("node:path");
  const directory = fs.mkdtempSync(path.join(TEMP, "m32-attended-test-")), p = paths(directory);
  try {
    for (const key of ["grant", "registry", "source", "compiledArtifact", "rehearsal"]) {
      need(Buffer.isBuffer(input[key + "Bytes"]), "TEST_BYTES_REQUIRED"); fs.mkdirSync(path.dirname(p[key]), { recursive: true }); fs.writeFileSync(p[key], input[key + "Bytes"], { flag: "wx" });
    }
    const verifier = integration("m32-create-approval").TEST_ONLY.createVerifier({ registrySha256: "0x" + sha(input.registryBytes) });
    const receiptWaitMs = input.adapters.receiptWaitMs ?? 0;
    need(Number.isSafeInteger(receiptWaitMs) && receiptWaitMs >= 0 && receiptWaitMs <= 30000, "TEST_RECEIPT_WAIT_INVALID");
    let disposed = false;
    const load = () => { need(!disposed, "TEST_CLOSED"); return { ...input.adapters, testOnly: true, paths: p, verifier,
      grantHash: sha(input.grantBytes), host() { checkedPath(directory); }, receiptWaitMs }; };
    return Object.freeze({ ...createCommand(load), provenance: "TEST_ONLY", paths: p,
      restart: () => createCommand(load), cleanup() { if (!disposed) { disposed = true; fs.rmSync(directory, { recursive: true, force: true }); } } });
  } catch (e) { fs.rmSync(directory, { recursive: true, force: true }); throw e; }
}
module.exports = Object.freeze({ ...production, TEST_ONLY: Object.freeze({ createFixture }) });
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 0) console.log("Usage: deploy-m32-attended.cjs --check | --execute (Stage1 only; no retries)");
  else if (args.length !== 1 || !["--check", "--execute"].includes(args[0])) { console.log("M32_ATTENDED_ARGUMENTS_REJECTED"); process.exitCode = 2; }
  else production[args[0] === "--check" ? "check" : "execute"]().then(result => {
    console.log(JSON.stringify(result)); if (result.status === "HOLD") process.exitCode = 1;
  }, () => { console.log("M32_ATTENDED_HOLD"); process.exitCode = 1; });
}
