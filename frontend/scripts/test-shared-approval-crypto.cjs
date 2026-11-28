const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const sourcePath = path.resolve(__dirname, "../src/utils/storage/shared-approval-crypto.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
  },
  fileName: sourcePath,
}).outputText;

const testModule = new Module(sourcePath, module);
testModule.filename = sourcePath;
testModule.paths = Module._nodeModulePaths(path.dirname(sourcePath));
testModule._compile(compiled, sourcePath);

const {
  createSharedApprovalKeyPair,
  signSharedApprovalPayload,
  verifySharedApprovalPayload,
} = testModule.exports;

async function run() {
const keys = await createSharedApprovalKeyPair();
const payload = {
  app: "Ortho Logbook Decision",
  protocolVersion: 2,
  workspaceId: "test-workspace",
  requestId: "request-123",
  decision: "approve",
  approvedBy: "owner@example.com",
  approvedAt: "2026-11-28T12:00:00.000Z",
  delta: { changedTables: ["patients"], patients: [{ id: "p-1", name: "Test" }] },
};
const signature = signSharedApprovalPayload(payload, keys.secretKey);

assert.equal(verifySharedApprovalPayload(payload, signature, keys.publicKey), true);
assert.equal(verifySharedApprovalPayload({ ...payload, decision: "reject" }, signature, keys.publicKey), false);
assert.equal(verifySharedApprovalPayload(payload, signature, createSharedApprovalKeyPair().publicKey), false);
assert.equal(verifySharedApprovalPayload(payload, "not-a-signature", keys.publicKey), false);

console.log("Shared approval signature tests passed.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
