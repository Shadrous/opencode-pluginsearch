# opencode-pluginsearch

A `/pluginsearch` command for [OpenCode](https://opencode.ai) that finds
version-compatible plugins from reliable sources and lets you pick one
from a popup — then installs it for you.

```text
/pluginsearch orchestration
```

## How it works

1. You run `/pluginsearch <query>`. The plugin searches two sources in
   one parallel pass:
   - **npm registry** — official, installable packages.
   - **Community marketplace** (`Tommertom/opencode-plugin-marketplace`,
     schema-validated) — used for declared `minimumVersion` /
     `maximumVersion` compatibility flags.
2. Results arrive as a file attachment plus a one-line prompt — the chat
   stays clean, no wall of text.
3. The agent shows the options in a picker (gists included) with `none`.
   Anything you type instead is treated as a refinement: the agent
   searches deeper itself and re-asks.
4. Picking a plugin installs it right away (`opencode plugin add …`,
   approval applies), verifies with `opencode plugin list`, and gives a
   tiny usage summary. `none` installs nothing.

Details worth knowing:

- **Relevance first.** A hit must contain a query word in its
  name/description/keywords — popularity alone doesn't qualify.
- **No duplicates.** Already-installed plugins are excluded before
  results are even written.
- **No trash.** Result files are per-session (reruns overwrite) with a
  24h cleanup sweep.
- **No footprint.** No background tool; the plugin only acts when the
  command runs.

## Install

```sh
opencode plugin add github:Shadrous/opencode-pluginsearch
```

Then restart the OpenCode service (or reload the session) and run
`/pluginsearch <query>`.

## Requirements

- OpenCode V2 (`@opencode/plugin` v2)
- Bun >= 1.0.0 (for local development)

## Notes

- The community marketplace is an independent project, not affiliated
  with OpenCode. Marketplace entries should be verified before install.
- Results flagged `compat unverified` declare no version range; check
  the package README when in doubt.

## License

MIT
