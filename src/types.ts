/**
 * TypeScript interfaces for GreedySearch data structures
 *
 * These types document the shape of data flowing between modules.
 * They can be imported by TypeScript files (index.ts, tool handlers, formatters)
 * and used for type safety without runtime overhead.
 */

// ============================================================================
// Search Result Types
// ============================================================================

/** A single source extracted from search results */
export interface Source {
	url: string;
	title: string;
	type?: "official-docs" | "maintainer-blog" | "repo" | "community" | "website";
	domain?: string;
	snippet?: string;
}

/** Result from a single search engine */
export interface SearchResult {
	engine: string;
	answer: string;
	sources: Source[];
	url?: string;
	query?: string;
	error?: string;
}

/** Synthesis result combining multiple engine results */
export interface SynthesisResult {
	answer: string;
	agreementLevel?: "consensus" | "majority" | "mixed" | "conflicting";
	claims?: Claim[];
	sourceIds?: string[];
	confidence?: ConfidenceMetrics;
}

/** A single claim within a synthesis */
export interface Claim {
	text: string;
	sourceIds: string[];
	confidence?: "high" | "medium" | "low";
}

/** Confidence metrics for a synthesis */
export interface ConfidenceMetrics {
	overall: number;        // 0-1
	consensus: number;      // fraction of engines agreeing
	sourceCount: number;
	engineCount: number;
}

// ============================================================================
// Source Registry Types
// ============================================================================

/** A classified source in the registry */
export interface ClassifiedSource extends Source {
	engineOrigin: string[];
	isOfficial: boolean;
	consensus: number;  // fraction of engines citing this source
}

// ============================================================================
// Tool Result Types
// ============================================================================

/** Progress update sent via onUpdate during long-running searches */
export interface ProgressUpdate {
	content: Array<{ type: "text"; text: string }>;
	details: { _progress: true };
}

/** Pi tool result format */
export interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

// ============================================================================
// Engine Configuration Types
// ============================================================================

/** Engine definition for the ENGINES map */
export interface EngineConfig {
	/** Extractor script filename (e.g. "perplexity.mjs") */
	script: string;
	/** Human-readable label for progress messages */
	label: string;
	/** Domain pattern for source matching */
	domain: string;
	/** URL pattern for the engine */
	url: string;
}

// ============================================================================
// Constants
// ============================================================================

// Runtime defaults are in src/search/defaults.mjs (since .ts files can't be
// imported directly by Node.js). Import DEFAULTS from there for runtime values.