"use strict";

// Bound a read-only watch by both its requested lifetime and the approved batch expiry.
const MAX_LOOP_HOURS = 24 * 30;

function batchDeadline(now, expiresAt, requestedHours = MAX_LOOP_HOURS) {
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(now) || !Number.isFinite(expiry) || now >= expiry) {
    throw new Error("batch-expired-or-invalid");
  }
  if (!Number.isFinite(requestedHours) || requestedHours <= 0) {
    throw new Error("invalid-loop-hours");
  }
  return Math.min(expiry, now + Math.min(requestedHours, MAX_LOOP_HOURS) * 3600 * 1000);
}

// The dedicated read-only canary has no batch expiry or implicit lifetime.
function dedicatedReadOnlyDeadline(now, requestedHours) {
  if (requestedHours === undefined) return null;
  if (!Number.isFinite(now) || !Number.isFinite(requestedHours) ||
      requestedHours <= 0 || requestedHours > MAX_LOOP_HOURS) {
    throw new Error("invalid-loop-hours");
  }
  const deadline = now + requestedHours * 3600 * 1000;
  if (!Number.isFinite(deadline) || !Number.isFinite(new Date(deadline).getTime())) {
    throw new Error("invalid-loop-hours");
  }
  return deadline;
}

module.exports = { MAX_LOOP_HOURS, batchDeadline, dedicatedReadOnlyDeadline };
