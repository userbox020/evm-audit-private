#!/usr/bin/env node
// tools/solana-fork-harness.js
//
// Bounded local Solana fork harness (milestone: prove validator + clone + local tx works).
//
// SECRETS CONTRACT (do not weaken):
//   * The upstream RPC endpoint is read from rpc_endpoints.txt at runtime and held in this
//     process's memory only. It is NEVER printed, logged, summarized, hashed, persisted as a
//     value, or placed on any child-process argv.
//   * solana-test-validator only ever receives http://127.0.0.1:<relayPort> via --url.
//   * The relay binds loopback only, rejects non-loopback clients, and denies all
//     state-changing RPC methods (no sendTransaction / requestAirdrop / simulate).
//   * Evidence records method names and byte counts, never endpoint values or hostnames.
//
// Usage: node tools/solana-fork-harness.js
// Exit 0 on full success (clone read-back + local tx confirmed), non-zero otherwise.

"use strict";

const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");

const IS_WIN = process.platform === "win32";
const EXE = IS_WIN ? ".exe" : "";
const WORKSPACE = path.resolve(__dirname, "..");
// Windows host uses the checked-out Windows bundle; Linux (WSL2) uses the pinned Linux
// bundle under a Linux-native ext4 path. Override with SOLANA_HARNESS_BIN_DIR if needed.
const DEFAULT_BIN_DIR = IS_WIN
  ? path.join(WORKSPACE, "tools", "solana", "releases", "3.1.14", "solana-release", "bin")
  : path.join(
      process.env.HOME || "/home/mruserbox",
      ".local", "share", "solana-fork-harness", "v3.1.14", "solana-release", "bin"
    );
const BIN_DIR = process.env.SOLANA_HARNESS_BIN_DIR || DEFAULT_BIN_DIR;
const VALIDATOR_BIN = path.join(BIN_DIR, `solana-test-validator${EXE}`);
const ENDPOINTS_FILE = process.env.SOLANA_HARNESS_ENDPOINTS || path.join(WORKSPACE, "rpc_endpoints.txt");
const EVIDENCE_DIR = process.env.SOLANA_HARNESS_EVIDENCE_DIR
  || path.join(WORKSPACE, "reports", "raw", "fast", "solana-fork-harness");

// Public, well-known Solana mainnet genesis hash (not a secret).
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

// Small bounded clone set: two mints (data-bearing) + one program (executable).
const CLONES = [
  { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", label: "usdc-mint" },
  { address: "So11111111111111111111111111111111111111112", label: "wrapped-sol-mint" },
  { address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", label: "spl-token-program" },
];

const CAPS = {
  upstreamTimeoutMs: 20000,
  requestBytes: 8 * 1024 * 1024,
  healthTimeoutMs: Number(process.env.SOLANA_HARNESS_HEALTH_MS || 120000),
  maxCandidates: 10,
  txTimeoutMs: 30000,
};

const DENIED_METHODS = new Set([
  "sendTransaction",
  "sendRawTransaction",
  "requestAirdrop",
  "simulateTransaction",
  "sendBundle",
]);

function methodAllowed(method) {
  if (typeof method !== "string") return false;
  if (DENIED_METHODS.has(method)) return false;
  return /^(get|is)/.test(method);
}

function isLoopback(remote) {
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// 1. Toolchain versions (no Rust required for validator + clone + local tx)
// ---------------------------------------------------------------------------
function captureVersion(bin, args) {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 30000, windowsHide: true });
  const out = `${r.stdout || ""}${r.stderr || ""}`.trim().split(/\r?\n/)[0] || "";
  return { ok: r.status === 0, output: out };
}

function captureToolchain() {
  return {
    solana: captureVersion(path.join(BIN_DIR, `solana${EXE}`), ["--version"]),
    validator: captureVersion(VALIDATOR_BIN, ["--version"]),
    keygen: captureVersion(path.join(BIN_DIR, `solana-keygen${EXE}`), ["--version"]),
    cargoBuildSbf: captureVersion(path.join(BIN_DIR, `cargo-build-sbf${EXE}`), ["--version"]),
  };
}

// ---------------------------------------------------------------------------
// 2. Endpoint discovery (in-memory only) + chain-identity qualification
// ---------------------------------------------------------------------------
function readSolanaCandidates() {
  const text = fs.readFileSync(ENDPOINTS_FILE, "utf8");
  const urls = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!/solana|helius|rpcpool|mainnet-beta/i.test(line)) continue;
    const m = line.match(/https?:\/\/[^\s\]\)]+/);
    if (!m) continue;
    const u = m[0].replace(/[.,;]+$/, "");
    if (u.includes("...") || u.includes("<") || u.includes(">")) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    urls.push(u);
    if (urls.length >= CAPS.maxCandidates) break;
  }
  return urls;
}

// Raw pass-through: the relay must NOT JSON.parse/stringify upstream payloads, because
// Solana returns u64 values (e.g. rentEpoch = 18446744073709551615) that JavaScript
// Number cannot represent; a round-trip would emit 1.8446744073709552e19 and break
// the validator's clone deserialization. Forward exact bytes instead.
async function upstreamRaw(endpoint, bodyText, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: bodyText,
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error("upstream-http-error");
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

async function upstreamCall(endpoint, body, timeoutMs) {
  return JSON.parse(await upstreamRaw(endpoint, JSON.stringify(body), timeoutMs));
}

// Try candidates in bounded order; accept the first whose genesis hash matches mainnet.
// Returns the endpoint only in-memory. Never logs or returns diagnostics containing it.
async function qualifyEndpoint() {
  const candidates = readSolanaCandidates();
  let qualified = null;
  let attempts = 0;
  for (const ep of candidates) {
    attempts += 1;
    try {
      const r = await upstreamCall(ep, { jsonrpc: "2.0", id: 1, method: "getGenesisHash", params: [] }, 6000);
      if (r && r.result === MAINNET_GENESIS) {
        qualified = ep;
        break;
      }
    } catch {
      // candidate unusable; try next
    }
  }
  if (!qualified) throw new Error("no-qualified-solana-mainnet-endpoint");
  return { endpoint: qualified, candidatesTested: attempts };
}

// ---------------------------------------------------------------------------
// 3. Loopback relay
// ---------------------------------------------------------------------------
function startRelay(endpoint) {
  const counts = Object.create(null);
  const denied = Object.create(null);
  let bytesIn = 0;
  let bytesOut = 0;

  const server = http.createServer((req, res) => {
    const remote = req.socket.remoteAddress || "";
    if (req.method !== "POST" || !isLoopback(remote)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n <= CAPS.requestBytes) chunks.push(c);
    });
    req.on("end", async () => {
      if (n > CAPS.requestBytes) {
        res.writeHead(413);
        res.end();
        return;
      }
      let payload;
      let rawRequest;
      try {
        rawRequest = Buffer.concat(chunks).toString("utf8");
        payload = JSON.parse(rawRequest);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      const list = Array.isArray(payload) ? payload : [payload];
      for (const x of list) {
        const method = x && x.method;
        if (!methodAllowed(method)) {
          denied[String(method)] = (denied[String(method)] || 0) + 1;
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: (x && x.id) !== undefined ? x.id : null,
            error: { code: -32601, message: "relay-method-denied" },
          }));
          return;
        }
        counts[method] = (counts[method] || 0) + 1;
      }
      bytesIn += n;
      try {
        // Forward exact upstream bytes (no JSON round-trip) to preserve u64 precision.
        const text = await upstreamRaw(endpoint, rawRequest, CAPS.upstreamTimeoutMs);
        const body = Buffer.from(text);
        bytesOut += body.length;
        res.writeHead(200, { "content-type": "application/json", "content-length": body.length });
        res.end(body);
      } catch {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: (list[0] && list[0].id) !== undefined ? list[0].id : null,
          error: { code: -32000, message: "relay-upstream-read-failed" },
        }));
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        port: server.address().port,
        stats: () => ({ methods: counts, deniedMethods: denied, bytesIn, bytesOut }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// 4. Ports + validator lifecycle
// ---------------------------------------------------------------------------
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}

async function findConsecutiveFree(start, span) {
  for (let p = start; p < start + span; p++) {
    if ((await portFree(p)) && (await portFree(p + 1))) return p;
  }
  throw new Error("no-free-validator-port");
}

// The validator needs a free gossip port plus a contiguous dynamic port range; its
// defaults (8000 / 8000-10000) can collide with unrelated distro services.
async function findFreeRange(start, span, need) {
  for (let p = start; p < start + span; p++) {
    let allFree = true;
    for (let i = 0; i < need; i++) {
      if (!(await portFree(p + i))) { allFree = false; break; }
    }
    if (allFree) return p;
  }
  throw new Error("no-free-dynamic-port-range");
}

async function localCall(url, method, params = [], timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`local-http-${resp.status}`);
    const json = await resp.json();
    if (json.error) throw new Error(`local-rpc-${json.error.message}`);
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await localCall(url, "getHealth", [], 3000)) === "ok") return true;
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  return false;
}

// HTTP-only signature confirmation. Do NOT use web3's websocket-backed
// confirmTransaction/sendAndConfirmTransaction against a local validator: the
// rpc-websockets client is configured with max_reconnects: Infinity, and if the
// pubsub socket is not yet reachable it retries forever and keeps this process
// alive after the milestone completes.
async function waitForSignature(connection, signature, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const r = await connection.getSignatureStatus(signature, { searchTransactionHistory: true });
    last = r && r.value ? r.value : null;
    if (last && (last.confirmationStatus === "confirmed" || last.confirmationStatus === "finalized")) return last;
    if (last && last.err) return last;
    await sleep(500);
  }
  return last;
}

// Sanitize validator logs: never allow any non-loopback URL text into evidence.
function sanitizeLog(text) {
  return text.replace(/https?:\/\/[^\s"']+/g, (u) =>
    /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/.test(u) ? u : "<redacted-nonlocal-url>"
  );
}

// ---------------------------------------------------------------------------
// 5. Main
// ---------------------------------------------------------------------------
async function main() {
  const evidence = {
    schema: "solana-fork-harness/1",
    generatedAt: new Date().toISOString(),
    milestone: "validator + bounded --clone + trivial local transaction",
    host: null,
    toolchain: null,
    relay: null,
    clones: [],
    transaction: null,
    result: "UNKNOWN",
    unproven: [],
  };

  if (!fs.existsSync(VALIDATOR_BIN)) throw new Error("validator-binary-missing");

  evidence.host = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    binDir: BIN_DIR,
    ledgerRoot: process.env.SOLANA_HARNESS_LEDGER_ROOT || os.tmpdir(),
  };

  evidence.toolchain = captureToolchain();
  console.error(`[harness] solana: ${evidence.toolchain.solana.output}`);
  console.error(`[harness] validator: ${evidence.toolchain.validator.output}`);

  console.error("[harness] qualifying a read-only Solana mainnet endpoint (in-memory)...");
  const { endpoint, candidatesTested } = await qualifyEndpoint();
  console.error(`[harness] endpoint qualified after ${candidatesTested} candidate attempt(s); value held in memory only.`);

  const relay = await startRelay(endpoint);
  console.error(`[harness] relay listening on 127.0.0.1:${relay.port} (loopback only)`);

  const rpcPort = await findConsecutiveFree(8899, 500);
  const faucetPort = await findConsecutiveFree(9900, 500);
  const dynamicPortLo = await findFreeRange(18000, 500, 50);
  const gossipPort = dynamicPortLo;
  const dynamicPortRange = `${dynamicPortLo}-${dynamicPortLo + 49}`;
  // Ledger + temp state must be Linux-native (ext4) on WSL2: DrvFS /mnt/c lacks real
  // symlink and permission semantics, which the validator needs.
  const ledgerRoot = process.env.SOLANA_HARNESS_LEDGER_ROOT || os.tmpdir();
  if (!IS_WIN && /^\/mnt\/[a-z]\//i.test(path.resolve(ledgerRoot) + "/")) {
    throw new Error("ledger-root-not-linux-native");
  }
  const tmpRoot = fs.mkdtempSync(path.join(ledgerRoot, "solana-fork-harness-"));
  const ledgerDir = path.join(tmpRoot, "ledger");

  const relayUrl = `http://127.0.0.1:${relay.port}`;
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;

  const args = [
    "--reset",
    "--ledger", ledgerDir,
    "--url", relayUrl,
    "--rpc-port", String(rpcPort),
    "--faucet-port", String(faucetPort),
    "--gossip-port", String(gossipPort),
    "--dynamic-port-range", dynamicPortRange,
  ];
  for (const c of CLONES) args.push("--clone", c.address);

  let logBuf = "";
  const child = spawn(VALIDATOR_BIN, args, {
    cwd: tmpRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => { if (logBuf.length < 200000) logBuf += d.toString(); });
  child.stderr.on("data", (d) => { if (logBuf.length < 200000) logBuf += d.toString(); });

  let exitInfo = null;
  child.on("exit", (code, signal) => { exitInfo = { code, signal }; });

  let ok = false;
  try {
    console.error(`[harness] validator starting; cloning ${CLONES.length} accounts via loopback relay...`);
    const healthy = await waitForHealth(rpcUrl, CAPS.healthTimeoutMs);
    if (!healthy) {
      throw new Error("validator-health-timeout");
    }
    console.error(`[harness] validator healthy on ${rpcUrl}`);

    // --- Clone read-back from the LOCAL validator ---
    for (const c of CLONES) {
      const info = await localCall(rpcUrl, "getAccountInfo", [c.address, { encoding: "base64" }], 20000);
      if (!info || !info.value) {
        evidence.clones.push({ label: c.label, address: c.address, present: false });
        continue;
      }
      const raw = Buffer.from(info.value.data[0], "base64");
      evidence.clones.push({
        label: c.label,
        address: c.address,
        present: true,
        lamports: info.value.lamports,
        owner: info.value.owner,
        executable: info.value.executable,
        dataLen: raw.length,
        dataSha256: sha256Hex(raw),
        slot: info.context ? info.context.slot : null,
      });
    }
    const allCloned = evidence.clones.length === CLONES.length && evidence.clones.every((c) => c.present);
    console.error(`[harness] clone read-back: ${allCloned ? "ALL PRESENT" : "MISSING ACCOUNT(S)"}`);
    for (const c of evidence.clones) {
      console.error(`[harness]   ${c.label}: present=${c.present} owner=${c.owner || "-"} len=${c.dataLen || "-"} exec=${c.executable}`);
    }
    if (!allCloned) throw new Error("clone-readback-incomplete");

    // --- One trivial local transaction: airdropped in-memory keypair self-transfer ---
    const web3 = require("@solana/web3.js");
    const connection = new web3.Connection(rpcUrl, "confirmed");
    const payer = web3.Keypair.generate();

    const airdropSig = await connection.requestAirdrop(
      payer.publicKey, 2 * web3.LAMPORTS_PER_SOL
    );
    const airdropStatus = await waitForSignature(connection, airdropSig, CAPS.txTimeoutMs);
    const balanceBefore = await connection.getBalance(payer.publicKey, "confirmed");

    const tx = new web3.Transaction().add(
      web3.SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: payer.publicKey,
        lamports: 1000,
      })
    );
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.sign(payer);
    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 5,
    });
    const statusValue = await waitForSignature(connection, signature, CAPS.txTimeoutMs);
    const status = { value: statusValue };
    const balanceAfter = await connection.getBalance(payer.publicKey, "confirmed");

    // Independent read-back of the landed transaction from the LOCAL validator.
    // meta.fee / preBalances / postBalances are the strongest local proof that the
    // transaction actually executed here (and are not an artifact of a stale balance read).
    let txDetail = null;
    for (let i = 0; i < 10 && !txDetail; i++) {
      txDetail = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (!txDetail) await sleep(1000);
    }
    const meta = txDetail && txDetail.meta ? txDetail.meta : null;

    evidence.transaction = {
      kind: "self-transfer",
      payer: payer.publicKey.toBase58(),
      airdropSignature: airdropSig,
      airdropStatus: airdropStatus ? airdropStatus.confirmationStatus : null,
      signature,
      confirmationStatus: status && status.value ? status.value.confirmationStatus : null,
      confirmations: status && status.value ? status.value.confirmations : null,
      slot: status && status.value ? status.value.slot : null,
      err: status && status.value ? status.value.err : null,
      detailFound: Boolean(txDetail),
      detailSlot: txDetail ? txDetail.slot : null,
      detailErr: meta ? meta.err : null,
      feeLamports: meta ? meta.fee : null,
      preBalances: meta ? meta.preBalances : null,
      postBalances: meta ? meta.postBalances : null,
      accountKeys: txDetail && txDetail.transaction && txDetail.transaction.message
        ? (txDetail.transaction.message.staticAccountKeys
            || txDetail.transaction.message.accountKeys || []).map((k) => k.toString())
        : null,
      balanceBefore,
      balanceAfter,
      deltaLamports: balanceAfter - balanceBefore,
      transferLamports: 1000,
    };
    console.error(`[harness] local tx signature: ${signature}`);
    console.error(`[harness] local tx status: ${evidence.transaction.confirmationStatus} slot=${evidence.transaction.slot}`);
    console.error(`[harness] local tx detail: found=${evidence.transaction.detailFound} fee=${evidence.transaction.feeLamports} err=${JSON.stringify(evidence.transaction.detailErr)}`);
    if (!signature || (status && status.value && status.value.err)) {
      throw new Error("local-transaction-failed");
    }
    if (!txDetail || (meta && meta.err)) {
      throw new Error("local-transaction-detail-unconfirmed");
    }

    ok = true;
    evidence.result = "PASS";
  } catch (err) {
    evidence.result = "FAIL";
    evidence.failure = String(err && err.message ? err.message : err);
    evidence.unproven = [
      "contract-fork-of-kamino-klend-not-attempted-in-this-milestone",
      "sbf-program-deployment-not-attempted",
    ];
    console.error(`[harness] FAILURE: ${evidence.failure}`);
    // Sanitized validator diagnostics (non-loopback URLs are redacted).
    const tail = sanitizeLog(logBuf).slice(-4000);
    if (tail.trim().length > 0) {
      console.error("[harness] --- sanitized validator log tail ---");
      console.error(tail);
      console.error("[harness] --- end validator log tail ---");
    }
  } finally {
    try { child.kill(IS_WIN ? undefined : "SIGKILL"); } catch { /* ignore */ }
    await sleep(1500);
    if (exitInfo === null && IS_WIN) {
      try { spawnSync("taskkill", ["/F", "/PID", String(child.pid)], { windowsHide: true, timeout: 5000 }); } catch { /* ignore */ }
    }
    try { relay.server.close(); } catch { /* ignore */ }

    const rs = relay.stats();
    evidence.relay = {
      bind: "127.0.0.1",
      candidatesTested,
      methods: rs.methods,
      deniedMethods: rs.deniedMethods,
      bytesIn: rs.bytesIn,
      bytesOut: rs.bytesOut,
    };
    evidence.validator = {
      exitCode: exitInfo ? exitInfo.code : null,
      logSha256: sha256Hex(Buffer.from(sanitizeLog(logBuf))),
      logLen: logBuf.length,
      redacted: true,
    };
    evidence.unproven = [
      "sbf-program-build-and-deploy (not required for this milestone)",
      "kamino-klend execution path (separate lane)",
    ];

    try {
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
      fs.writeFileSync(path.join(EVIDENCE_DIR, "evidence.json"), JSON.stringify(evidence, null, 2), "utf8");
      console.error(`[harness] evidence written: ${path.join(EVIDENCE_DIR, "evidence.json")}`);
    } catch (e) {
      console.error(`[harness] evidence write failed: ${e.message}`);
    }
  }

  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error(`[harness][fatal] ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});
