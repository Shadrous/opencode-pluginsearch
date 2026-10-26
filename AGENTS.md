# AGENTS.md — opencode-pluginsearch

Build/test: `package.json` defines no scripts — do not invent `npm test` / `npm run build`.
Verify with: `bun install` (Bun >= 1.0.0) + live `/pluginsearch <query>` smoke test in OpenCode, then `opencode plugin list`.

Arch boundaries (single-file plugin, `index.ts` only):
- Sources: npm registry search + community marketplace (`*.plugin.json`, version-range compat flags). No new tools — zero tool footprint by design.
- Flow: `/pluginsearch` → result md in OS tmpdir (24h sweep) → question-tool picker → `opencode plugin add` → verify with `plugin list`.
- Never show already-installed plugins; free-typed answers are refinements, never installs.
