// src/search/defaults.mjs — Shared default values and timeouts
//
// Centralizes magic numbers used across the codebase.
// Import from here instead of hardcoding values.

export const DEFAULTS = {
	CDP_TIMEOUT: 30000,             // Default CDP command timeout (ms)
	CDP_TIMEOUT_SHORT: 15000,       // Short CDP timeout for search operations (ms)
	NAV_TIMEOUT: 35000,             // Navigation timeout (ms)
	STREAM_TIMEOUT: 30000,          // Stream completion timeout (ms)
	COPY_TIMEOUT: 60000,            // Copy button appearance timeout (ms)
	CODING_TASK_TIMEOUT: 180000,    // Coding task max duration (ms)
	MAX_SOURCE_FETCH: 10,           // Max concurrent source fetches
	DESCRIPTION_MAX_LENGTH: 300,    // Max answer length in truncated mode
};