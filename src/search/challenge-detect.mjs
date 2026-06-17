// src/search/challenge-detect.mjs — Detect when a Cloudflare/Turnstile/captcha
// challenge has been solved so the extractor can auto-resume.
//
// Polls page state (URL, title, DOM markers, cookie presence) instead of waiting
// for a hard timeout. Resolves once the engine-specific "challenge cleared"
// signal is observed, or rejects with a clear error if the polling budget is
// exhausted before any progress.
//
// Usage:
//   const cleared = await waitForChallengeCleared({ tab, engine: "chatgpt", timeoutMs: 300000 });
//   if (!cleared) emit _needsHumanVerification; else re-run extractor.

import { cdp } from "../../bin/cdp.mjs";

const DEFAULT_TIMEOUT_MS = Number.parseInt(
	process.env.GREEDY_SEARCH_CHALLENGE_WAIT_MS || "300000",
	10,
); // 5 minutes default
const POLL_INTERVAL_MS = 3000;

const ENGINE_SIGNALS = {
	chatgpt: {
		// After Cloudflare clearance, chatgpt.com shows the chat UI.
		// Title changes from "Περιμένετε..." / "Just a moment..." → "ChatGPT"
		// and div.ProseMirror renders.
		name: "chatgpt",
		isCleared: async (tab) => {
			const probe = await cdp([
				"eval",
				tab,
				`(() => {
					const title = document.title;
					const onChatGPT = location.hostname === "chatgpt.com";
					const hasProseMirror = !!document.querySelector("div.ProseMirror");
					const hasTurnstileInput =
						!!document.querySelector("input[name=\\"cf-turnstile-response\\"]") ||
						!!document.querySelector("iframe[id^=\\"cf-chl-widget-\\"]");
					// Body innerText is empty while on the Turnstile page.
					const bodyText = (document.body && document.body.innerText) || "";
					return JSON.stringify({
						title,
						url: location.href,
						hasProseMirror,
						hasTurnstileInput,
						bodyLen: bodyText.length,
						onChatGPT,
					});
				})()`,
			]).catch(() => null);
			if (!probe) return false;
			let info;
			try {
				info = JSON.parse(probe);
			} catch {
				return false;
			}
			// Cleared when we're on chatgpt.com, the title is no longer the
			// "Please wait…" placeholder, and either the chat UI rendered or
			// the Turnstile marker is gone.
			if (!info.onChatGPT) return false;
			if (
				info.title &&
				/περιμένετε|please wait|just a moment|verifying|checking/i.test(info.title)
			) {
				return false;
			}
			if (info.hasTurnstileInput) return false;
			// Either chat UI appeared OR we navigated past chatgpt.com (signed-in landing)
			return info.hasProseMirror || info.bodyLen > 50;
		},
	},
	bing: {
		// Copilot shows "Verify you are human" challenge, then transitions to the chat UI.
		// Cleared signals: URL on copilot.microsoft.com (no /challenge), textarea/input exists,
		// or the Turnstile iframe is gone.
		name: "bing",
		isCleared: async (tab) => {
			const probe = await cdp([
				"eval",
				tab,
				`(() => {
					const url = location.href;
					const title = document.title;
					const onCopilot = /copilot\\.microsoft\\.com/.test(location.hostname);
					const onChallenge =
						/challenge|turnstile|cdn-cgi\\/challenge/i.test(url) ||
						/verify|human|robot/i.test(title);
					const hasTextarea =
						!!document.querySelector("textarea") ||
						!!document.querySelector("div[contenteditable=\\"true\\"]");
					const hasTurnstileInput =
						!!document.querySelector("iframe[id^=\\"cf-chl-widget-\\"]") ||
						!!document.querySelector("input[name=\\"cf-turnstile-response\\"]");
					const bodyText = (document.body && document.body.innerText) || "";
					return JSON.stringify({
						url,
						title,
						onCopilot,
						onChallenge,
						hasTextarea,
						hasTurnstileInput,
						bodyLen: bodyText.length,
					});
				})()`,
			]).catch(() => null);
			if (!probe) return false;
			let info;
			try {
				info = JSON.parse(probe);
			} catch {
				return false;
			}
			if (!info.onCopilot) return false;
			if (info.onChallenge) return false;
			if (info.hasTurnstileInput) return false;
			// Either chat input appeared OR we're past the challenge.
			return info.hasTextarea || info.bodyLen > 50;
		},
	},
};

/**
 * Generic fallback: poll for cf_clearance cookie presence on the engine domain.
 * Used when the engine doesn't have specific DOM signals defined.
 */
async function pollForCfClearanceCookie(tab) {
	const probe = await cdp([
		"eval",
		tab,
		`(() => {
			const cookies = document.cookie || "";
			return JSON.stringify({
				hasCfClearance: /(?:^|;\\s*)cf_clearance=/.test(cookies),
				hasCfBm: /(?:^|;\\s*)__cf_bm=/.test(cookies),
				cookiesLength: cookies.length,
			});
		})()`,
	]).catch(() => null);
	if (!probe) return false;
	try {
		const info = JSON.parse(probe);
		return info.hasCfClearance || info.hasCfBm;
	} catch {
		return false;
	}
}

/**
 * Poll page state until a Cloudflare/Turnstile challenge is cleared.
 *
 * Returns:
 *   { cleared: true, signal: "..." } — challenge cleared; safe to re-extract.
 *   { cleared: false, reason: "..." } — timeout or unrecoverable.
 */
export async function waitForChallengeCleared({
	tab,
	engine,
	timeoutMs = DEFAULT_TIMEOUT_MS,
	intervalMs = POLL_INTERVAL_MS,
	signal: externalSignal,
	log = () => {},
}) {
	const def = ENGINE_SIGNALS[engine];
	const start = Date.now();
	let lastState = null;

	while (Date.now() - start < timeoutMs) {
		if (externalSignal?.aborted) {
			return { cleared: false, reason: "aborted" };
		}
		const elapsed = Math.floor((Date.now() - start) / 1000);

		let cleared = false;
		if (def) {
			cleared = await def.isCleared(tab).catch(() => false);
		} else {
			cleared = await pollForCfClearanceCookie(tab).catch(() => false);
		}
		if (cleared) {
			log(
				`[greedysearch] ✅ ${engine} challenge cleared after ${elapsed}s — auto-resuming extraction.`,
			);
			return { cleared: true, signal: def ? "dom-marker" : "cookie" };
		}

		// Periodic heartbeat to stderr so the user knows we're still polling
		if (elapsed > 0 && elapsed % 30 === 0 && lastState !== elapsed) {
			lastState = elapsed;
			log(
				`[greedysearch] ⏳ Waiting for ${engine} challenge to clear (${elapsed}s/${Math.floor(timeoutMs / 1000)}s)...`,
			);
		}

		await new Promise((r) => setTimeout(r, intervalMs));
	}

	return {
		cleared: false,
		reason: `Challenge not cleared within ${Math.floor(timeoutMs / 1000)}s`,
	};
}

export const CHALLENGE_ENGINES = Object.keys(ENGINE_SIGNALS);
