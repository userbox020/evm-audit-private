"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const batchTool = require("../live-execution-batch.js");

function createApprovalFixture(dir, approverId = "test-approver") {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const registryPath = path.join(dir, "live-execution-approvers.json");
  const publicKeySpkiDerBase64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  fs.writeFileSync(registryPath, `${JSON.stringify({
    schema: batchTool.REGISTRY_SCHEMA,
    approvers: [{ approverId, algorithm: "Ed25519", publicKeySpkiDerBase64 }],
  }, null, 2)}\n`, { flag: "wx" });
  const registrySha256 = `0x${crypto.createHash("sha256").update(fs.readFileSync(registryPath)).digest("hex")}`;
  const sign = (scope, schema = scope.schema) => {
    const scopeCommitment = batchTool.scopeCommitment(scope);
    return {
      ...scope,
      approval: {
        scheme: "Ed25519",
        approverId,
        scopeCommitment,
        signature: crypto.sign(null, batchTool.approvalMessage(scopeCommitment, { scheme: "Ed25519", approverId }, schema), privateKey).toString("base64"),
      },
    };
  };
  return { registryPath, registrySha256, sign };
}

module.exports = { createApprovalFixture };
