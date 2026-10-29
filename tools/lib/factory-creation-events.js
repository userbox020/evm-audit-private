"use strict";
/*
 * tools/lib/factory-creation-events.js
 *
 * Keyless, bounded enumeration of contracts created by known factory contracts,
 * via `eth_getLogs` over the factory address filtered by the creation event's
 * topic0. Decodes the created address from each event payload using the event
 * ABI fragment from the registry. Read-only; no signing, no state changes.
 *
 * Fail-closed: callers must treat `stats.entriesOk === 0` as no coverage. The
 * module never emits endpoint values; errors are reduced to short reasons.
 */

const { Interface, getAddress, isHexString } = require("ethers");

const DEFAULTS = Object.freeze({
  maxLogs: 20000,
  maxCreations: 2000,
  maxCreationsPerEntry: 300,
  maxChunksPerEntry: 40,
  concurrency: 4,
  chunkBlocks: 1000,
});

function sanitizeReason(e) {
  const raw = e && e.message ? e.message : String(e);
  return raw
    .replace(/https?:\/\/[^\s"')]+/g, "<endpoint>")
    .replace(/[\w.-]+\.(com|org|io|net|xyz|dev)\b/g, "<host>")
    .slice(0, 120);
}

function hexToInt(h) {
  if (h === null || h === undefined) return null;
  try {
    return Number(BigInt(h));
  } catch {
    return null;
  }
}

function buildDecoders(entries) {
  const out = [];
  for (const entry of entries) {
    let iface;
    let eventName;
    try {
      iface = new Interface([entry.event]);
      eventName = entry.event.replace(/^event\s+/, "").split("(")[0].trim();
      const frag = iface.getEvent(eventName);
      out.push({
        entry,
        iface,
        eventName,
        topic0: frag.topicHash,
        createdArg: entry.createdArg || null,
        createdIndex: Number.isInteger(entry.createdIndex) ? entry.createdIndex : null,
        filter: entry.filter || null,
      });
    } catch (e) {
      out.push({ entry, error: sanitizeReason(e) });
    }
  }
  return out;
}

function chunkRanges(fromBlock, toBlock, chunkBlocks) {
  const ranges = [];
  for (let start = fromBlock; start <= toBlock; start += chunkBlocks) {
    const end = Math.min(toBlock, start + chunkBlocks - 1);
    ranges.push([start, end]);
  }
  return ranges;
}

function extractCreated(decoder, log) {
  const parsed = decoder.iface.parseLog({ topics: log.topics, data: log.data });
  if (!parsed) return { address: null, reason: "parse-null" };
  if (decoder.filter) {
    const v = parsed.args[decoder.filter.arg];
    if (v !== decoder.filter.eq) return { address: null, reason: "filtered" };
  }
  let raw = null;
  if (decoder.createdArg && parsed.args[decoder.createdArg] !== undefined) {
    raw = parsed.args[decoder.createdArg];
  } else if (decoder.createdIndex !== null && parsed.args[decoder.createdIndex] !== undefined) {
    raw = parsed.args[decoder.createdIndex];
  }
  if (typeof raw !== "string" || !isHexString(raw, 20)) return { address: null, reason: "bad-address-field" };
  try {
    return { address: getAddress(raw), reason: null };
  } catch {
    return { address: null, reason: "bad-address-checksum" };
  }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    new Array(n).fill(0).map(async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        try {
          results[i] = { ok: true, value: await worker(items[i], i) };
        } catch (e) {
          results[i] = { ok: false, error: sanitizeReason(e) };
        }
      }
    })
  );
  return results;
}

/**
 * @param {(method:string, params:any[])=>Promise<{result:any}>} rpcCall
 * @param {object} opts
 * @returns {Promise<{rows:Array, stats:object}>}
 */
async function enumerateFactoryCreations(rpcCall, opts) {
  const entries = Array.isArray(opts.entries) ? opts.entries : [];
  const fromBlock = opts.fromBlock;
  const toBlock = opts.toBlock;
  const maxLogs = Number.isFinite(opts.maxLogs) ? opts.maxLogs : DEFAULTS.maxLogs;
  const maxCreations = Number.isFinite(opts.maxCreations) ? opts.maxCreations : DEFAULTS.maxCreations;
  const maxCreationsPerEntry = Number.isFinite(opts.maxCreationsPerEntry) ? opts.maxCreationsPerEntry : DEFAULTS.maxCreationsPerEntry;
  const maxChunksPerEntry = Number.isFinite(opts.maxChunksPerEntry) ? opts.maxChunksPerEntry : DEFAULTS.maxChunksPerEntry;
  const concurrency = Number.isFinite(opts.concurrency) ? opts.concurrency : DEFAULTS.concurrency;

  const stats = {
    fromBlock,
    toBlock,
    entriesRegistered: entries.length,
    entriesProbed: 0,
    entriesOk: 0,
    entriesFailed: 0,
    entriesNoEvents: 0,
    queriesOk: 0,
    queriesFailed: 0,
    queriesSkippedByChunkCap: 0,
    logsFetched: 0,
    creationsFound: 0,
    decodeFailures: 0,
    filteredOut: 0,
    truncatedByMaxLogs: false,
    truncatedByMaxCreations: false,
    truncatedByPerEntry: [],
    perFactory: {},
    failures: [],
  };

  if (!Number.isFinite(fromBlock) || !Number.isFinite(toBlock) || toBlock < fromBlock) {
    const err = new Error("FACTORY_BAD_RANGE");
    err.code = "FACTORY_BAD_RANGE";
    throw err;
  }

  const decoders = buildDecoders(entries);
  const usable = decoders.filter((d) => !d.error);
  for (const d of decoders.filter((x) => x.error)) {
    stats.entriesFailed++;
    stats.failures.push({ factory: d.entry && d.entry.name, error: d.error });
  }

  const rows = [];
  let creationBudgetHit = false;

  const perEntry = await mapLimit(usable, Math.max(1, concurrency), async (decoder) => {
    const entry = decoder.entry;
    const chunkBlocks = Number.isFinite(entry.chunkBlocks) ? entry.chunkBlocks : DEFAULTS.chunkBlocks;
    const entryCap = Number.isFinite(entry.maxCreations) ? entry.maxCreations : maxCreationsPerEntry;
    const allRanges = chunkRanges(fromBlock, toBlock, chunkBlocks);
    const ranges = allRanges.slice(0, maxChunksPerEntry);
    const local = { name: entry.name, address: entry.address, kind: entry.kind, logs: 0, creations: 0, queriesFailed: 0, queriesOk: 0 };

    if (allRanges.length > maxChunksPerEntry) {
      stats.queriesSkippedByChunkCap += allRanges.length - maxChunksPerEntry;
    }

    for (const [start, end] of ranges) {
      if (stats.truncatedByMaxLogs || creationBudgetHit || local.creations >= entryCap) break;
      let logs;
      try {
        const res = await rpcCall("eth_getLogs", [
          {
            address: entry.address,
            topics: [decoder.topic0],
            fromBlock: "0x" + start.toString(16),
            toBlock: "0x" + end.toString(16),
          },
        ]);
        logs = Array.isArray(res && res.result) ? res.result : [];
        local.queriesOk++;
        stats.queriesOk++;
      } catch (e) {
        local.queriesFailed++;
        stats.queriesFailed++;
        stats.failures.push({ factory: entry.name, range: start + "-" + end, error: sanitizeReason(e) });
        continue;
      }

      local.logs += logs.length;
      stats.logsFetched += logs.length;
      if (stats.logsFetched >= maxLogs) stats.truncatedByMaxLogs = true;

      for (const log of logs) {
        if (local.creations >= entryCap) {
          if (!stats.truncatedByPerEntry.includes(entry.name)) stats.truncatedByPerEntry.push(entry.name);
          break;
        }
        let decoded;
        try {
          decoded = extractCreated(decoder, log);
        } catch (e) {
          stats.decodeFailures++;
          continue;
        }
        if (!decoded.address) {
          if (decoded.reason === "filtered") stats.filteredOut++;
          else stats.decodeFailures++;
          continue;
        }
        if (rows.length >= maxCreations) {
          stats.truncatedByMaxCreations = true;
          creationBudgetHit = true;
          break;
        }
        const blockNumber = hexToInt(log.blockNumber);
        rows.push({
          address: decoded.address,
          source: "factory-event:" + entry.name,
          creationBlock: blockNumber,
          creationTx: log.transactionHash || null,
          deployer: entry.address,
          factoryName: entry.name,
          factoryKind: entry.kind,
          verifiedAt: null,
          isVerified: null,
        });
        local.creations++;
        stats.creationsFound++;
      }
    }

    if (local.queriesOk > 0) stats.entriesOk++;
    else stats.entriesFailed++;
    if (local.logs === 0 && local.queriesFailed === 0) stats.entriesNoEvents++;
    stats.perFactory[entry.name] = { logs: local.logs, creations: local.creations, queriesOk: local.queriesOk, queriesFailed: local.queriesFailed };
    return local;
  });

  stats.entriesProbed = perEntry.length;
  return { rows, stats };
}

module.exports = { enumerateFactoryCreations, buildDecoders, _internal: { chunkRanges, extractCreated, sanitizeReason } };
