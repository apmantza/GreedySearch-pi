// extractors/selectors.mjs
// Centralized CSS selectors for all engines.
// Update selectors here when a site changes its UI.

export const SELECTORS = {
	// ──────────────────────────────────────────────
	// Perplexity (perplexity.ai)
	// ──────────────────────────────────────────────
	perplexity: {
		input: "#ask-input",
		// Note: copy button found via JS in extractor (language-agnostic)
		copyButton: null,
		sourceItem: "[data-pplx-citation-url]",
		sourceLink: "a",
		consent: "#onetrust-accept-btn-handler",
	},

	// ──────────────────────────────────────────────
	// Bing Copilot (copilot.microsoft.com)
	// ──────────────────────────────────────────────
	bing: {
		input: "#userInput",
		copyButton: 'button[data-testid="copy-ai-message-button"]',
		sourceLink: 'a[href^="http"][target="_blank"]',
		sourceExclude: "copilot.microsoft.com",
		consent: "#onetrust-accept-btn-handler",
	},

	// ──────────────────────────────────────────────
	// Google AI Mode (google.com/search?udm=50)
	// ──────────────────────────────────────────────
	google: {
		answerContainer: ".pWvJNd",
		sourceLink: 'a[href^="http"]',
		sourceExclude: ["google.", "gstatic", "googleapis"],
		sourceHeadingParent: "[data-snhf]",
		consent: '#L2AGLb, button[jsname="b3VHJd"], .tHlp8d',
	},

	// ──────────────────────────────────────────────
	// Gemini (gemini.google.com/app)
	// ──────────────────────────────────────────────
	gemini: {
		input: "rich-textarea .ql-editor",
		// Language-agnostic: use Material icon data attributes (work across locales)
		copyButton: 'button:has(mat-icon[data-mat-icon-name="content_copy"])',
		sendButton: 'button:has(mat-icon[data-mat-icon-name="send"]), .send-button',
		sourcesSidebarButton: "button.legacy-sources-sidebar-button",
		sourcesExclude: ["gemini.google", "gstatic", "google.com/search"],
		citationButtonPattern: 'button[aria-label*="citation from"]',
		// For parsing citation aria-labels: "View source details for citation from {name}. Opens side panel."
		citationNameRegex: /from\s+(.+?)\.\s/,
	},
};
