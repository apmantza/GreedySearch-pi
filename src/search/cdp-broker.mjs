// src/search/cdp-broker.mjs — Warm CDP tab broker for GreedySearch all-search
//
// Ported from pi-webaio src/browser-pool.ts + src/verticals/_cdp-shared.ts
// Adapted for GreedySearch's raw CDP on port 9222 (no Playwright).
//
// Goal: kill cold-start tail for `engine: "all"` fan-out.
// - Keep headless Chrome hot (reuses ensureChrome probe)
// - Keep 2-4 tabs warm with stealth pre-injected
// - Deadline fence like pi-webaio's collectProviderResults (ENGINE_DEADLINE_MS)
// - Degraded-pool observability so a launch failure doesn't hang acquireTabs

import { cdp, openNewTab, probeGreedyChrome } from "./chrome.mjs";
import { GREEDY_PORT } from "./constants.mjs";

// ─── Observability helpers (ported from pi-webaio browser-pool.ts) ───────

export function toLaunchErrorRecord(err, now = Date.now()) {
  const message = err instanceof Error ? err.message : String(err);
  return { message, at: now };
}

export function degradedPoolNotice(lastLaunchError) {
  if (!lastLaunchError) return null;
  return `pool degraded: last launch failed (${lastLaunchError.message})`;
}

export function formatLaunchTiming(durationMs, channel) {
  const which = channel ? `channel=${channel}` : "greedy-chrome";
  return `browser launch took ${durationMs}ms (${which})`;
}

// ─── Warm tab pool ───────────────────────────────────────────────────────

const DEFAULT_POOL_SIZE = 4;
const DEFAULT_DEADLINE_MS = 7000; // all-search hard cap, pi-webaio ENGINE_DEADLINE 3500 is per-provider HTTP; we need longer for full extractor nav+stream

let _warmTabs = []; // { targetId, inUse: boolean, createdAt: number }
let _lastLaunchError = null;
let _warming = null;

/** Probe — pi-webaio cdpIsAvailable pattern via probeGreedyChrome */
export async function cdpIsAvailable() {
  return probeGreedyChrome(1500);
}

function isTabHealthy(entry) {
  // Tab considered stale after 50 uses equivalent: here we age by 5 min
  return Date.now() - entry.createdAt < 5 * 60 * 1000;
}

async function createWarmTab() {
  const startedAt = Date.now();
  try {
    const targetId = await openNewTab("about:blank");
    const entry = { targetId, inUse: false, createdAt: Date.now() };
    // success clears degraded state
    _lastLaunchError = null;
    const dur = Date.now() - startedAt;
    // debug line mirrors pi-webaio formatLaunchTiming, gated on PI_TIMING
    if (process.env.PI_TIMING === "1") {
      process.stderr.write(`[greedysearch] ${formatLaunchTiming(dur, null)}\n`);
    }
    return entry;
  } catch (err) {
    _lastLaunchError = toLaunchErrorRecord(err);
    throw err;
  }
}

export async function ensureWarmPool(size = DEFAULT_POOL_SIZE) {
  if (_warming) return _warming;
  _warming = (async () => {
    const healthy = _warmTabs.filter(isTabHealthy);
    // drop stale
    const stale = _warmTabs.filter((t) => !isTabHealthy(t));
    for (const s of stale) {
      try {
        const anchor =
          _warmTabs[0]?.targetId?.slice(0, 8) ||
          (await cdp(["list"])).split("\n")[0]?.slice(0, 8);
        if (anchor)
          await cdp([
            "evalraw",
            anchor,
            "Target.closeTarget",
            JSON.stringify({ targetId: s.targetId }),
          ]).catch(() => {});
      } catch {}
    }
    _warmTabs = healthy;
    const need = Math.max(0, size - _warmTabs.length);
    if (need === 0) return;
    // create missing tabs in parallel, like browser-pool launchQueue dedup
    const results = await Promise.allSettled(
      Array.from({ length: need }, () => createWarmTab()),
    );
    for (const r of results) {
      if (r.status === "fulfilled") _warmTabs.push(r.value);
    }
  })();
  try {
    await _warming;
  } finally {
    _warming = null;
  }
}

export async function acquireWarmTabs(count) {
  await ensureWarmPool(count);
  // pick idle tabs first
  const idle = _warmTabs.filter((t) => !t.inUse && isTabHealthy(t));
  const picked = idle.slice(0, count);
  for (const p of picked) p.inUse = true;
  const shortfall = count - picked.length;
  if (shortfall > 0) {
    const created = await Promise.all(
      Array.from({ length: shortfall }, async () => {
        const e = await createWarmTab();
        e.inUse = true;
        _warmTabs.push(e);
        return e;
      }),
    );
    picked.push(...created);
  }
  return picked.map((p) => p.targetId);
}

export async function releaseWarmTabs(targetIds, { reset = true } = {}) {
  const idSet = new Set(targetIds);
  for (const entry of _warmTabs) {
    if (idSet.has(entry.targetId)) {
      entry.inUse = false;
      if (reset) {
        // reset to blank so next extractor gets clean slate, best-effort
        try {
          const tid = entry.targetId.slice(0, 8);
          await cdp(["eval", tid, "window.location.href='about:blank'"]).catch(
            () => {},
          );
        } catch {}
      }
    }
  }
}

export function warmPoolStats() {
  return {
    total: _warmTabs.length,
    idle: _warmTabs.filter((t) => !t.inUse).length,
    inUse: _warmTabs.filter((t) => t.inUse).length,
    lastLaunchError: _lastLaunchError,
    degradedNotice: degradedPoolNotice(_lastLaunchError),
  };
}

export function getLastLaunchError() {
  return _lastLaunchError;
}

// ─── Deadline fence (ported from pi-webaio src/search-orchestration.ts) ───

export async function collectProviderResults(
  providers,
  deadlineMs = DEFAULT_DEADLINE_MS,
) {
  const values = {};
  let acceptingValues = true;
  let timeoutHandle;

  const observed = providers.map(([key, promise]) =>
    Promise.resolve(promise).then(
      (value) => {
        if (acceptingValues) values[key] = value;
        return value;
      },
      () => undefined,
    ),
  );
  const all = Promise.all(observed);
  const timeout = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve(true), deadlineMs);
    timeoutHandle.unref?.();
  });

  let timedOut = false;
  try {
    timedOut = await Promise.race([all.then(() => false), timeout]);
  } finally {
    acceptingValues = false;
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
  return { values, timedOut };
}

export const ALL_SEARCH_DEADLINE_MS =
  Number.parseInt(process.env.GREEDY_ALL_DEADLINE_MS || "0", 10) ||
  DEFAULT_DEADLINE_MS;
