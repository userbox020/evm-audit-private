"use strict";

const assert = require("node:assert/strict");
const { TextDecoder } = require("node:util");

const TOKEN = "UTF8_BYTEWISE_BUFFER_COMPARE_NO_LOCALE_NO_NORMALIZATION";

function strictUtf8(value) {
  assert.equal(typeof value, "string", "ORDER_STRING_REQUIRED");
  for (let index = 0; index < value.length; index++) {
    const first = value.charCodeAt(index);
    if (first >= 0xd800 && first <= 0xdbff) {
      assert.ok(index + 1 < value.length, "ORDER_SURROGATE_INVALID");
      const second = value.charCodeAt(index + 1);
      assert.ok(second >= 0xdc00 && second <= 0xdfff, "ORDER_SURROGATE_INVALID");
      index++;
    } else assert.equal(first >= 0xdc00 && first <= 0xdfff, false, "ORDER_SURROGATE_INVALID");
  }
  const bytes = Buffer.from(value, "utf8"), decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assert.equal(decoded, value, "ORDER_UTF8_ROUNDTRIP");
  return bytes;
}
function compareUtf8(left, right) { return Buffer.compare(strictUtf8(left), strictUtf8(right)); }
function sortStrings(values) { return [...values].sort(compareUtf8); }
function sortBy(values, select) { return [...values].sort((left, right) => compareUtf8(select(left), select(right))); }
function assertCanonicalOrder(values, select = value => value, code = "ORDER_NONCANONICAL") { for (let index = 0; index < values.length; index++) { const current = select(values[index]); strictUtf8(current); if (index > 0) assert.ok(compareUtf8(select(values[index - 1]), current) < 0, code); } return values; }
function canonical(value) { if (value === null || typeof value !== "object") { if (typeof value === "string") strictUtf8(value); return JSON.stringify(value); } if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; return `{${sortStrings(Object.keys(value)).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; }

module.exports = Object.freeze({ TOKEN, strictUtf8, compareUtf8, sortStrings, sortBy, assertCanonicalOrder, canonical });
