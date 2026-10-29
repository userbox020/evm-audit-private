'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  CORRECTION_PATH,
  HANDOFF_PATH,
  INBOX_PATH,
  buildModel,
  fileCommitment,
  sha256,
} = require('./build-cap-current-reserve-callback-calltarget-gate1-r3-final-review-correction');

const ROOT = path.resolve(__dirname, '..');
let suites = 0;
let assertions = 0;

function absolute(relativePath) {
  return path.join(ROOT, ...relativePath.split('/'));
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(absolute(relativePath), 'utf8'));
}

function check(value, message) {
  assertions += 1;
  assert.ok(value, message);
}

function equal(actual, expected, message) {
  assertions += 1;
  assert.equal(actual, expected, message);
}

function suite(name, fn) {
  suites += 1;
  fn();
  console.log(`ok ${suites} - ${name}`);
}

const correction = readJson(CORRECTION_PATH);
const inbox = readJson(INBOX_PATH);
const handoff = fs.readFileSync(absolute(HANDOFF_PATH), 'utf8');

suite('correction counts are recomputed from R3 JSON', () => {
  const model = buildModel();
  for (const key of ['expectedCount', 'observedCount', 'absentCount', 'extraCount', 'intersectionCount']) {
    equal(correction.comparison[key], model.comparison[key], `${key} must match offline recomputation`);
  }
  equal(correction.comparison.mismatchedIntersectionCount, model.mismatchIds.length);
  equal(correction.comparison.allIntersectionRowsFieldMismatched, true);
  equal(correction.inventoryProvenance.unanchoredExpectedRows, model.unanchoredExpectedRows);
  equal(correction.inventoryProvenance.expectedNullTargetRows, model.expectedNullTargetRows);
});

suite('predecessor and current artifact hashes are live commitments', () => {
  const groups = [
    correction.integrity.originalR3CanonicalArtifacts,
    correction.integrity.supersededR1R2ArtifactsWherePresent,
    correction.integrity.currentOverlayArtifacts,
  ];
  for (const group of groups) {
    check(group.length > 0, 'commitment group must not be empty');
    for (const committed of group) {
      const current = fileCommitment(committed.path);
      equal(current.bytes, committed.bytes, `${committed.path} byte length changed`);
      equal(current.sha256, committed.sha256, `${committed.path} hash changed`);
    }
  }
  const projection = structuredClone(correction);
  const committedSelf = projection.integrity.selfCanonicalPayloadCommitment.sha256;
  projection.integrity.selfCanonicalPayloadCommitment.sha256 = null;
  equal(sha256(Buffer.from(`${JSON.stringify(projection, null, 2)}\n`, 'utf8')), committedSelf);
});

suite('disabled zero targets are retained but are not blockers', () => {
  const model = buildModel();
  equal(correction.disabledZeroHandling.count, model.disabledZeroRows.length);
  equal(correction.disabledZeroHandling.count, 4);
  equal(correction.disabledZeroHandling.executable, false);
  equal(correction.disabledZeroHandling.retainedAsConfiguration, true);
  equal(correction.disabledZeroHandling.staticTargetBlocker, false);
  check(
    correction.disabledZeroHandling.rows.every((edgeId) =>
      model.disabledZeroRows.some((row) => row.edgeId === edgeId && row.target.endsWith('0000000000000000000000000000000000000000')),
    ),
    'every corrected disabled row must be a zero target from R3 JSON',
  );
});

suite('canonical result remains unknown and fail closed', () => {
  equal(correction.canonicalStatus, 'UNKNOWN_FAIL_CLOSED');
  equal(correction.finalReviewVerdict, 'APPROVE_UNKNOWN_WITH_CORRECTIONS');
  equal(correction.disposition, 'STOP_ROTATE');
  equal(correction.callback.overallReachability, 'UNKNOWN');
  equal(correction.callback.globalSynchronousRoute, null);
  equal(correction.gates.routePositive, false);
  equal(correction.gates.executableNow, false);
  equal(correction.gates.proofRouteImpossible, false);
});

suite('new reviewed coordination artifacts contain no contradictory result labels', () => {
  equal(inbox.status, 'UNKNOWN_FAIL_CLOSED');
  equal(inbox.canonicalStatus, 'UNKNOWN_FAIL_CLOSED');
  equal(inbox.finalReviewVerdict, 'APPROVE_UNKNOWN_WITH_CORRECTIONS');
  equal(inbox.disposition, 'STOP_ROTATE');
  check(handoff.includes('`UNKNOWN_FAIL_CLOSED`'), 'handoff must carry canonical unknown status');
  check(handoff.includes('`APPROVE_UNKNOWN_WITH_CORRECTIONS`'), 'handoff must carry review verdict');
  const combined = `${JSON.stringify(inbox)}\n${handoff}`;
  check(!/\b(?:CONFIRMED_NEGATIVE|CALLBACK_NEGATIVE|CLOSED_NEGATIVE|ROUTE_IMPOSSIBLE|EXECUTABLE_CONFIRMED)\b/.test(combined));
});

console.log(`# ${suites} suites, ${assertions} assertions passed`);
