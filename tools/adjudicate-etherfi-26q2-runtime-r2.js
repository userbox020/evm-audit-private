#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { keccak256 } = require("./node_modules/ethers");
const ROOT = path.resolve(__dirname, "..");
const BASE = path.join(ROOT, "reports", "raw", "fast", "etherfi-26q2-upgrade-migration-gate0-r2");
const sha256 = (b) => `0x${crypto.createHash("sha256").update(b).digest("hex")}`;
const zeroRange = (buf, start, length) => { for (let i = start; i < start + length; i++) buf[i] = 0; };
const hex = (b) => `0x${b.toString("hex")}`;
function cbor(buf) { if (buf.length < 2) return null; const n = buf.readUInt16BE(buf.length - 2); if (n <= 0 || n + 2 > buf.length) return null; const x = buf.subarray(buf.length - n - 2); return { bytes: x.length, sha256: sha256(x), keccak256: keccak256(x) }; }
function main() {
  if (process.argv.length !== 2) throw new Error("ARGV_FORBIDDEN");
  const builds = JSON.parse(fs.readFileSync(path.join(BASE, "hermetic-builds", "build-summary.json"), "utf8"));
  if (builds.status !== "PASS_11_OF_11_ACTUAL_STANDARD_JSON_BUILDS" || builds.records.length !== 11) throw new Error("BUILD_GATE");
  const records = [];
  for (const r of builds.records) {
    const dir = path.join(BASE, "hermetic-builds", r.id), evidence = JSON.parse(fs.readFileSync(path.join(dir, "build-evidence.json"), "utf8"));
    const authority = JSON.parse(fs.readFileSync(path.join(BASE, "verified-inputs", r.id, "authority.json"), "utf8"));
    const output = JSON.parse(fs.readFileSync(path.join(dir, "compiler-output.json"), "utf8"));
    const artifact = output.contracts[authority.fileName][authority.contractName], buildRuntime = Buffer.from(artifact.evm.deployedBytecode.object, "hex");
    const explorerRuntime = Buffer.from(authority.explorerRuntime.bytecode.slice(2), "hex");
    if (buildRuntime.length !== explorerRuntime.length) throw new Error(`RUNTIME_LENGTH_${r.id}`);
    const bn = Buffer.from(buildRuntime), en = Buffer.from(explorerRuntime), substitutions = [];
    for (const [declarationId, refs] of Object.entries(artifact.evm.deployedBytecode.immutableReferences || {})) for (const ref of refs) {
      const b = buildRuntime.subarray(ref.start, ref.start + ref.length), e = explorerRuntime.subarray(ref.start, ref.start + ref.length);
      substitutions.push({ declarationId, start: ref.start, length: ref.length, buildValue: hex(b), deployedValue: hex(e),
        deployedValueIsImplementationAddress: ref.length === 32 && e.subarray(0, 12).every((x) => x === 0) && `0x${e.subarray(12).toString("hex")}` === r.address });
      zeroRange(bn, ref.start, ref.length); zeroRange(en, ref.start, ref.length);
    }
    const normalizedExact = bn.equals(en), rawExact = buildRuntime.equals(explorerRuntime);
    const bcbor = cbor(buildRuntime), ecbor = cbor(explorerRuntime);
    const cborExact = (!bcbor && !ecbor) || (!!bcbor && !!ecbor && bcbor.sha256 === ecbor.sha256);
    const stripCbor = (x) => { if (x.length < 2) return x; const n = x.readUInt16BE(x.length - 2); return n > 0 && n + 2 <= x.length ? x.subarray(0, x.length - n - 2) : x; };
    const executableNormalizedExact = stripCbor(bn).equals(stripCbor(en));
    const creation = Buffer.from(artifact.evm.bytecode.object, "hex"), args = Buffer.from(authority.constructorArguments.slice(2), "hex");
    const directInit = Buffer.concat([creation, args]), explorerCreation = Buffer.from(authority.explorerCreation.bytecode.slice(2), "hex");
    const directInitExact = directInit.equals(explorerCreation), directShape = directInit.length === explorerCreation.length;
    const creationMode = directInitExact ? "DIRECT_INIT_CODE_EXACT" : directShape ? "DIRECT_SHAPE_NONEXACT" : "FACTORY_OR_WRAPPER_REQUIRES_SEPARATE_CREATE2_BINDING";
    records.push({ id: r.id, address: r.address, phase: r.phase, repository: r.repository, rawRuntimeExact: rawExact,
      compilerDeclaredImmutableSubstitution: !rawExact && substitutions.length > 0, immutableSubstitutions: substitutions,
      normalizedRuntimeExact: normalizedExact, executableNormalizedExact, buildRuntimeKeccak256: keccak256(buildRuntime), deployedRuntimeKeccak256: keccak256(explorerRuntime),
      normalizedRuntimeKeccak256: keccak256(bn), cborExact, buildCbor: bcbor, deployedCbor: ecbor,
      constructorArgumentsBytes: args.length, constructorArgumentsSha256: sha256(args), buildCreationBytes: creation.length,
      buildCreationKeccak256: keccak256(creation), directInitCodeBytes: directInit.length, directInitCodeKeccak256: keccak256(directInit),
      explorerCreationFieldBytes: explorerCreation.length, explorerCreationFieldKeccak256: keccak256(explorerCreation), directInitExact, directShape, creationMode,
      linkReferencesEmpty: Object.keys(artifact.evm.bytecode.linkReferences || {}).length === 0 && Object.keys(artifact.evm.deployedBytecode.linkReferences || {}).length === 0 });
  }
  const direct = records.filter((x) => x.directInitExact).length, directShapeNonexact = records.filter((x) => x.directShape && !x.directInitExact).length,
    wrapper = records.filter((x) => !x.directShape).length;
  const out = { schemaVersion: "etherfi-26q2-provenance-r2/runtime-adjudication-v1", generatedAt: new Date().toISOString(),
    status: records.length === 11 && records.every((x) => x.normalizedRuntimeExact && x.cborExact) ? "PASS_11_OF_11_RUNTIME_EXACT_WITH_COMPILER_DECLARED_IMMUTABLES" : "STOP_UNMATCHED_RUNTIME_OR_CBOR",
    expectedRecords: 11, adjudicatedRecords: records.length, normalizedExactRecords: records.filter((x) => x.normalizedRuntimeExact).length,
    rawExactRecords: records.filter((x) => x.rawRuntimeExact).length, executableNormalizedExactRecords: records.filter((x) => x.executableNormalizedExact).length,
    cborExactRecords: records.filter((x) => x.cborExact).length, directInitExactRecords: direct, directShapeNonexactRecords: directShapeNonexact, wrapperBindingRequiredRecords: wrapper, records,
    limitations: [...(wrapper ? ["A factory/wrapper creation field is not accepted as direct init code; separate deployment transaction and CREATE2 binding remains required."] : []),
      ...(records.some((x) => !x.cborExact) ? ["Executable bytes may match after compiler-declared immutable normalization while CBOR metadata bytes still fail byte-for-byte equality; the R2 admission rule treats this as a runtime mismatch."] : [])],
    safety: { publicVerifiedBytecodeAndLocalBuildOnly: true, rpcInventoryRead: false, fork: false, transaction: false, signing: false } };
  fs.writeFileSync(path.join(BASE, "runtime-adjudication.json"), `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify({ status: out.status, exact: `${out.normalizedExactRecords}/11`, executableExact: `${out.executableNormalizedExactRecords}/11`, cborExact: `${out.cborExactRecords}/11`, rawExact: `${out.rawExactRecords}/11`, directInit: `${direct}/11`, wrapperRequired: wrapper,
    directShapeNonexact, wrapperIds: records.filter((x) => !x.directShape).map((x) => x.id) }));
}
try { main(); } catch (e) { console.error(JSON.stringify({ status: "FAIL_CLOSED", error: String(e.message || e).slice(0, 300) })); process.exitCode = 1; }
