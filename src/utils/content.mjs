// src/utils/content.mjs - Content trimming utilities

/**
 * Trim large content keeping head + tail with separator
 * Better than simple truncation which loses end content (often conclusions/examples)
 * @param {string} content - Content to trim
 * @param {number} maxChars - Maximum characters to keep
 * @returns {string} - Trimmed content
 */
export function trimContentHeadTail(content, maxChars = 8000) {
	if (!content || content.length <= maxChars) {
		return content;
	}

	const marker = "\n\n[...content trimmed...]\n\n";
	const budget = maxChars - marker.length;

	// Allocate 75% to head, 25% to tail
	const headSize = Math.floor(budget * 0.75);
	const tailSize = budget - headSize;

	// Find clean break points (at newline if possible)
	let headEnd = headSize;
	while (headEnd > headSize - 100 && content[headEnd] !== "\n") {
		headEnd--;
	}
	if (headEnd <= headSize - 100) headEnd = headSize; // No newline found

	let tailStart = content.length - tailSize;
	while (
		tailStart < content.length - tailSize + 100 &&
		content[tailStart] !== "\n"
	) {
		tailStart++;
	}
	if (tailStart >= content.length - tailSize + 100)
		tailStart = content.length - tailSize;

	const head = content.slice(0, headEnd).trimEnd();
	const tail = content.slice(tailStart).trimStart();

	return `${head}${marker}${tail}`;
}

/**
 * Simple truncation (existing behavior) for when head+tail isn't appropriate
 * @param {string} content - Content to truncate
 * @param {number} maxChars - Maximum characters
 * @returns {string} - Truncated content
 */
export function truncateContent(content, maxChars = 8000) {
	if (!content || content.length <= maxChars) {
		return content;
	}
	return content.slice(0, maxChars).replace(/\s+\S*$/, "") + "...";
}
