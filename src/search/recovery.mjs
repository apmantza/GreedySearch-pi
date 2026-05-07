// src/search/recovery.mjs — Headless-block detection and visible recovery policy

// Only these engines use automatic headless → visible recovery. Google is
// intentionally excluded for now; see issue #9 discussion / maintainer choice.
export const HEADLESS_RECOVERY_ENGINES = ["perplexity", "bing"];

const HEADLESS_BLOCKED_PATTERN =
	/timed out|timeout|verification|captcha|cloudflare|turnstile|input not found|ask-input|clipboard|copy button hidden/i;

const MANUAL_VERIFICATION_PATTERN =
	/needs-human|verification required|please solve|captcha|cloudflare|turnstile|could not be completed automatically|manual intervention/i;

export function isHeadlessBlockedError(error) {
	return HEADLESS_BLOCKED_PATTERN.test(String(error || ""));
}

export function isManualVerificationError(error) {
	return MANUAL_VERIFICATION_PATTERN.test(String(error || ""));
}

export function findHeadlessBlockedEngines(resultsByEngine) {
	return HEADLESS_RECOVERY_ENGINES.filter((engine) => {
		const error = resultsByEngine?.[engine]?.error;
		return error && isHeadlessBlockedError(error);
	});
}
