# Source Fetching

For `engine: "all"`, GreedySearch ranks discovered sources and fetches top source
content by default. `synthesize: true` then asks the configured synthesizer to
combine engine answers with fetched evidence.

## Supported Sources

- **PDFs** — direct PDF links are parsed into markdown text.
- **Semantic Scholar** — academic paper URLs and direct PDFs are preferred when
  the engine is used directly or opted into the fan-out.
- **Reddit** — public `.json` API for posts and comments.
- **GitHub** — REST API for repos, READMEs, file trees, and raw file content.
- **General web** — Readability extraction with browser fallback.

## Metadata

Fetched sources include the best available:

- title;
- final URL;
- status/content type;
- byline and site name;
- publish or modified date;
- language;
- excerpt/snippet;
- trimmed markdown/plain text content.

## Security

Fetchers reject private/internal URLs and re-check the final redirected URL to
avoid SSRF bypasses. GitHub and Reddit URLs use dedicated fetchers where
possible to avoid fragile page scraping.
