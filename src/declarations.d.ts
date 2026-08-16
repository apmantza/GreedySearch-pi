// Ambient declaration for the runtime .mjs modules this extension imports via
// jiti. The repo has no per-module .d.ts files; jiti does not type-check, so a
// loose `any` module shape keeps editor/LSP diagnostics from false-alarming on
// dynamic ES module imports.
declare module "*.mjs";