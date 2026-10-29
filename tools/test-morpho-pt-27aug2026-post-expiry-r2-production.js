#!/usr/bin/env node
"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto"),
  path = require("node:path"),
  { EventEmitter } = require("node:events");
const adapter = require("./lib/morpho-pt-27aug2026-post-expiry-r2-production-adapter.js"),
  capture = require("./capture-morpho-pt-27aug2026-post-expiry-r2-production.js"),
  validator = require("./validate-morpho-pt-27aug2026-post-expiry-r2-production.js"),
  profile = require("./morpho-pt-27aug2026-post-expiry-r1-profile.js"),
  engine = require("./lib/morpho-pt-27aug2026-post-expiry-r2-gate.js"),
  base = require("./lib/r1-evm-read-gate.js"),
  {
    POLICY,
    POLICY_HASH,
  } = require("./morpho-pt-27aug2026-post-expiry-r2-production-policy.js");
const E = 1787788800,
  NOW = (E + 80) * 1000,
  NONCE = "0123456789abcdef".repeat(4),
  MOCK_CODE = "0x6001600055",
  OUT = path.resolve("/out"),
  word = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, "0"),
  encoded = (v) => `0x${word(v)}`,
  hash = (n) => `0x${BigInt(n).toString(16).padStart(64, "0")}`,
  state = (n) =>
    `0x${BigInt(n + 9000000)
      .toString(16)
      .padStart(64, "0")}`,
  timestamp = (n) => (n < 50 ? E - (50 - n) : E + (n - 50)),
  header = (n) => ({
    number: `0x${BigInt(n).toString(16)}`,
    hash: hash(n),
    parentHash: hash(Math.max(0, n - 1)),
    stateRoot: state(n),
    timestamp: `0x${BigInt(timestamp(n)).toString(16)}`,
  }),
  round = (answer, updated) =>
    `0x${word(1)}${word(answer)}${word(updated)}${word(updated)}${word(1)}`;
let tests = 0,
  assertions = 0,
  mutations = 0,
  network = 0;
const caseTest = (...args) => {
    tests++;
    return test(...args);
  },
  a = new Proxy(assert, {
    get(t, k) {
      return typeof t[k] === "function"
        ? (...x) => {
            assertions++;
            return t[k](...x);
          }
        : t[k];
    },
  }),
  throws = (fn, code) => {
    assertions++;
    assert.throws(fn, (e) => e?.code === code);
  },
  rejects = async (fn, code) => {
    assertions++;
    await assert.rejects(fn, (e) => e?.code === code);
  },
  clone = (v) => JSON.parse(JSON.stringify(v));
const BINDINGS = {
  productionHashes: {
    policy: "01".repeat(32),
    adapter: "02".repeat(32),
    capture: "03".repeat(32),
    validator: "04".repeat(32),
    test: "05".repeat(32),
    nativeSupervisorSource: "06".repeat(32),
    nativeSupervisorSourceCandidate: "07".repeat(32),
    nativeBuildManifest: "08".repeat(32),
    launcherSource: "09".repeat(32),
    launcherBinary: "0a".repeat(32),
  },
  offlineHashes: {
    profile: "11".repeat(32),
    engine: "12".repeat(32),
    validator: "13".repeat(32),
    test: "14".repeat(32),
    disabledCapture: "15".repeat(32),
    sharedGate: "16".repeat(32),
    inventoryParser: "17".repeat(32),
  },
  runtime: {
    nodeVersion: process.versions.node,
    platform: "linux",
    arch: "x64",
    toolchain: `node-${process.versions.modules}`,
  },
  bridge: {
    inputMode: POLICY.input.mode,
    exclusiveWriterFramedGo: true,
    windowsPeerEofRequired: false,
    linuxWriterClosedAfterGo: true,
    bufferedTrailingBytesRejected: true,
    postGoChannelMonitored: true,
    inventoryReadAfterPermanentLock: true,
    goFrameLayout: {
      magic: POLICY.input.goMagic,
      version: POLICY.input.goVersion,
      type: POLICY.input.goType,
      sequence: POLICY.input.goSequence,
      bytes: POLICY.input.goBytes,
      terminal: POLICY.input.goTerminal,
      authCommitment: "SHA256_EXACT_PRELUDE",
    },
    nativeSupervisorDeadlineMs: POLICY.input.nativeSupervisorDeadlineMs,
    preGoDeadlineMs: POLICY.input.preGoDeadlineMs,
    postGoDeadlineMs: POLICY.input.postGoDeadlineMs,
    nativeSupervisorSourceSha256: "06".repeat(32),
    nativeSupervisorRuntimeSha256: "07".repeat(32),
    nativeSupervisorSourceCandidateSha256: "07".repeat(32),
    nativeBuildManifestSha256: "08".repeat(32),
    launcherSourceSha256: "09".repeat(32),
    launcherBinarySha256: "0a".repeat(32),
    nodeExecutableSha256: "0b".repeat(32),
    nodeExecutablePath: POLICY.input.nodePath,
    nodeVersion: POLICY.input.nodeVersion,
    productionCapturePath: POLICY.input.capturePath,
    productionCaptureSha256: "03".repeat(32),
    productionCaptureIdentity: { dev: "1", ino: "2" },
    runtimeFilePaths: [POLICY.input.capturePath],
    nativeMountPolicy: clone(POLICY.input.mountPolicy),
    nativeMountIdentity: {
      mountId: 1,
      majorMinor: "0:1",
      root: "/",
      mountPoint: "/",
      fsType: "ext4",
      source: "/dev/test",
    },
  },
};
function permit() {
  return {
    schema: POLICY.permit.schema,
    permitId: "aa".repeat(32),
    mode: POLICY.mode,
    approvalNonceCommitment: adapter.sha256(
      `morpho-production-nonce/v1\0${NONCE}`,
    ),
    issuedAt: NOW - 1000,
    notBefore: E * 1000,
    expiresAt: NOW + 1000,
    policyHash: POLICY_HASH,
    productionHashes: clone(BINDINGS.productionHashes),
    offlineHashes: clone(BINDINGS.offlineHashes),
    runtime: clone(BINDINGS.runtime),
    bridge: clone(BINDINGS.bridge),
    policy: {
      hash: POLICY_HASH,
      profileHash: POLICY.profileHash,
      chainId: 1,
      expiryTimestamp: E,
      inputMode: POLICY.input.mode,
    },
    limits: clone(POLICY.limits),
    schemas: clone(POLICY.schemas),
    output: clone(POLICY.output),
    hardStops: clone(POLICY.hardStops),
  };
}
function inventory(n = 9) {
  return Buffer.from(
    Array.from(
      { length: n },
      (_, i) =>
        `[EVM chain=1 mainnet role=RPC ${i < 2 ? "premium " : ""}capabilityRank=${100 - i * 10} family=authority-op-${i}]\nhttps://rpc-${i}.invalid/private-${i}?key=secret-${i}`,
    ).join("\n") + "\n",
  );
}
function operation(to, data) {
  return profile.profile.operations.find(
    (x) => x.address === to.toLowerCase() && x.data === data.toLowerCase(),
  );
}
function expectedLinear(t) {
  return engine.expectedLinear(t, profile.profile);
}
function callResult(to, data, n) {
  if (to.toLowerCase() === base.MULTICALL3) return encoded(n);
  const op = operation(to, data),
    t = timestamp(n),
    linear = expectedLinear(t);
  if (!op) throw new Error("unexpected");
  if (op.id.startsWith("morpho-market-")) return `0x${word(1).repeat(6)}`;
  if (op.id.startsWith("morpho-params-")) return op.result.value;
  if (op.id.startsWith("oracle-price-")) {
    const u = 981484000000000000n,
      q = op.id.endsWith("-par") ? 1000000000000n : 1025641025641n;
    return encoded((linear * u) / q);
  }
  if (op.id.endsWith("-wrapper")) return round(linear, t);
  if (op.id.endsWith("-inner")) return round(linear, 0);
  if (op.id === "round-underlying") return round(981484000000000000n, t - 10);
  if (op.id === "round-quote-discounted") return round(1025641025641n, t);
  if (op.id === "round-quote-par") return round(1000000000000n, t);
  if (op.id.endsWith("-expiry")) return encoded(E);
  if (op.id.endsWith("-is-expired")) return encoded(t >= E ? 1 : 0);
  throw new Error(op.id);
}
function syntheticHttp({ probeFailure = 0 } = {}) {
  let calls = 0;
  return async (config) => {
    network += 0;
    const request = JSON.parse(config.body.toString()),
      m = request.method,
      p = request.params;
    calls++;
    let result;
    if (probeFailure && calls === probeFailure)
      throw new Error("private endpoint secret");
    if (m === "eth_chainId") result = "0x1";
    else if (m === "eth_getBlockByNumber")
      result = header(p[0] === "finalized" ? 100 : Number(BigInt(p[0])));
    else if (m === "eth_getCode") result = MOCK_CODE;
    else {
      const n = Number(BigInt(p[1].blockHash));
      result = callResult(p[0].to, p[0].data, n);
    }
    return {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-encoding": "identity",
      },
      body: Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      ),
      redirected: false,
      remoteAddress: "8.8.8.8",
      tlsVersion: "TLSv1.3",
      elapsedMs: 1,
      counters: {
        dns: 0,
        socket: 1,
        connect: 1,
        tls: 1,
        data: 1,
        requestDestroyed: 1,
        socketDestroyed: 1,
        agentDestroyed: 1,
      },
    };
  };
}
function divergentHttp() {
  const heights = [103, 102, 101, 100, 100, 100, 100, 100, 100];
  return async (config) => {
    const request = JSON.parse(config.body.toString()),
      m = request.method,
      p = request.params,
      index = Number(config.hostname.match(/rpc-(\d+)/u)[1]),
      n =
        p[0] === "finalized"
          ? heights[index]
          : m === "eth_getBlockByNumber"
            ? Number(BigInt(p[0]))
            : null;
    let result;
    if (m === "eth_chainId") result = "0x1";
    else if (m === "eth_getBlockByNumber") {
      result = header(n);
      if ((n === 102 && index === 0) || (n === 101 && index === 1))
        result = { ...result, stateRoot: hash(800000 + index + n) };
    } else if (m === "eth_getCode") result = MOCK_CODE;
    else
      result = callResult(p[0].to, p[0].data, Number(BigInt(p[1].blockHash)));
    return {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-encoding": "identity",
      },
      body: Buffer.from(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      ),
      redirected: false,
      remoteAddress: "8.8.8.8",
      tlsVersion: "TLSv1.3",
      elapsedMs: 1,
      counters: {
        dns: 0,
        socket: 1,
        connect: 1,
        tls: 1,
        data: 1,
        requestDestroyed: 1,
        socketDestroyed: 1,
        agentDestroyed: 1,
      },
    };
  };
}
class LockFs {
  constructor() {
    this.nodes = new Map([
      [OUT, { type: "dir", dev: 1, ino: 1, data: Buffer.alloc(0) }],
    ]);
    this.fds = new Map();
    this.next = 10;
    this.mountInfoText = "1 0 0:1 / / rw - ext4 /dev/test rw\n";
  }
  realpathSync(p) {
    p = path.resolve(p);
    const m = p.match(/[\\/]proc[\\/]self[\\/]fd[\\/](\d+)$/u);
    return m ? this.fds.get(Number(m[1]))?.path : p;
  }
  lstatSync(p) {
    return this.stat(path.resolve(p));
  }
  stat(p) {
    const n = this.nodes.get(p);
    if (!n) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return {
      dev: n.dev,
      ino: n.ino,
      size: n.data.length,
      mtimeMs: 1,
      uid: 1000,
      mode: n.type === "dir" ? 0o40700 : 0o100600,
      isDirectory: () => n.type === "dir",
      isFile: () => n.type === "file",
      isSymbolicLink: () => false,
    };
  }
  openSync(p, flag) {
    p = String(p).replace(
      /[\\/]proc[\\/]self[\\/]fd[\\/](\d+)/u,
      (_x, id) => this.fds.get(Number(id)).path,
    );
    p = path.resolve(p);
    if (flag === "r") {
      const fd = this.next++;
      this.fds.set(fd, { path: p });
      return fd;
    }
    if (this.nodes.has(p))
      throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    this.nodes.set(p, {
      type: "file",
      dev: 1,
      ino: this.nodes.size + 1,
      data: Buffer.alloc(0),
    });
    const fd = this.next++;
    this.fds.set(fd, { path: p });
    return fd;
  }
  fstatSync(fd) {
    return this.stat(this.fds.get(fd).path);
  }
  writeFileSync(fd, v) {
    this.nodes.get(this.fds.get(fd).path).data = Buffer.from(v);
  }
  fsyncSync() {}
  closeSync(fd) {
    this.fds.delete(fd);
  }
}
class AnchorFs extends LockFs {
  constructor() {
    super();
    this.constants = { O_RDONLY: 1, O_DIRECTORY: 2, O_NOFOLLOW: 4 };
    this.syncs = [];
    this.mountInfoText = "1 0 0:1 / / rw - ext4 /dev/test rw\n";
  }
  proc(p) {
    return path.resolve(
      String(p).replace(
        /[\\/]proc[\\/]self[\\/]fd[\\/](\d+)/u,
        (_x, id) => this.fds.get(Number(id)).path,
      ),
    );
  }
  openSync(p, flag, mode) {
    p = this.proc(p);
    if (typeof flag === "number" && this.nodes.has(p)) {
      const fd = this.next++;
      this.fds.set(fd, { path: p });
      return fd;
    }
    return super.openSync(p, flag, mode);
  }
  realpathSync(p) {
    return super.realpathSync(p);
  }
  lstatSync(p) {
    return this.stat(this.proc(p));
  }
  statfsSync() {
    return { type: 0xef53n, fsid: 1 };
  }
  readdirSync(p) {
    p = this.proc(p);
    return [...this.nodes.keys()]
      .filter((x) => path.dirname(x) === p)
      .map((x) => path.basename(x));
  }
  mkdirSync(p) {
    p = this.proc(p);
    if (this.nodes.has(p))
      throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    this.nodes.set(p, {
      type: "dir",
      dev: 1,
      ino: this.nodes.size + 1,
      data: Buffer.alloc(0),
    });
  }
  rmdirSync(p) {
    this.nodes.delete(this.proc(p));
  }
  linkSync(a, b) {
    a = this.proc(a);
    b = this.proc(b);
    if (this.nodes.has(b))
      throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
    this.nodes.set(b, this.nodes.get(a));
  }
  unlinkSync(p) {
    this.nodes.delete(this.proc(p));
  }
  fsyncSync(fd) {
    this.syncs.push(fd);
  }
}
function fakeClient({
  local = false,
  remoteAddress = local ? "::1" : "2606:4700:4700::1111",
  headers = { "content-type": "application/json" },
  truncated = false,
} = {}) {
  let options, agentOptions;
  class Agent {
    constructor(o) {
      agentOptions = o;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const client = {
    request(o, onResponse) {
      options = o;
      const req = new EventEmitter();
      req.destroyed = false;
      req.destroy = () => {
        req.destroyed = true;
      };
      req.end = () => {
        const socket = new EventEmitter();
        socket.destroyed = false;
        socket.destroy = () => {
          socket.destroyed = true;
        };
        socket.remoteAddress = remoteAddress;
        socket.authorized = true;
        socket.servername = o.servername;
        socket.getProtocol = () => (local ? null : "TLSv1.3");
        req.emit("socket", socket);
        socket.emit("connect");
        if (!local) socket.emit("secureConnect");
        const response = new EventEmitter();
        response.statusCode = 200;
        response.headers = headers;
        response.complete = !truncated;
        onResponse(response);
        response.emit(
          "data",
          Buffer.from('{"jsonrpc":"2.0","id":1,"result":"0x1"}'),
        );
        response.emit("end");
      };
      return req;
    },
  };
  return {
    client,
    Agent,
    get options() {
      return options;
    },
    get agentOptions() {
      return agentOptions;
    },
  };
}
caseTest("policy is frozen, address-free and exact", () => {
  a.equal(Object.isFrozen(POLICY), true);
  a.equal(POLICY.chainId, 1);
  a.equal(POLICY.expiryTimestamp, E);
  a.equal(POLICY.profileHash, profile.PROFILE_HASH);
  a.equal(POLICY.limits.outerRequests, 255);
  a.equal(POLICY.limits.outerEvidenceRequests, 92);
  a.equal(POLICY.input.nativeStage, "RUNTIME_COPIES_QUALIFIED"); a.equal(POLICY.input.nativeStaged, true);
  a.equal(POLICY.input.nativeBlocker, "NATIVE_R2_PERMIT_REQUIRED");
  a.equal(POLICY.input.nodeExecutableSha256, "53fb205ae78805130177e24bcb459a69a1518c8d98f8965f31d85aae7ea840fc");
  a.doesNotMatch(JSON.stringify(POLICY), /0x[0-9a-f]{40}/u);
});
caseTest(
  "permit nonce argv env hash runtime and time authority fail before reads",
  async () => {
    a.equal(
      adapter.validateInvocation({
        args: [`--mode=${POLICY.mode}`],
        env: { PATH: "x" },
        execArgv: [],
        stdinBytes: Buffer.from(NONCE),
        stdinIsPipe: true,
      }),
      NONCE,
    );
    adapter.validatePermit(permit(), {
      nonce: NONCE,
      bindings: BINDINGS,
      now: NOW,
    });
    for (const [mutate, code] of [
      [(x) => (x.productionHashes.adapter = "00".repeat(32)), "PERMIT_HASH"],
      [(x) => (x.notBefore = E * 1000 - 1), "PERMIT_TIME"],
      [(x) => (x.expiresAt = x.issuedAt + 900001), "PERMIT_TIME"],
      [(x) => (x.runtime.platform = "win32"), "PERMIT_RUNTIME"],
      [(x) => (x.limits.retries = 1), "PERMIT_BINDING"],
    ]) {
      mutations++;
      const p = permit();
      mutate(p);
      throws(
        () =>
          adapter.validatePermit(p, {
            nonce: NONCE,
            bindings: BINDINGS,
            now: NOW,
          }),
        code,
      );
    }
    for (const [x, code] of [
      [
        {
          args: [],
          env: {},
          execArgv: [],
          stdinBytes: Buffer.from(NONCE),
          stdinIsPipe: true,
        },
        "ARGV",
      ],
      [
        {
          args: [`--mode=${POLICY.mode}`],
          env: { RPC_URL: "x" },
          execArgv: [],
          stdinBytes: Buffer.from(NONCE),
          stdinIsPipe: true,
        },
        "ENV",
      ],
      [
        {
          args: [`--mode=${POLICY.mode}`],
          env: {},
          execArgv: [],
          stdinBytes: Buffer.from("aa".repeat(32)),
          stdinIsPipe: true,
        },
        "NONCE_STDIN",
      ],
    ]) {
      mutations++;
      throws(() => adapter.validateInvocation(x), code);
    }
  },
);
caseTest(
  "authoritative annotated inventory requires explicit family, canonical dedup and approved headers",
  async () => {
    const parsed = adapter.parseInventory(inventory());
    a.equal(adapter.selectCandidates(parsed).length, 8);
    throws(() => adapter.selectCandidates(adapter.parseInventory(inventory(3))), "INVENTORY_FAMILIES");
    a.deepEqual(parsed[0].headers, {});
    for (const [text, code] of [
      [
        inventory().toString().replace(" family=authority-op-0", ""),
        "INVENTORY_EXPLICIT_FAMILY",
      ],
      [
        inventory()
          .toString()
          .replace(/authority-op-[1-8]/gu, "authority-op-0"),
        "INVENTORY_FAMILIES",
      ],
      [
        `${inventory(3)}[EVM chain=1 mainnet role=RPC capabilityRank=1 family=authority-extra]\nhttps://rpc-0.invalid/private-0?key=secret-0\n`,
        "INVENTORY_AUTHORITY",
      ],
      [
        `${inventory(3)}[keyless-relay family=authority-relay capabilityRank=1] http://8.8.8.8:8545/path\n`,
        "INVENTORY_RELAY",
      ],
    ]) {
      mutations++;
      throws(
        () =>
          adapter.selectCandidates(adapter.parseInventory(Buffer.from(text))),
        code,
      );
    }
  },
);
caseTest(
  "candidate ranking is capability then premium then inventory order",
  () => {
    const rows = [
        {
          endpoint: "https://a.invalid/",
          family: "fa1",
          premium: false,
          capability: 1,
          inventoryOrder: 0,
          transportClass: "DIRECT_HTTPS",
          headers: {},
        },
        {
          endpoint: "https://b.invalid/",
          family: "fb2",
          premium: false,
          capability: 80,
          inventoryOrder: 1,
          transportClass: "DIRECT_HTTPS",
          headers: {},
        },
        {
          endpoint: "https://c.invalid/",
          family: "fc3",
          premium: true,
          capability: 80,
          inventoryOrder: 2,
          transportClass: "DIRECT_HTTPS",
          headers: {},
        },
        {
          endpoint: "https://d.invalid/",
          family: "fd4",
          premium: false,
          capability: 80,
          inventoryOrder: 3,
          transportClass: "DIRECT_HTTPS",
          headers: {},
        },
        ...Array.from({length:5},(_,i)=>({endpoint:`https://x${i}.invalid/`,family:`fx${i}`,premium:false,capability:0,inventoryOrder:i+4,transportClass:"DIRECT_HTTPS",headers:{}})),
      ],
      selected = adapter.selectCandidates(rows);
    a.deepEqual(
      selected.map((x) => x.operatorFamily),
      ["fc3", "fb2", "fd4", "fa1", "fx0", "fx1", "fx2", "fx3"],
    );
  },
);
caseTest(
  "eligible pool is authoritative inventory first eight before ranking, never URL lexical",
  () => {
    const rows = Array.from({ length: 10 }, (_, inventoryOrder) => ({
        endpoint: `https://${inventoryOrder < 8 ? "z" : "a"}-${inventoryOrder}.invalid/`,
        family: `f${inventoryOrder}x`,
        premium: false,
        capability: inventoryOrder >= 8 ? 100 : inventoryOrder,
        inventoryOrder,
        transportClass: "DIRECT_HTTPS",
        headers: {},
      })).sort((x, y) => x.endpoint.localeCompare(y.endpoint)),
      selected = adapter.selectCandidates(rows);
    a.deepEqual(
      selected.map((x) => x.inventoryOrder),
      [7, 6, 5, 4, 3, 2, 1, 0],
    );
    a.equal(
      selected.some((x) => x.inventoryOrder >= 8),
      false,
    );
  },
);
caseTest(
  "relay grammar is literal loopback explicit-port root-only and credential-free",
  () => {
    const valid = Buffer.from(
        "[keyless-relay family=relay-one capabilityRank=100] http://127.0.0.1:8545/\n",
      ),
      parsed = adapter.parseInventory(valid);
    a.equal(parsed.length, 1);
    a.equal(parsed[0].transportClass, "LOCALHOST_KEYLESS_RELAY");
    for (const raw of [
      "http://127.0.0.1/",
      "http://127.0.0.1:8545/path",
      "http://127.0.0.1:8545/?x=1",
      "http://user@127.0.0.1:8545/",
      "http://127.0.0.1:8545/#x",
    ]) {
      mutations++;
      throws(
        () =>
          adapter.parseInventory(
            Buffer.from(
              `[keyless-relay family=relay-one capabilityRank=1] ${raw}\n`,
            ),
          ),
        "INVENTORY_RELAY",
      );
    }
    for (const cap of [101, 999]) {
      mutations++;
      throws(
        () =>
          adapter.parseInventory(
            Buffer.from(
              `[keyless-relay family=relay-one capabilityRank=${cap}] http://[::1]:8545/\n`,
            ),
          ),
        "INVENTORY_RELAY",
      );
    }
    mutations++;
    throws(
      () =>
        adapter.parseInventory(
          Buffer.from(
            "[keyless-relay family=relay-one capabilityRank=1] http://127.0.0.1:8545/ [header: authorization=x]\n",
          ),
        ),
      "INVENTORY_RELAY",
    );
  },
);
caseTest(
  "public IP classifier rejects special and mapped private while accepting normalized public peers",
  () => {
    for (const ip of [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.1.1",
      "172.16.0.1",
      "192.0.2.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "240.0.0.1",
      "::",
      "::1",
      "fe80::1",
      "fc00::1",
      "ff00::1",
      "2001:db8::1",
      "::ffff:127.0.0.1",
    ]) {
      mutations++;
      a.equal(adapter.isGlobalUnicast(ip), false, ip);
    }
    a.equal(adapter.isGlobalUnicast("8.8.8.8"), true);
    a.equal(adapter.isGlobalUnicast("2606:4700:4700::1111"), true);
    a.equal(adapter.sameIp("::ffff:8.8.8.8", "8.8.8.8"), true);
  },
);
caseTest("outer accounting enforces exact 255 and 92 boundaries", () => {
  const hs = adapter.selectCandidates(adapter.parseInventory(inventory())),
    ok = adapter.account();
  for (let i = 0; i < 92; i++) {
    ok.begin(hs[0]);
    ok.end();
  }
  for (let i = 92; i < 255; i++) {
    ok.begin(hs[1 + (i % 3)]);
    ok.end();
  }
  a.equal(ok.summary(hs).requests, 255);
  mutations++;
  throws(() => ok.begin(hs[0]), "OUTER_BUDGET");
  const per = adapter.account();
  for (let i = 0; i < 92; i++) {
    per.begin(hs[0]);
    per.end();
  }
  mutations++;
  throws(() => per.begin(hs[0]), "OUTER_BUDGET");
});
async function integrated(options = {}) {
  const fsOps = new LockFs(),
    syntheticPermit = {
      schema: "morpho-production-synthetic-permit/v1",
      purpose: "TEST_ONLY",
    };
  return adapter.runSyntheticTestOnly({
    args: [`--mode=${POLICY.mode}`],
    env: { PATH: "x" },
    execArgv: [],
    stdinBytes: Buffer.from(NONCE),
    stdinIsPipe: true,
    workspaceRoot: "/",
    output: OUT,
    fsOps,
    platform: "linux",
    filesystem: "ext4",
    clock: () => NOW,
    readFixed: (_r, file) =>
      file === "synthetic-permit.json"
        ? Buffer.from(JSON.stringify(syntheticPermit))
        : inventory(),
    qualifyOutput: () => {
      const fd = fsOps.openSync(OUT, "r"),
        s = fsOps.fstatSync(fd);
      return {
        fd,
        dev: s.dev,
        ino: s.ino,
        realPath: OUT,
        mount: clone(BINDINGS.bridge.nativeMountIdentity),
        closed: false,
      };
    },
    durability: () => {},
    resolveDns: async () => [{ address: "8.8.8.8" }],
    httpPost: syntheticHttp(),
    ...options,
  });
}
caseTest(
  "native-shaped synthetic path runs actual engine but cannot emit production schemas or publish",
  async () => {
    const original = crypto.createHash,
      updates = [];
    crypto.createHash = function (...x) {
      const h = original.apply(this, x),
        u = h.update;
      h.update = function (v, ...r) {
        updates.push(Buffer.isBuffer(v) ? v.toString("utf8") : String(v));
        return u.call(this, v, ...r);
      };
      return h;
    };
    let result;
    try {
      result = await integrated();
    } finally {
      crypto.createHash = original;
    }
    a.equal(result.status, "TEST_ONLY");
    a.equal(result.publishable, false);
    a.equal(result.operations, 34);
    a.equal(result.outer.requests <= 255, true);
    a.equal(result.outer.maxPerCandidateRequests <= 92, true);
    a.doesNotMatch(
      JSON.stringify(result),
      new RegExp(POLICY.schemas.validation, "u"),
    );
    a.doesNotMatch(
      updates.join("\n"),
      /rpc-[0-3]\.invalid|secret-[0-3]|authority-(?:alpha|beta|gamma|delta)/u,
    );
    a.equal(network, 0);
    await rejects(
      () =>
        adapter.runSyntheticTestOnly({
          args: [`--mode=${POLICY.mode}`],
          env: {},
          execArgv: [],
          stdinBytes: Buffer.from(NONCE),
          stdinIsPipe: true,
          workspaceRoot: "/",
          output: path.resolve("/", POLICY.output.root),
          fsOps: {},
          platform: "linux",
          filesystem: "ext4",
          clock: () => NOW,
          readFixed: () => Buffer.from(JSON.stringify(permit())),
        }),
      "TEST_ONLY_PRODUCTION_FORBIDDEN",
    );
  },
);
caseTest(
  "native path rejects injection and synthetic Windows fails before inventory lock or network",
  async () => {
    throws(
      () => capture.runNativeProduction({ clock: () => NOW }),
      "NATIVE_INJECTION_FORBIDDEN",
    );
    let reads = 0,
      dns = 0,
      http = 0;
    await rejects(
      () =>
        adapter.runSyntheticTestOnly({
          args: [`--mode=${POLICY.mode}`],
          env: {},
          execArgv: [],
          stdinBytes: Buffer.from(NONCE),
          stdinIsPipe: true,
          workspaceRoot: "/",
          output: OUT,
          fsOps: {},
          platform: "win32",
          filesystem: "ntfs",
          clock: () => NOW,
          readFixed: () => {
            reads++;
            return Buffer.from(JSON.stringify({ schema: "synthetic" }));
          },
          resolveDns: async () => {
            dns++;
          },
          httpPost: async () => {
            http++;
          },
        }),
      "PLATFORM_LINUX",
    );
    a.equal(reads, 1);
    a.equal(dns, 0);
    a.equal(http, 0);
  },
);
caseTest(
  "test-only seam never invokes a supplied production publisher",
  async () => {
    let published = 0;
    const result = await integrated({
      publisher: () => {
        published++;
        throw new Error("must not run");
      },
    });
    a.equal(result.publishable, false);
    a.equal(published, 0);
  },
);
caseTest(
  "orchestration observes permanent lock before DNS or HTTP",
  async () => {
    const ops = new AnchorFs();
    ops.nodes.set(path.join(OUT, POLICY.output.lock), {
      type: "file",
      dev: 1,
      ino: 99,
      data: Buffer.from("used\n"),
    });
    let dns = 0,
      http = 0;
    const result = await adapter.runSyntheticTestOnly({
      args: [`--mode=${POLICY.mode}`],
      env: {},
      execArgv: [],
      stdinBytes: Buffer.from(NONCE),
      stdinIsPipe: true,
      workspaceRoot: "/",
      output: OUT,
      fsOps: ops,
      platform: "linux",
      clock: () => NOW,
      readFixed: (_r, file) =>
        file === "synthetic-permit.json"
          ? Buffer.from('{"schema":"synthetic"}')
          : inventory(),
      qualifyOutput: () => {
        const fd = ops.openSync(OUT, "r"),
          s = ops.fstatSync(fd);
        return {
          fd,
          dev: s.dev,
          ino: s.ino,
          realPath: OUT,
          mount: clone(BINDINGS.bridge.nativeMountIdentity),
          closed: false,
        };
      },
      durability: () => {},
      assertExistingPermanentLock: true,
      resolveDns: async () => {
        dns++;
        return [{ address: "8.8.8.8" }];
      },
      httpPost: async () => {
        http++;
      },
    });
    a.equal(result.status, "TEST_ONLY_LOCKED");
    a.equal(dns, 0);
    a.equal(http, 0);
    a.equal(ops.fds.size, 0);
  },
);
caseTest(
  "external JSON key order is irrelevant but response and envelope extras reject",
  async () => {
    const baseHttp = syntheticHttp(),
      reordered = async (config) => {
        const r = await baseHttp(config),
          body = JSON.parse(r.body.toString());
        return {
          counters: r.counters,
          elapsedMs: r.elapsedMs,
          tlsVersion: r.tlsVersion,
          remoteAddress: r.remoteAddress,
          redirected: r.redirected,
          body: Buffer.from(
            JSON.stringify({
              result: body.result,
              id: body.id,
              jsonrpc: body.jsonrpc,
            }),
          ),
          headers: r.headers,
          status: r.status,
        };
      };
    a.equal((await integrated({ httpPost: reordered })).status, "TEST_ONLY");
    for (const where of ["response", "envelope"]) {
      mutations++;
      let injected = false;
      const bad = async (config) => {
        const r = await baseHttp(config);
        if (injected) return r;
        injected = true;
        if (where === "response") return { ...r, extra: true };
        const body = JSON.parse(r.body.toString());
        return {
          ...r,
          body: Buffer.from(JSON.stringify({ ...body, extra: true })),
        };
      };
      if (where === "response") await rejects(() => integrated({ httpPost: bad }), "REQUEST_CONTRACT");
      else a.equal((await integrated({ httpPost: bad })).status, "TEST_ONLY");
    }
  },
);
caseTest("adapter probes reject each stage without replacement", async () => {
  const hs = adapter.selectCandidates(adapter.parseInventory(inventory()));
  for (let stage = 1; stage <= 4; stage++) {
    mutations++;
    let n = 0;
    const transport = async (h, m, p) => {
      n++;
      if (n === stage)
        return stage === 1
          ? "0x2"
          : stage === 2
            ? header(1)
            : stage === 3
              ? "0x"
              : encoded(E + 1);
      return m === "eth_chainId"
        ? "0x1"
        : m === "eth_getBlockByNumber"
          ? header(100)
          : m === "eth_getCode"
            ? MOCK_CODE
            : encoded(E);
    };
    await rejects(
      () => adapter.adapterProbes(hs, transport, () => NOW),
      ["PROBE_CHAIN", "PROBE_FINALIZED", "PROBE_CODE", "PROBE_EXPIRY"][
        stage - 1
      ],
    );
    a.equal(n, stage);
  }
});
caseTest(
  "independent validator reconstructs schedule and rejects selection transcript accounting and permit mutations",
  async () => {
    let observed;
    await integrated({
      observeTest: (x) => {
        observed = x;
      },
    });
    const p = permit(),
      acquisition = {
        permitId: p.permitId,
        approvalNonceCommitment: p.approvalNonceCommitment,
        issuedAt: p.issuedAt,
        notBefore: p.notBefore,
        expiresAt: p.expiresAt,
        acquiredAt: NOW,
        completedAt: NOW,
        inputMode: POLICY.input.mode,
        nativeSupervisorPipeFifo: true,
        hashesVerified: true,
        inventoryFallbackUsed: false,
        exclusiveWriterFramedGo: true,
        windowsPeerEofRequired: false,
        linuxWriterClosedAfterGo: true,
        bufferedTrailingBytesRejected: true,
        postGoChannelMonitored: true,
        inventoryReadAfterPermanentLock: true,
        goFrameCommitment: "ab".repeat(32),
        executedCapture: {
          path: POLICY.input.capturePath,
          sha256: "03".repeat(32),
          dev: "1",
          ino: "2",
        },
      },
      args = {
        permit: p,
        bindings: BINDINGS,
        outer: observed.outer,
        transcript: observed.transcript,
        usage: observed.usage,
        selection: observed.selection,
        engineContext: observed.engineContext,
        acquisition,
        now: NOW,
      },
      valid = validator.validateProduction(observed.capture, args);
    a.equal(valid.selection.locatorIndex, 2);
    a.deepEqual(valid.selection.evidenceIndices, [0, 1]);
    for (const [mutate, code] of [
      [(x) => x.selection.evidenceIndices.reverse(), "SELECTION_INDICES"],
      [(x) => (x.selection.locatorIndex = 0), "SELECTION_INDICES"],
      [(x) => x.transcript[0].bytes++, "OUTER_TRANSCRIPT_ACCOUNTING"],
      [(x) => (x.transcript[0].candidateIndex = 1), "TRANSCRIPT_SCHEDULE"],
      [(x) => (x.engineContext.poolAttemptLedger[0].stage = "POOL_EXPIRY"), "ENGINE_CONTEXT"],
      [(x) => (x.engineContext.engineAttemptLedger[0].method = "eth_call"), "ENGINE_CONTEXT"],
      [(x) => (x.engineContext.poolAttemptLedger[0].elapsedMs = POLICY.limits.wallMs + 1), "ENGINE_CONTEXT"],
      [(x) => (x.engineContext.poolAttemptLedger[0].counters.data = 0.5), "ENGINE_CONTEXT"],
      [(x) => (x.engineContext.engineQualification[0].stage = "COMMON_PIN"), "ENGINE_CONTEXT"],
      [
        (x) => {
          const row = x.transcript.find((r) =>
            Number.isSafeInteger(r.blockTag),
          );
          row.header.number++;
        },
        "TRANSCRIPT_BLOCK_NUMBER",
      ],
      [(x) => x.usage.counters.socket++, "USAGE"],
      [(x) => (x.acquisition.permitId = "bb".repeat(32)), "ACQUISITION"],
    ]) {
      mutations++;
      const x = clone(args);
      mutate(x);
      throws(() => validator.validateProduction(observed.capture, x), code);
    }
  },
);
caseTest(
  "divergent common-pin schedule passes full validator and schedule mutations reject",
  async () => {
    let observed;
    const result = await integrated({
      httpPost: divergentHttp(),
      observeTest: (x) => {
        observed = x;
      },
    });
    a.deepEqual(
      result.selection.commonPinSchedule.map((x) => [
        x.height,
        x.eligibleCandidateIndices,
        x.agreementCandidateIndices,
      ]),
      [
        [103, [0], []],
        [102, [0, 1], []],
        [101, [0, 1, 2], []],
        [100, [0, 1, 2, 3], [0, 1, 2, 3]],
      ],
    );
    a.deepEqual(result.selection.evidenceIndices, [0, 1]);
    a.equal(result.selection.locatorIndex, 2);
    a.equal(
      result.selection.binarySearch.every((x) => x.candidateIndex === 2),
      true,
    );
    const p = permit(),
      args = {
        permit: p,
        bindings: BINDINGS,
        outer: observed.outer,
        transcript: observed.transcript,
        usage: observed.usage,
        selection: observed.selection,
        engineContext: observed.engineContext,
        acquisition: {
          permitId: p.permitId,
          approvalNonceCommitment: p.approvalNonceCommitment,
          issuedAt: p.issuedAt,
          notBefore: p.notBefore,
          expiresAt: p.expiresAt,
          acquiredAt: NOW,
          completedAt: NOW,
          inputMode: POLICY.input.mode,
          nativeSupervisorPipeFifo: true,
          hashesVerified: true,
          inventoryFallbackUsed: false,
          exclusiveWriterFramedGo: true,
          windowsPeerEofRequired: false,
          linuxWriterClosedAfterGo: true,
          bufferedTrailingBytesRejected: true,
          postGoChannelMonitored: true,
          inventoryReadAfterPermanentLock: true,
          goFrameCommitment: "ab".repeat(32),
          executedCapture: {
            path: POLICY.input.capturePath,
            sha256: "03".repeat(32),
            dev: "1",
            ino: "2",
          },
        },
        now: NOW,
      };
    a.equal(
      validator.validateProduction(observed.capture, args).selection
        .locatorIndex,
      2,
    );
    for (const mutate of [
      (x) =>
        x.selection.commonPinSchedule[1].eligibleCandidateIndices.reverse(),
      (x) =>
        x.selection.commonPinSchedule[3].agreementCandidateIndices.reverse(),
      (x) => x.selection.binarySearch[0].height++,
    ]) {
      mutations++;
      const bad = clone(args);
      mutate(bad);
      throws(
        () => validator.validateProduction(observed.capture, bad),
        bad.selection.binarySearch[0].height !==
          args.selection.binarySearch[0].height
          ? "SELECTION_LOCATOR"
          : "SELECTION_COMMON",
      );
    }
  },
);
caseTest(
  "cancellable resolver combines A and AAAA and cancels bounded late work",
  async () => {
    let cancelled = 0;
    class Resolver {
      resolve4(_h, cb) {
        queueMicrotask(() => cb(null, ["8.8.8.8"]));
      }
      resolve6(_h, cb) {
        queueMicrotask(() => cb(null, ["2606:4700:4700::1111"]));
      }
      cancel() {
        cancelled++;
      }
    }
    const rows = await capture.resolveDns("synthetic.invalid", {
      Resolver,
      timeoutMs: 100,
    });
    a.deepEqual(rows, ["8.8.8.8", "2606:4700:4700::1111"]);
    let fire;
    class LateResolver {
      resolve4() {}
      resolve6() {}
      cancel() {
        cancelled++;
      }
    }
    await rejects(
      () =>
        capture.resolveDns("late.invalid", {
          Resolver: LateResolver,
          timeoutMs: 1,
          timers: {
            setTimeout(fn) {
              fire = fn;
              queueMicrotask(fn);
              return 1;
            },
            clearTimeout() {},
          },
        }),
      "DNS_TIMEOUT",
    );
    a.equal(typeof fire, "function");
    a.equal(cancelled, 1);
    const v6 = adapter.normalizeIp("2606:4700:4700::1111");
    a.equal(v6.kind, 6);
    a.equal(v6.key.length, 34);
    a.equal(require("node:net").isIP(v6.text), 6);
  },
);
caseTest(
  "strictRequest binds direct DNS TLS SNI IPv6 and records actual cleanup counters",
  async () => {
    const fake = fakeClient(),
      pin = {
        chosen: adapter.normalizeIp("2606:4700:4700::1111"),
        addresses: [adapter.normalizeIp("2606:4700:4700::1111")],
      },
      body = Buffer.from(
        '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',
      ),
      result = await capture.strictRequest(
        {
          transportClass: "DIRECT_HTTPS",
          hostname: "rpc.invalid",
          port: "443",
          path: "/",
          pin,
          approvedHeaders: {},
          body,
          connectMs: 100,
          inactivityMs: 100,
          totalMs: 100,
        },
        { https: fake.client, HttpsAgent: fake.Agent },
      );
    a.equal(fake.options.servername, "rpc.invalid");
    a.equal(fake.agentOptions.lookup !== undefined, true);
    a.equal(result.remoteAddress, "2606:4700:4700::1111");
    a.deepEqual(result.counters, {
      dns: 0,
      socket: 1,
      connect: 1,
      tls: 1,
      data: 1,
      requestDestroyed: 1,
      socketDestroyed: 1,
      agentDestroyed: 1,
    });
    const lookup = capture.pinnedLookup(pin);
    await new Promise((resolve, reject) =>
      lookup("ignored", { all: true }, (e, v) => {
        if (e) reject(e);
        else {
          a.equal(v[0].address, "2606:4700:4700::1111");
          resolve();
        }
      }),
    );
  },
);
caseTest(
  "strictRequest relay is loopback IPv6 without TLS and rejects forbidden headers and truncation",
  async () => {
    const relay = fakeClient({ local: true }),
      config = {
        transportClass: "LOCALHOST_KEYLESS_RELAY",
        hostname: "::1",
        port: "8545",
        path: "/",
        pin: null,
        approvedHeaders: {},
        body: Buffer.from("{}"),
        connectMs: 100,
        inactivityMs: 100,
        totalMs: 100,
      },
      ok = await capture.strictRequest(config, {
        http: relay.client,
        HttpAgent: relay.Agent,
      });
    a.equal(ok.tlsVersion, null);
    a.equal(ok.counters.tls, 0);
    for (const [setup, code] of [
      [
        {
          local: true,
          headers: { "content-type": "application/json", location: "/x" },
        },
        "HTTP_FORBIDDEN_HEADER",
      ],
      [{ local: true, truncated: true }, "HTTP_TRUNCATED"],
    ]) {
      mutations++;
      const fake = fakeClient(setup);
      await rejects(
        () =>
          capture.strictRequest(config, {
            http: fake.client,
            HttpAgent: fake.Agent,
          }),
        code,
      );
    }
    const truncated = fakeClient({ local: true, truncated: true }); let telemetryError;
    try { await capture.strictRequest(config, { http: truncated.client, HttpAgent: truncated.Agent }); } catch (error) { telemetryError = error; }
    a.equal(telemetryError.code, "HTTP_TRUNCATED"); a.equal(telemetryError.bytes > 0, true); a.equal(telemetryError.counters.data, 1); a.equal(Number.isSafeInteger(telemetryError.elapsedMs), true);
  },
);
caseTest(
  "strictRequest rejects TLS peer drift and absolute timeout with cleanup",
  async () => {
    const pin = {
        chosen: adapter.normalizeIp("8.8.8.8"),
        addresses: [adapter.normalizeIp("8.8.8.8")],
      },
      config = {
        transportClass: "DIRECT_HTTPS",
        hostname: "rpc.invalid",
        port: "443",
        path: "/",
        pin,
        approvedHeaders: {},
        body: Buffer.from("{}"),
        connectMs: 100,
        inactivityMs: 100,
        totalMs: 100,
      },
      drift = fakeClient({ remoteAddress: "1.1.1.1" });
    mutations++;
    await rejects(
      () =>
        capture.strictRequest(config, {
          https: drift.client,
          HttpsAgent: drift.Agent,
        }),
      "HTTP_TLS_PEER",
    );
    let destroyed = 0;
    class Agent {
      destroy() {
        destroyed++;
      }
    }
    const stalled = {
      request() {
        const req = new EventEmitter();
        req.destroyed = false;
        req.destroy = () => {
          req.destroyed = true;
        };
        req.end = () => {};
        return req;
      },
    };
    mutations++;
    await rejects(
      () =>
        capture.strictRequest(config, {
          https: stalled,
          HttpsAgent: Agent,
          timers: {
            setTimeout(fn) {
              queueMicrotask(fn);
              return 1;
            },
            clearTimeout() {},
          },
        }),
      "HTTP_ABSOLUTE_TIMEOUT",
    );
    a.equal(destroyed, 1);
  },
);
caseTest(
  "strictRequest observes every socket assignment and destroys the second",
  async () => {
    const pin = {
        chosen: adapter.normalizeIp("8.8.8.8"),
        addresses: [adapter.normalizeIp("8.8.8.8")],
      },
      config = {
        transportClass: "DIRECT_HTTPS",
        hostname: "rpc.invalid",
        port: "443",
        path: "/",
        pin,
        approvedHeaders: {},
        body: Buffer.from("{}"),
        connectMs: 100,
        inactivityMs: 100,
        totalMs: 100,
      };
    let secondDestroyed = 0;
    class Agent {
      destroy() {}
    }
    const client = {
      request() {
        const req = new EventEmitter();
        req.destroyed = false;
        req.destroy = () => {
          req.destroyed = true;
        };
        req.end = () => {
          const one = new EventEmitter(),
            two = new EventEmitter();
          one.destroyed = false;
          one.destroy = () => {
            one.destroyed = true;
          };
          two.destroyed = false;
          two.destroy = () => {
            two.destroyed = true;
            secondDestroyed++;
          };
          req.emit("socket", one);
          req.emit("socket", two);
        };
        return req;
      },
    };
    mutations++;
    await rejects(
      () => capture.strictRequest(config, { https: client, HttpsAgent: Agent }),
      "HTTP_SOCKET_MULTIPLE",
    );
    a.equal(secondDestroyed, 1);
  },
);
caseTest(
  "output inode anchor survives durability lock publication and detects replacement",
  () => {
    const ops = new AnchorFs(),
      anchor = capture.qualifyOutput(OUT, ops, {
        platform: "linux",
        output: OUT,
      });
    a.equal(ops.fds.has(anchor.fd), true);
    capture.durability(anchor, ops, NONCE);
    adapter.acquireLock(anchor, NONCE, ops);
    const published = adapter.publishBundle(
      anchor,
      { capture: { a: 1 }, validation: { b: 2 }, manifest: { c: 3 } },
      "abc",
      ops,
    );
    a.equal(published.name, "run-abc");
    a.equal(ops.nodes.has(path.join(OUT, "run-abc", "COMMITTED")), true);
    a.equal(ops.fds.size, 1);
    mutations++;
    throws(() => adapter.acquireLock(anchor, NONCE, ops), "ONE_SHOT_USED");
    ops.closeSync(anchor.fd);
    const raceOps = new AnchorFs(),
      race = capture.qualifyOutput(OUT, raceOps, {
        platform: "linux",
        output: OUT,
      });
    raceOps.nodes.set(OUT, {
      type: "dir",
      dev: 9,
      ino: 9,
      data: Buffer.alloc(0),
    });
    mutations++;
    throws(
      () => adapter.acquireLock(race, NONCE, raceOps),
      "LOCK_ANCHOR_CHANGED",
    );
    raceOps.closeSync(race.fd);
    a.equal(raceOps.fds.size, 0);
  },
);
caseTest(
  "publication closes descriptors independently and classifies phase faults",
  () => {
    const bundle = {
        capture: { a: 1 },
        validation: { b: 2 },
        manifest: { c: 3 },
      },
      make = () => {
        const ops = new AnchorFs(),
          fd = ops.openSync(OUT, "r"),
          s = ops.fstatSync(fd);
        return {
          ops,
          anchor: {
            fd,
            dev: s.dev,
            ino: s.ino,
            realPath: OUT,
            mount: clone(BINDINGS.bridge.nativeMountIdentity),
            closed: false,
          },
        };
      };
    {
      const { ops, anchor } = make(),
        baseClose = ops.closeSync.bind(ops),
        attempts = [];
      ops.closeSync = (fd) => {
        const p = ops.fds.get(fd)?.path;
        attempts.push(p);
        if (p?.endsWith(".tmp") || path.basename(p || "").startsWith("run-"))
          throw new Error("close");
        return baseClose(fd);
      };
      mutations++;
      throws(
        () => adapter.publishBundle(anchor, bundle, "close-pre", ops),
        "PUBLISH_FAILURE",
      );
      a.equal(
        attempts.some((x) => x?.endsWith(".tmp")),
        true,
      );
      a.equal(
        attempts.some((x) => path.basename(x || "").startsWith("run-")),
        true,
      );
      baseClose(anchor.fd);
    }
    {
      const { ops, anchor } = make(),
        baseFsync = ops.fsyncSync.bind(ops);
      ops.fsyncSync = (fd) => {
        const p = ops.fds.get(fd)?.path;
        if (
          ops.nodes.has(path.join(OUT, "run-post", "COMMITTED")) &&
          fd === anchor.fd
        )
          throw new Error("post");
        return baseFsync(fd);
      };
      mutations++;
      throws(
        () => adapter.publishBundle(anchor, bundle, "post", ops),
        "COMMITTED_DURABILITY_UNCERTAIN",
      );
      ops.closeSync(anchor.fd);
    }
    {
      const { ops, anchor } = make();
      ops.linkSync = () => {
        throw new Error("link");
      };
      mutations++;
      throws(
        () => adapter.publishBundle(anchor, bundle, "link-pre", ops),
        "PUBLISH_FAILURE",
      );
      ops.closeSync(anchor.fd);
    }
  },
);
caseTest(
  "r2 pool qualifies all eight, records 32 attempts, and selects dense family-diverse engine inputs",
  async () => {
    const hs = adapter.selectCandidates(adapter.parseInventory(inventory())), calls = Array(8).fill(0);
    const transport = async (h, m) => {
      const i = hs.indexOf(h); calls[i]++;
      if (i === 1 && m === "eth_chainId") throw Object.assign(new Error("local"), { code: "HTTP_STATUS" });
      return m === "eth_chainId" ? "0x1" : m === "eth_getBlockByNumber" ? header(100) : m === "eth_getCode" ? MOCK_CODE : encoded(E);
    };
    const pool = await adapter.qualifyPool(hs, transport, () => NOW);
    a.deepEqual(calls, [4, 1, 4, 4, 4, 4, 4, 4]);
    a.equal(pool.ledger.length, 32);
    a.equal(pool.outcomes.filter((x) => x.passed).length, 7);
    a.equal(pool.selectedPoolIndices.includes(1), false);
    a.equal(pool.handles.length, 4);
    a.equal(new Set(pool.handles.map((x) => x.operatorFamily)).size, 4);
  },
);
caseTest("r2 pool escalates global failures without continuing qualification", async () => {
  const hs = adapter.selectCandidates(adapter.parseInventory(inventory())); let calls = 0;
  await rejects(() => adapter.qualifyPool(hs, async () => { calls++; throw Object.assign(new Error("global"), { code: "SOCKET" }); }, () => NOW), "SOCKET");
  a.equal(calls, 1);
});
caseTest("candidate-local failed response crossing aggregate bytes terminates as ledgered ACCOUNTING", async () => {
  const baseHttp = syntheticHttp(); let calls = 0, caught;
  const httpPost = async (config) => {
    const r = await baseHttp(config), q = JSON.parse(config.body); calls++;
    if (calls <= 8) return { ...r, body: Buffer.concat([r.body, Buffer.alloc(POLICY.limits.responseBytesPerRequest - r.body.length, 0x20)]) };
    return { ...r, body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: q.id, error: { code: -32000, message: "fixture" } })) };
  };
  try { await integrated({ httpPost }); } catch (error) { caught = error; }
  a.equal(caught.code, "ACCOUNTING"); a.equal(caught.failureScope, "GLOBAL");
  a.equal(caught.attempt.outcome, "FAIL"); a.equal(caught.attempt.reason, "ACCOUNTING"); a.equal(caught.attempt.bytes > 0, true);
  a.equal(calls, 9);
});
caseTest("one real-wrapper pool failure reconciles and passes independent validation", async () => {
  const baseHttp = syntheticHttp(); let calls = 0, observed;
  const httpPost = async (config) => { const r = await baseHttp(config); if (++calls !== 1) return r; const q = JSON.parse(config.body); return { ...r, body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: q.id, error: { code: -32000, message: "fixture" } })) }; };
  a.equal((await integrated({ httpPost, observeTest: (x) => { observed = x; } })).status, "TEST_ONLY");
  a.equal(observed.engineContext.poolAttemptLedger[0].outcome, "FAIL");
  a.equal(observed.engineContext.poolAttemptLedger[0].reason, "RPC_ENVELOPE");
  a.equal(observed.engineContext.poolAttemptLedger[0].bytes > 0, true); a.equal(observed.engineContext.poolAttemptLedger[0].counters.data, 1); a.equal(Number.isSafeInteger(observed.engineContext.poolAttemptLedger[0].elapsedMs), true);
  a.equal(observed.engineContext.poolAttemptLedger.filter((x) => x.outcome !== "SKIP").length, 29);
});
caseTest("four selected with one engine rejection passes without backfill; two reject fails quorum", async () => {
  const scenario = async (failCalls) => { const baseHttp = syntheticHttp(); let calls = 0, observed; const httpPost = async (config) => { const r = await baseHttp(config); calls++; if (!failCalls.includes(calls)) return r; const q = JSON.parse(config.body); return { ...r, body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: q.id, error: { code: -32000, message: "fixture" } })) }; }; return { promise: integrated({ httpPost, observeTest: (x) => { observed = x; } }), get: () => observed }; };
  const one = await scenario([33]); a.equal((await one.promise).status, "TEST_ONLY"); const observed = one.get();
  a.equal(observed.capture.qualification.qualifiedCandidates, 3); a.equal(Object.hasOwn(observed.capture.qualification, "candidateOutcomes"), false); a.equal(observed.engineContext.engineQualification[0].outcome, "REJECT");
  a.equal(observed.engineContext.selectedPoolIndices.length, 4); a.equal(observed.engineContext.engineAttemptLedger.some((x) => x.outcome === "FAIL" && x.reason === "RPC_ENVELOPE"), true);
  const two = await scenario([33, 34]); await rejects(() => two.promise, "THREE_QUALIFIED_CANDIDATES_REQUIRED");
});
caseTest("malformed pool finalized result is local and valid pool quorum continues", async () => {
  const baseHttp = syntheticHttp(); let calls = 0, observed;
  const httpPost = async (config) => {
    const r = await baseHttp(config), q = JSON.parse(config.body); calls++;
    return calls === 2 ? { ...r, body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: q.id, result: { malformed: true } })) } : r;
  };
  a.equal((await integrated({ httpPost, observeTest: (x) => { observed = x; } })).status, "TEST_ONLY");
  a.equal(observed.engineContext.poolAttemptLedger[1].outcome, "FAIL");
  a.equal(observed.engineContext.poolAttemptLedger[1].reason, "RESULT_SCHEMA");
  a.equal(observed.engineContext.poolOutcomes.filter((x) => x.passed).length, 7);
});
caseTest("malformed engine qualification result is recorded as local without backfill", async () => {
  const baseHttp = syntheticHttp(); let calls = 0, observed;
  const httpPost = async (config) => {
    const r = await baseHttp(config), q = JSON.parse(config.body); calls++;
    return calls === 34 ? { ...r, body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: q.id, result: [] })) } : r;
  };
  a.equal((await integrated({ httpPost, observeTest: (x) => { observed = x; } })).status, "TEST_ONLY");
  a.deepEqual(observed.engineContext.engineQualification[0], { candidateIndex: 0, outcome: "REJECT", reason: "RESULT_SCHEMA", stage: "QUALIFICATION" });
  const failed = observed.engineContext.engineAttemptLedger.find((x) => x.stage === "ENGINE_QUAL_FINALIZED" && x.candidateIndex === 0);
  a.equal(failed.outcome, "FAIL"); a.equal(failed.reason, "RESULT_SCHEMA");
  a.equal(observed.engineContext.selectedPoolIndices.length, 4);
});
caseTest("wrong exact qualification header number maps to block-number rejection", async () => {
  const baseHttp = syntheticHttp(); let calls = 0, observed;
  const httpPost = async (config) => {
    const r = await baseHttp(config), q = JSON.parse(config.body); calls++;
    return calls === 35 ? { ...r, body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: q.id, result: header(101) })) } : r;
  };
  a.equal((await integrated({ httpPost, observeTest: (x) => { observed = x; } })).status, "TEST_ONLY");
  a.deepEqual(observed.engineContext.engineQualification[0], { candidateIndex: 0, outcome: "REJECT", reason: "BLOCK_NUMBER_MISMATCH", stage: "QUALIFICATION" });
  const failed = observed.engineContext.engineAttemptLedger.find((x) => x.stage === "ENGINE_QUAL_EXACT" && x.candidateIndex === 0);
  a.equal(failed.outcome, "FAIL"); a.equal(failed.reason, "BLOCK_NUMBER_MISMATCH");
});
caseTest("malformed common-pin result rejects one candidate and reconstructs valid quorum", async () => {
  const baseHttp = syntheticHttp(); let calls = 0, observed;
  const httpPost = async (config) => {
    const r = await baseHttp(config), q = JSON.parse(config.body); calls++;
    return calls === 49 ? { ...r, body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: q.id, result: { malformed: true } })) } : r;
  };
  a.equal((await integrated({ httpPost, observeTest: (x) => { observed = x; } })).status, "TEST_ONLY");
  a.deepEqual(observed.engineContext.engineQualification[0], { candidateIndex: 0, outcome: "REJECT", reason: "RESULT_SCHEMA", stage: "COMMON_PIN" });
  const failed = observed.engineContext.engineAttemptLedger.find((x) => x.stage.startsWith("ENGINE_COMMON_") && x.candidateIndex === 0);
  a.equal(failed.outcome, "FAIL"); a.equal(failed.reason, "RESULT_SCHEMA");
  a.equal(observed.selection.evidenceIndices.includes(0), false); a.equal(observed.selection.locatorIndex === 0, false);
});
caseTest("wrong common-pin header number maps locally and valid quorum replays", async () => {
  const baseHttp = syntheticHttp(); let calls = 0, observed;
  const httpPost = async (config) => {
    const r = await baseHttp(config), q = JSON.parse(config.body); calls++;
    return calls === 49 ? { ...r, body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: q.id, result: header(101) })) } : r;
  };
  a.equal((await integrated({ httpPost, observeTest: (x) => { observed = x; } })).status, "TEST_ONLY");
  a.deepEqual(observed.engineContext.engineQualification[0], { candidateIndex: 0, outcome: "REJECT", reason: "BLOCK_NUMBER_MISMATCH", stage: "COMMON_PIN" });
  const failed = observed.engineContext.engineAttemptLedger.find((x) => x.stage.startsWith("ENGINE_COMMON_") && x.candidateIndex === 0);
  a.equal(failed.outcome, "FAIL"); a.equal(failed.reason, "BLOCK_NUMBER_MISMATCH");
  a.equal(observed.selection.evidenceIndices.includes(0), false); a.equal(observed.selection.locatorIndex === 0, false);
});
caseTest("transport failure normalization is exhaustive and has no stale aliases", () => {
  const rows = { RPC_HTTP: "HTTP_STATUS", HTTP_BODY_LIMIT: "HTTP_BODY_LIMIT", RPC_JSON: "RPC_JSON", RPC_JSON_SCHEMA: "RPC_ENVELOPE", RPC_JSON_ID: "RPC_ENVELOPE", RPC_ERROR_ENVELOPE: "RPC_ENVELOPE", PROBE_CODE: "RESULT_SCHEMA", HEADER_INVALID: "RESULT_SCHEMA", OUTER_ACCOUNTING: "ACCOUNTING", ABSOLUTE_DEADLINE: "DEADLINE", RPC_FORBIDDEN: "REQUEST_CONTRACT", HTTP_CONNECT_TIMEOUT: "DEADLINE", HTTP_INACTIVITY_TIMEOUT: "DEADLINE", HTTP_ABSOLUTE_TIMEOUT: "DEADLINE", HTTP_REQUEST: "SOCKET", HTTP_RESPONSE: "SOCKET", HTTP_TRUNCATED: "RPC_ENVELOPE", HTTP_TLS_PEER: "SOCKET", HTTP_CONTENT_TYPE: "HTTP_STATUS", HTTP_FORBIDDEN_HEADER: "HTTP_STATUS", HTTP_SOCKET: "SOCKET", HTTP_SOCKET_MULTIPLE: "SOCKET", HTTP_SETUP: "SOCKET", DNS_ABORT: "DEADLINE", DNS_TIMEOUT: "DEADLINE", DNS_FAILURE: "SOCKET", OPAQUE_HANDLE: "AUTHORITY", UNKNOWN_FIXTURE: "INTERNAL" };
  for (const [input, expected] of Object.entries(rows)) a.equal(adapter.normalizeFailure({ code: input }), expected);
  for (const stale of ["RESPONSE_LIMIT", "BAD_JSON", "RPC_ERROR"]) a.equal(adapter.LOCAL_FAILURES.has(stale), false);
});
caseTest("real transport wrapper classifies emitted local and global failures", async () => {
  const localCases = [
    ["HTTP_STATUS", async (r) => ({ ...r, status: 503 })],
    ["HTTP_BODY_LIMIT", async () => { throw new adapter.ProductionError("HTTP_BODY_LIMIT"); }],
    ["RPC_JSON", async (r) => ({ ...r, body: Buffer.from("{") })],
    ["RPC_ENVELOPE", async (r, config) => { const q = JSON.parse(config.body); return { ...r, body: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: q.id, error: { code: -1, message: "fixture" } })) }; }],
  ];
  for (const [reason, mutate] of localCases) {
    const baseHttp = syntheticHttp(); let first = true, observed;
    const httpPost = async (config) => { const r = await baseHttp(config); if (!first) return r; first = false; return mutate(r, config); };
    a.equal((await integrated({ httpPost, observeTest: (x) => { observed = x; } })).status, "TEST_ONLY");
    a.equal(observed.engineContext.poolAttemptLedger[0].reason, reason);
  }
  for (const [emitted, expected] of [["RPC_RESPONSE_SCHEMA", "REQUEST_CONTRACT"], ["HTTP_SOCKET", "SOCKET"], ["ABSOLUTE_DEADLINE", "DEADLINE"], ["OUTER_ACCOUNTING", "ACCOUNTING"], ["OPAQUE_HANDLE", "AUTHORITY"], ["UNKNOWN_FIXTURE", "INTERNAL"]]) {
    const baseHttp = syntheticHttp(); let first = true;
    const httpPost = async (config) => { if (first) { first = false; throw new adapter.ProductionError(emitted); } return baseHttp(config); };
    await rejects(() => integrated({ httpPost }), expected);
  }
});
caseTest(
  "capture CLI invokes only canonical native runner and existing disabled capture is untouched",
  async () => {
    const source = require("node:fs").readFileSync(
      path.join(
        __dirname,
        "capture-morpho-pt-27aug2026-post-expiry-r2-production.js",
      ),
      "utf8",
    );
    a.match(
      source,
      /if\s*\(require\.main\s*===\s*module\)\s*runNativeProduction\(\)/u,
    );
    a.doesNotMatch(source, /runNativeProduction\([^)]*injected/u);
    await rejects(() => adapter.runNativeProduction({}), "NATIVE_INJECTION_FORBIDDEN");
    const adapterSource = require("node:fs").readFileSync(path.join(__dirname, "lib/morpho-pt-27aug2026-post-expiry-r2-production-adapter.js"), "utf8");
    a.doesNotMatch(adapterSource, /fail\("NATIVE_R2_PERMIT_UNISSUED"\)/u);
    a.match(adapterSource, /const capture = require\("\.\.\/capture-morpho-pt-27aug2026-post-expiry-r2-production\.js"\)/u);
  },
);
test.after(() =>
  process.stdout.write(
    `MORPHO_PT_POST_EXPIRY_R2_PRODUCTION_SUMMARY ${JSON.stringify({ tests, assertions, mutations, networkRequests: network, operations: profile.profile.operations.length, outerRequestBoundary: POLICY.limits.outerRequests, evidenceRequestBoundary: POLICY.limits.outerEvidenceRequests })}\n`,
  ),
);
