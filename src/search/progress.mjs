// src/search/progress.mjs — Progress bar with ETA for long-running research
//
// Tracks per-action and per-round timing, prints a progress bar to stderr
// after each step with an ETA based on rolling average. Inspired by pi-webaio's
// streaming progress output.
//
// Usage:
//   const tracker = createProgressTracker({ totalActions: 6, totalRounds: 2 });
//   tracker.startRound(1);
//   tracker.startAction('search', 'what is X');
//   ... do work ...
//   tracker.endAction();
//   tracker.startAction('fetch', 'https://...');
//   ... do work ...
//   tracker.endAction();
//   tracker.endRound();
//   tracker.print(); // prints bar to stderr

const BAR_WIDTH = 20;

/**
 * Format seconds as a human-readable duration (e.g. "1m 23s", "45s", "0s")
 */
function formatDuration(ms) {
	if (ms < 1000) return "0s";
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m ${seconds}s`;
}

/**
 * Render a progress bar string.
 * Example: [████████████░░░░░░░░] 12/20 (ETA 1m 30s)
 */
function renderBar(progress, width = BAR_WIDTH) {
	const filled = Math.round(progress * width);
	const empty = width - filled;
	return "[" + "█".repeat(filled) + "░".repeat(empty) + "]";
}

/**
 * Create a progress tracker.
 * @param {object} opts
 * @param {number} opts.totalActions - Total expected actions across all rounds
 * @param {number} opts.totalRounds - Total expected rounds
 * @param {number} opts.totalFetches - Total expected source fetches
 * @param {boolean} [opts.silent] - Suppress stderr output (for tests)
 */
export function createProgressTracker({
	totalActions = 0,
	totalRounds = 0,
	totalFetches = 0,
	silent = false,
} = {}) {
	const startedAt = Date.now();
	let completedActions = 0;
	let completedRounds = 0;
	let completedFetches = 0;
	const actionTimings = []; // rolling window of recent action durations
	let currentActionStart = null;
	let currentActionLabel = null;
	let lastPrintAt = 0;
	const MIN_PRINT_INTERVAL_MS = 500; // throttle to avoid spam

	function recordAction(durationMs) {
		actionTimings.push(durationMs);
		// keep only last 5 for rolling average
		if (actionTimings.length > 5) actionTimings.shift();
	}

	function avgActionMs() {
		if (actionTimings.length === 0) return null;
		return actionTimings.reduce((a, b) => a + b, 0) / actionTimings.length;
	}

	function buildStatus(phase) {
		const elapsed = Date.now() - startedAt;
		const total = totalActions + totalFetches + totalRounds;
		const done = completedActions + completedFetches + completedRounds;
		const progress = total > 0 ? Math.min(1, done / total) : 0;
		const bar = renderBar(progress);
		const avg = avgActionMs();
		const remaining = Math.max(0, total - done);
		const etaMs = avg ? avg * remaining : null;
		const eta = etaMs ? formatDuration(etaMs) : "—";
		const label = currentActionLabel ? ` ${currentActionLabel}` : "";
		return `${bar} ${done}/${total} (${phase}${label}, ETA ${eta})`;
	}

	function print(phase) {
		if (silent) return;
		const now = Date.now();
		// throttle to avoid spamming
		if (now - lastPrintAt < MIN_PRINT_INTERVAL_MS && phase !== "done") return;
		lastPrintAt = now;
		process.stderr.write(`[greedysearch] ${buildStatus(phase)}\n`);
	}

	return {
		startRound(n) {
			completedRounds = n - 1; // will be incremented when endRound fires
		},
		endRound() {
			completedRounds++;
			print("round");
		},
		startAction(type, label) {
			currentActionStart = Date.now();
			currentActionLabel = `${type}:${(label || "").slice(0, 40)}`;
			print(type);
		},
		endAction() {
			if (currentActionStart) {
				recordAction(Date.now() - currentActionStart);
				currentActionStart = null;
			}
			completedActions++;
			print("action");
		},
		startFetch(label) {
			currentActionStart = Date.now();
			currentActionLabel = `fetch:${(label || "").slice(0, 40)}`;
			print("fetch");
		},
		endFetch(ok = true) {
			if (currentActionStart) {
				recordAction(Date.now() - currentActionStart);
				currentActionStart = null;
			}
			completedFetches++;
			print(ok ? "fetch" : "fetch-failed");
		},
		print() {
			print("progress");
		},
		finish() {
			print("done");
		},
		getElapsedMs() {
			return Date.now() - startedAt;
		},
	};
}
