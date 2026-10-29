#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const STEM = "polygon-robin-markets-staking-vault-v2.0.0-runtime-r2";
const BUNDLE_REL = "tools/vendor/polygon-robin-runtime-r2-actions.bundle.js";
const AUTHORITY_REL = `reports/raw/fast/${STEM}/action-bundle-authority.json`;
const MODULES = Object.freeze([
  "tools/polygon-robin-runtime-r2-broker.js",
  "tools/polygon-robin-runtime-r2-bundle.js",
  "tools/polygon-robin-runtime-r2-capability.js",
  "tools/polygon-robin-runtime-r2-authorities.js",
  "tools/polygon-robin-runtime-r2-capture.js",
  "tools/polygon-robin-runtime-r2-collection.js",
  "tools/polygon-robin-runtime-r2-common.js",
  "tools/polygon-robin-runtime-r2-export.js",
  "tools/polygon-robin-runtime-r2-lifecycle.js",
  "tools/polygon-robin-runtime-r2-manifest.js",
  "tools/polygon-robin-runtime-r2-package.js",
  "tools/polygon-robin-runtime-r2-review.js",
  "tools/polygon-robin-runtime-r2-semantics.js",
  "tools/polygon-robin-runtime-r2-stage.js",
  "tools/polygon-robin-runtime-r2-validate.js",
  "tools/vendor/polygon-robin-runtime-r2-ethers.umd.min.js"
]);
const ENTRYPOINTS = Object.freeze({ stage: "tools/polygon-robin-runtime-r2-stage.js", capability: "tools/polygon-robin-runtime-r2-capability.js", review: "tools/polygon-robin-runtime-r2-review.js", capture: "tools/polygon-robin-runtime-r2-capture.js", recover: "tools/polygon-robin-runtime-r2-capture.js", validate: "tools/polygon-robin-runtime-r2-validate.js", export: "tools/polygon-robin-runtime-r2-export.js", "internal-broker": "tools/polygon-robin-runtime-r2-broker.js" });
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
function absolute(relative) { const target = path.resolve(ROOT, ...relative.split("/")); if (!target.startsWith(`${ROOT}${path.sep}`)) throw new Error("BUNDLE_PATH"); return target; }
function transform(source, id, ids, builtins) { let text = source.replace(/^#![^\n]*\n/u, ""); const staticRequire = /require\((['"])([^'"\r\n]+)\1\)/gu; text = text.replace(staticRequire, (_all, _quote, request) => { if (request.startsWith(".")) { let resolved = path.posix.normalize(path.posix.join(path.posix.dirname(id), request)); if (!path.posix.extname(resolved)) resolved += ".js"; if (!ids.has(resolved)) throw new Error(`BUNDLE_LOCAL_MISSING:${id}:${request}`); return `require(${JSON.stringify(`r2:${resolved}`)})`; } if (!request.startsWith("node:") && !["assert","buffer","crypto","events","fs","os","path","perf_hooks","stream","url","util"].includes(request)) throw new Error(`BUNDLE_EXTERNAL_REQUIRE:${id}:${request}`); builtins.add(request); return `require(${JSON.stringify(request)})`; }); if (/\b(?:import\s*\(|require\s*\()\s*[`]/u.test(text) || /(?:from|import)\s+['"]\.\.?\//u.test(text)) throw new Error(`BUNDLE_DYNAMIC_LOCAL:${id}`); return text; }
function footer() { return String.raw`
const __r2NativeRequire = require;
const __r2Path = __r2NativeRequire("node:path");
const __r2Fs = __r2NativeRequire("node:fs");
const __r2Crypto = __r2NativeRequire("node:crypto");
const __r2Cache = Object.create(null);
function __r2Require(request) {
  if (!request.startsWith("r2:")) { if (!request.startsWith("node:") && !["assert","buffer","crypto","events","fs","os","path","perf_hooks","stream","url","util"].includes(request)) throw new Error("R2_BUNDLE_EXTERNAL_REQUIRE"); return __r2NativeRequire(request); }
  const id=request.slice(3), factory=__r2Registry[id]; if (!factory) throw new Error("R2_BUNDLE_MODULE_MISSING"); if (__r2Cache[id]) return __r2Cache[id].exports;
  const module={exports:{}}, filename=__r2Path.join(process.cwd(),...id.split("/")); __r2Cache[id]=module; factory(module,module.exports,__r2Require,filename,__r2Path.dirname(filename)); return module.exports;
}
function __r2HashFd(fd) { const hash=__r2Crypto.createHash("sha256"), chunk=Buffer.alloc(65536), stat=__r2Fs.fstatSync(fd,{bigint:true}); let position=0; while(position<Number(stat.size)){const count=__r2Fs.readSync(fd,chunk,0,Math.min(chunk.length,Number(stat.size)-position),position);if(!count)throw new Error("R2_BUNDLE_FD_READ");hash.update(chunk.subarray(0,count));position+=count;}return {sha256:hash.digest("hex"),bytes:Number(stat.size),dev:String(stat.dev),ino:String(stat.ino)};}
const __r2Argv=process.argv.slice(2), __r2Match=__r2Argv.length===6&&__r2Argv[0]==="--r2-bundle-sha256"&&/^[0-9a-f]{64}$/.test(__r2Argv[1])&&__r2Argv[2]==="--r2-bundle-seals"&&__r2Argv[3]==="15"&&__r2Argv[4]==="--r2-action";
if(!__r2Match)throw new Error("R2_BUNDLE_ARGV"); const __r2Observed=__r2HashFd(3); if(__r2Observed.sha256!==__r2Argv[1])throw new Error("R2_BUNDLE_FD_HASH");
Object.defineProperty(globalThis,"__ROBIN_R2_BUNDLE_AUTHORITY",{value:Object.freeze({...__r2Observed,fd:3,seals:15}),writable:false,configurable:false});
const __r2Action=__r2Argv[5], __r2Entries=${JSON.stringify(ENTRYPOINTS)};
async function __r2Dispatch(){
  if(__r2Action==="bundle-selftest"){process.stdout.write("R2_BUNDLE_IMMUTABLE_V1 "+__r2Observed.sha256+" 15\n");return;}
  if(__r2Action==="broker-bundle-selftest"){const capture=__r2Require("r2:tools/polygon-robin-runtime-r2-capture.js");const result=await capture.spawnBundleProbe();process.stdout.write("R2_BROKER_BUNDLE_IMMUTABLE_V1 "+result.sha256+" "+result.seals+"\n");return;}
  if(__r2Action==="internal-broker-probe"){process.stdout.write("R2_INTERNAL_BUNDLE_PROBE "+__r2Observed.sha256+" 15\n");return;}
  if(__r2Action==="stage-selftest"){const os=__r2NativeRequire("node:os"),stage=__r2Require("r2:tools/polygon-robin-runtime-r2-stage.js"),home=__r2Path.join(os.tmpdir(),"robin-r2-bundle-stage-"+process.pid),uid=process.getuid(),gid=process.getgid(),info={uid,gid,username:"r2bundle",homedir:home},passwd="r2bundle:x:"+uid+":"+gid+"::"+home+":/bin/false\n",shared=[".local",".local/share",".local/share/evm-audit"];__r2Fs.mkdirSync(home,{mode:0o750});__r2Fs.chmodSync(home,0o750);for(const relative of shared){const target=__r2Path.join(home,...relative.split("/"));__r2Fs.mkdirSync(target,{mode:0o755});__r2Fs.chmodSync(target,0o755);}try{const result=await stage.stage({skipStartup:true,userInfo:info,passwd}),seal=JSON.parse(__r2Fs.readFileSync(__r2Path.join(result.root,"staging-seal.json")));if(!result.records||!__r2Fs.existsSync(__r2Path.join(result.root,"tools/vendor/polygon-robin-runtime-r2-actions.bundle.js"))||(__r2Fs.statSync(result.root).mode&0o777)!==0o700||seal.schemaVersion!=="robin-runtime-r2/staging-seal-v4"||shared.some(relative=>(__r2Fs.statSync(__r2Path.join(home,...relative.split("/"))).mode&0o777)!==0o755))throw new Error("R2_STAGE_SELFTEST");process.stdout.write("R2_STAGE_BUNDLE_GRAPH_PASS "+result.records+"\n");}finally{__r2Fs.rmSync(home,{recursive:true,force:true});}return;}
  const id=__r2Entries[__r2Action];if(!id)throw new Error("R2_BUNDLE_ACTION");const entry=__r2Require("r2:"+id);if(__r2Action==="capture"||__r2Action==="recover")return entry.main(["--"+__r2Action,"--execution-id","robin-runtime-r2-execution-0001"]);if(__r2Action==="validate")return entry.main(["--validate"]);if(__r2Action==="export")return entry.main(["--export"]);if(__r2Action==="internal-broker")return entry.main(["--broker"]);return entry.main([]);
}
__r2Dispatch().catch((error)=>{if(__r2Action==="internal-broker"||__r2Action==="internal-broker-probe")process.exitCode=76;else{process.stdout.write("ROBIN_RUNTIME_R2_FAIL\n");process.exitCode=1;}});
`;
}
function build() { const ids = new Set(MODULES), builtins = new Set(), records = [], factories = []; for (const id of MODULES) { const bytes = fs.readFileSync(absolute(id)), source = bytes.toString("utf8"), transformed = transform(source,id,ids,builtins); records.push({path:id,bytes:bytes.length,sha256:sha256(bytes)}); factories.push(`${JSON.stringify(id)}:function(module,exports,require,__filename,__dirname){\n${transformed}\n}`); } const bundle = Buffer.from(`#!/usr/bin/env node\n"use strict";\nconst __r2Registry=Object.freeze({${factories.join(",\n")}});\n${footer()}\n`); return { bundle, authority: { schemaVersion:"robin-runtime-r2/action-bundle-authority-v1",claimId:STEM,status:"DETERMINISTIC_SELF_CONTAINED_COMMONJS_CLOSURE",bundle:{path:BUNDLE_REL,bytes:bundle.length,sha256:sha256(bundle)},build:{count:2,byteIdentical:true,generator:"tools/polygon-robin-runtime-r2-bundle.js",noExternalDependency:true},modules:records,closureAggregateSha256:sha256(Buffer.from(canonical(records))),entrypoints:ENTRYPOINTS,builtinRequires:[...builtins].sort(),localResolver:"INTERNAL_REGISTRY_ONLY_R2_PREFIX",virtualPaths:"CWD_LOGICAL_ROOT_PLUS_MODULE_ID",runtimeLocalFilesystemCodeLoads:false } }; }
function main(argv=process.argv.slice(2)){if(argv.length!==1||!["--write","--check"].includes(argv[0]))throw new Error("BUNDLE_ARGV");const a=build(),b=build();if(!a.bundle.equals(b.bundle)||canonical(a.authority)!==canonical(b.authority))throw new Error("BUNDLE_NONDETERMINISTIC");const bundlePath=absolute(BUNDLE_REL),authorityPath=absolute(AUTHORITY_REL),authorityBytes=Buffer.from(`${canonical(a.authority)}\n`);if(argv[0]==="--write"){fs.writeFileSync(bundlePath,a.bundle,{mode:0o600});fs.writeFileSync(authorityPath,authorityBytes,{mode:0o600});}else if(!fs.readFileSync(bundlePath).equals(a.bundle)||!fs.readFileSync(authorityPath).equals(authorityBytes))throw new Error("BUNDLE_STALE");process.stdout.write("ROBIN_RUNTIME_R2_BUNDLE_PASS\n");}
module.exports={ROOT,STEM,BUNDLE_REL,AUTHORITY_REL,MODULES,ENTRYPOINTS,sha256,canonical,absolute,transform,build,main};
if(require.main===module){try{main();}catch(error){process.stdout.write("ROBIN_RUNTIME_R2_BUNDLE_FAIL\n");process.exitCode=1;}}
