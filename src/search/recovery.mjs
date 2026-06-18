// src/search/recovery.mjs — Headless-block detection and visible recovery policy

// Only these engines use automatic headless → visible recovery. Google is
// intentionally excluded for now; see issue #9 discussion / maintainer choice.
export const HEADLESS_RECOVERY_ENGINES = [
	"perplexity",
	"bing",
	"chatgpt",
	"semantic-scholar",
	"logically",
];

// blockedBy values that indicate visible-mode cookies CANNOT bypass the block.
// These still match the "headless blocked" shape but should NOT trigger
// visible recovery — the block is account-level (rate limit, ban) or
// structural (page redesign), not session-level.
const NON_RECOVERABLE_BLOCKED_BY = new Set(["rate-limit"]);

const HEADLESS_BLOCKED_PATTERN =
	/timed out|timeout|verification|captcha|cloudflare|turnstile|input not found|ask-input|copy button hidden|sign.in|login required/i;

const MANUAL_VERIFICATION_PATTERN =
	/needs-human|verification required|please solve|captcha|cloudflare|turnstile|could not be completed automatically|manual intervention|sign.in|login required/i;

export function isHeadlessBlockedError(error) {
	return HEADLESS_BLOCKED_PATTERN.test(String(error || ""));
}

export function isManualVerificationError(error) {
	return MANUAL_VERIFICATION_PATTERN.test(String(error || ""));
}

/**
 * Check if a blockedBy value is non-recoverable (visible retry won't help).
 */
export function isNonRecoverableBlockedBy(blockedBy) {
	return NON_RECOVERABLE_BLOCKED_BY.has(blockedBy);
}

export function findHeadlessBlockedEngines(resultsByEngine) {
	return HEADLESS_RECOVERY_ENGINES.filter((engine) => {
		const result = resultsByEngine?.[engine];
		if (!result) return false;
		// Data-driven: check envelope first (zero regex cost)
		const blockedBy = result._envelope?.blockedBy;
		if (blockedBy) {
			// Skip non-recoverable blocks (rate-limit, ban, etc.)
			if (NON_RECOVERABLE_BLOCKED_BY.has(blockedBy)) return false;
			return true;
		}
		if (result._envelope?.verificationResult === "needs-human") return true;
		// Fallback: legacy string matching for errors passed as plain strings
		const error = result.error;
		return error && isHeadlessBlockedError(error);
	});
}

/**
 * Check if an extractor Error carries a structured envelope indicating
 * headless blocking. Used in single-engine recovery paths where the Error
 * object is caught directly rather than parsed from a result record.
 */
export function isHeadlessBlockedResult(error) {
	if (!error) return false;
	const env = error.envelope;
	if (env?.blockedBy) {
		// Skip non-recoverable blocks (rate-limit, ban, etc.)
		if (NON_RECOVERABLE_BLOCKED_BY.has(env.blockedBy)) return false;
		return true;
	}
	if (env?.verificationResult === "needs-human") return true;
	return isHeadlessBlockedError(error.message);
}
