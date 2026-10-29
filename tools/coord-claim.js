#!/usr/bin/env node
// coord-claim.js - small coordination helper for multi-agent workspace claims.
// It only reads/writes files under coordination/ and never reads RPC inventories or secrets.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const COORD_DIR = path.join(WORKSPACE, "coordination");
const CLAIMS_DIR = path.join(COORD_DIR, "claims");
const CLAIM_ARCHIVE_DIR = path.join(CLAIMS_DIR, "archive");
const HEARTBEATS_DIR = path.join(COORD_DIR, "heartbeats");

const VALID_ROLES = new Set([
  "coordinator",
  "critical-research",
  "atomic-low-fund",
  "monitor-runner",
  "discovery-prefilter",
  "reviewer",
]);

function usage(exitCode = 0) {
  const text = `Usage:
  node tools\\coord-claim.js status
  node tools\\coord-claim.js claim --agent <id> --role <role> --resource <resource> [--ttl 60] [--note text]
  node tools\\coord-claim.js release --agent <id> --resource <resource> [--force]
  node tools\\coord-claim.js heartbeat --agent <id> --role <role> [--status active] [--ttl 30] [--note text]

Roles: ${[...VALID_ROLES].join(", ")}`;
  console.log(text);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const command = argv[2] || "status";
  const out = { _: [] };
  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return { command, args: out };
}

function ensureDirs() {
  for (const dir of [COORD_DIR, CLAIMS_DIR, CLAIM_ARCHIVE_DIR, HEARTBEATS_DIR]) fs.mkdirSync(dir, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function ttlMinutes(value, fallback) {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(24 * 60, Math.max(1, Math.round(n)));
}

function expiresAt(ttl) {
  return new Date(Date.now() + ttl * 60_000).toISOString();
}

function hashString(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function slug(value) {
  const base = String(value || "resource")
    .trim()
    .toLowerCase()
    .replace(/[\\/:]+/g, "--")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 96) || "resource";
  return `${base}--${hashString(value)}`;
}

function claimPath(resource) {
  return path.join(CLAIMS_DIR, `${slug(resource)}.json`);
}

function heartbeatPath(agent) {
  return path.join(HEARTBEATS_DIR, `${slug(agent)}.json`);
}

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(temp, file);
}

function createJsonExclusive(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "wx");
  try {
    fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`);
  } finally {
    fs.closeSync(fd);
  }
}

function isExpired(row) {
  const expiry = Date.parse(row?.expiresAt || "");
  return !Number.isFinite(expiry) || expiry <= Date.now();
}

function archiveClaim(file, reason, replacement = null) {
  if (!fs.existsSync(file)) return null;
  const row = replacement || readJson(file, {});
  const archived = {
    ...row,
    archivedAt: nowIso(),
    archiveReason: reason,
  };
  const base = path.basename(file, ".json");
  const dest = path.join(CLAIM_ARCHIVE_DIR, `${base}.${reason}.${Date.now()}.json`);
  writeJsonAtomic(dest, archived);
  fs.unlinkSync(file);
  return dest;
}

function requireText(args, key) {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`missing --${key}`);
  return value.trim();
}

function requireRole(role) {
  if (!VALID_ROLES.has(role)) throw new Error(`invalid --role ${role}; expected one of ${[...VALID_ROLES].join(", ")}`);
}

function commandClaim(args) {
  ensureDirs();
  const agent = requireText(args, "agent");
  const role = requireText(args, "role");
  const resource = requireText(args, "resource");
  requireRole(role);
  const ttl = ttlMinutes(args.ttl, 60);
  const file = claimPath(resource);
  const existing = readJson(file, null);
  const base = {
    resource,
    claimFile: path.relative(WORKSPACE, file).replace(/\\/g, "/"),
    agentId: agent,
    role,
    status: "active",
    startedAt: existing && existing.agentId === agent ? existing.startedAt || nowIso() : nowIso(),
    updatedAt: nowIso(),
    expiresAt: expiresAt(ttl),
    ttlMinutes: ttl,
    note: typeof args.note === "string" ? args.note : null,
  };

  if (existing) {
    if (existing.agentId === agent) {
      writeJsonAtomic(file, { ...existing, ...base, refreshedAt: nowIso() });
      console.log(JSON.stringify({ ok: true, action: "refreshed", claim: base }, null, 2));
      return;
    }
    if (!isExpired(existing)) {
      console.error(JSON.stringify({ ok: false, error: "resource already claimed", existing }, null, 2));
      process.exitCode = 2;
      return;
    }
    archiveClaim(file, "expired-replaced");
  }

  try {
    createJsonExclusive(file, base);
    console.log(JSON.stringify({ ok: true, action: "claimed", claim: base }, null, 2));
  } catch (err) {
    if (err?.code === "EEXIST") {
      console.error(JSON.stringify({ ok: false, error: "claim race lost", existing: readJson(file, null) }, null, 2));
      process.exitCode = 2;
      return;
    }
    throw err;
  }
}

function commandRelease(args) {
  ensureDirs();
  const agent = requireText(args, "agent");
  const resource = requireText(args, "resource");
  const file = claimPath(resource);
  const existing = readJson(file, null);
  if (!existing) {
    console.log(JSON.stringify({ ok: true, action: "already-free", resource }, null, 2));
    return;
  }
  if (existing.agentId !== agent && args.force !== true) {
    console.error(JSON.stringify({ ok: false, error: "claim owned by another agent", existing }, null, 2));
    process.exitCode = 2;
    return;
  }
  const released = {
    ...existing,
    status: "released",
    releasedAt: nowIso(),
    releasedBy: agent,
  };
  archiveClaim(file, "released", released);
  console.log(JSON.stringify({ ok: true, action: "released", resource }, null, 2));
}

function commandHeartbeat(args) {
  ensureDirs();
  const agent = requireText(args, "agent");
  const role = requireText(args, "role");
  requireRole(role);
  const ttl = ttlMinutes(args.ttl, 30);
  const file = heartbeatPath(agent);
  const heartbeat = {
    agentId: agent,
    role,
    status: typeof args.status === "string" ? args.status : "active",
    updatedAt: nowIso(),
    expiresAt: expiresAt(ttl),
    ttlMinutes: ttl,
    note: typeof args.note === "string" ? args.note : null,
  };
  writeJsonAtomic(file, heartbeat);
  console.log(JSON.stringify({ ok: true, action: "heartbeat", heartbeat }, null, 2));
}

function listJsonFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(dir, name));
  } catch (_) {
    return [];
  }
}

function commandStatus() {
  ensureDirs();
  const claims = listJsonFiles(CLAIMS_DIR).map((file) => {
    const row = readJson(file, {});
    return { ...row, expired: isExpired(row) };
  }).sort((a, b) => String(a.resource || "").localeCompare(String(b.resource || "")));
  const heartbeats = listJsonFiles(HEARTBEATS_DIR).map((file) => {
    const row = readJson(file, {});
    return { ...row, expired: isExpired(row) };
  }).sort((a, b) => String(a.agentId || "").localeCompare(String(b.agentId || "")));
  const summary = {
    generatedAt: nowIso(),
    coordinationDir: path.relative(WORKSPACE, COORD_DIR).replace(/\\/g, "/"),
    activeClaims: claims.filter((row) => !row.expired).length,
    expiredClaims: claims.filter((row) => row.expired).length,
    activeHeartbeats: heartbeats.filter((row) => !row.expired).length,
    expiredHeartbeats: heartbeats.filter((row) => row.expired).length,
    claims,
    heartbeats,
  };
  console.log(JSON.stringify(summary, null, 2));
}

function main() {
  const { command, args } = parseArgs(process.argv);
  if (command === "help" || args.help) usage(0);
  if (command === "claim") return commandClaim(args);
  if (command === "release") return commandRelease(args);
  if (command === "heartbeat") return commandHeartbeat(args);
  if (command === "status") return commandStatus(args);
  usage(1);
}

try {
  main();
} catch (err) {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
}
