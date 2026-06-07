// src/search/pdf.mjs — PDF text extraction helpers
//
// Adapted from pi-webaio's PDF pipeline. `pdf-parse` is loaded lazily so the
// package remains importable even when optional native canvas bindings are not
// available. PDF extraction is only attempted for actual PDF source fetches.

function ensurePdfDomPolyfills() {
	if (typeof globalThis.DOMMatrix === "undefined") {
		globalThis.DOMMatrix = class DOMMatrix {
			constructor(_init = undefined) {}
			multiplySelf() {
				return this;
			}
			preMultiplySelf() {
				return this;
			}
			translateSelf() {
				return this;
			}
			scaleSelf() {
				return this;
			}
			rotateSelf() {
				return this;
			}
		};
	}
	if (typeof globalThis.ImageData === "undefined") {
		globalThis.ImageData = class ImageData {
			constructor(data = undefined, width = 0, height = 0) {
				this.data = data;
				this.width = width;
				this.height = height;
			}
		};
	}
	if (typeof globalThis.Path2D === "undefined") {
		globalThis.Path2D = class Path2D {
			constructor(_path = undefined) {}
		};
	}
}

async function loadPdfParseCtor() {
	ensurePdfDomPolyfills();
	const mod = await import("pdf-parse");
	const ctor = mod.PDFParse ?? mod.default;
	if (!ctor) throw new Error("pdf-parse did not export PDFParse");
	return ctor;
}

export async function extractPdfMarkdown(buffer, url) {
	try {
		const PDFParseCtor = await loadPdfParseCtor();
		const parser = new PDFParseCtor({ data: new Uint8Array(buffer) });
		await parser.load();
		const data = await parser.getText();
		const text = data.text?.trim();
		if (!text) return null;
		return {
			title: new URL(url).pathname.split("/").pop() || "Document.pdf",
			content: `## PDF Content (${data.total} pages)\n\n${text}`,
			pages: data.total,
		};
	} catch (error) {
		return { error: error.message || String(error) };
	}
}
