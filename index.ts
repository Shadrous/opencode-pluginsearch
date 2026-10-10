import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { Plugin } from "@opencode/plugin"

const NPM_SEARCH_URL = "https://registry.npmjs.org/-/v1/search"
const MARKETPLACE_API =
  "https://api.github.com/repos/Tommertom/opencode-plugin-marketplace/contents/plugins"

type NpmHit = {
  package: { name: string; version: string; description?: string; date?: string; links?: { repository?: string; npm?: string } }
}

type Opt = { label: string; gist: string; install: string }

// Marketplace file listing cached under the hood (10 min TTL)
// to avoid hitting the GitHub API rate limit on every invocation.
let marketCache: { at: number; data: any[] } | null = null
const MARKET_TTL_MS = 10 * 60 * 1000

function parseVer(v: string): number[] {
  return v.replace(/^v/, "").split(/[.-]/).map((p) => parseInt(p, 10) || 0)
}

function cmpVer(a: string, b: string): number {
  const pa = parseVer(a)
  const pb = parseVer(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

function compat(current: string, min?: string, max?: string): string {
  if (min && cmpVer(current, min) < 0) return `incompatible (needs >=${min})`
  if (max && cmpVer(current, max) > 0) return `incompatible (needs <=${max})`
  if (min || max) return `compatible (${[min ? `>=${min}` : "", max ? `<=${max}` : ""].filter(Boolean).join(" ")})`
  return "compat unverified"
}

async function fetchJson(url: string, timeoutMs = 10000): Promise<any> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: "application/vnd.github+json, application/json" },
  })
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.json()
}

function queryWords(q: string): string[] {
  return q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2)
}

function matchesQuery(hay: string, query: string): boolean {
  const h = hay.toLowerCase()
  return queryWords(query).some((w) => h.includes(w))
}

async function searchNpm(query: string): Promise<NpmHit[]> {
  const url = `${NPM_SEARCH_URL}?text=${encodeURIComponent(`${query} opencode plugin`)}&size=8`
  const data = await fetchJson(url)
  const objects: any[] = data.objects ?? []
  return objects
    .filter((o) => /opencode/i.test(`${o.package?.name} ${(o.package?.keywords ?? []).join(" ")}`))
    .filter((o) =>
      matchesQuery(
        `${o.package?.name} ${o.package?.description ?? ""} ${(o.package?.keywords ?? []).join(" ")}`,
        query,
      ),
    )
    .slice(0, 6)
    .map((o) => ({ package: o.package }))
}

async function searchMarketplace(query: string, current: string, installed: Set<string>): Promise<Opt[]> {
  const q = query.toLowerCase()
  const now = Date.now()
  if (!marketCache || now - marketCache.at > MARKET_TTL_MS) {
    const listing: any[] = await fetchJson(MARKETPLACE_API)
    marketCache = { at: now, data: Array.isArray(listing) ? listing : [] }
  }
  const files = marketCache.data
    .filter((f) => f.type === "file" && f.name.endsWith(".plugin.json"))
    .filter((f) => !q || f.name.toLowerCase().includes(q.split(/\s+/)[0] ?? ""))
    .slice(0, 12)
  const out: Opt[] = []
  for (const f of files.slice(0, 5)) {
    try {
      const res = await fetch(f.download_url, { signal: AbortSignal.timeout(10000) })
      if (!res.ok) continue
      const meta = await res.json()
      const hay = `${meta.name ?? ""} ${meta.displayName ?? ""} ${meta.description ?? ""}`.toLowerCase()
      if (q && !q.split(/\s+/).some((w) => w.length > 2 && hay.includes(w))) continue
      const repo = meta.links?.repository ?? f.html_url
      const mname = `${meta.name ?? ""}`.toLowerCase()
      if (installed.has(mname) || (repo && installed.has(`${repo}`.toLowerCase()))) continue
      out.push({
        label: `${meta.displayName ?? meta.name}`,
        gist: `${meta.description ?? "no description"} (marketplace, ${compat(current, meta.opencode?.minimumVersion, meta.opencode?.maximumVersion)})`,
        install: `opencode plugin add ${repo}`,
      })
    } catch {
      // skip single-file failures
    }
  }
  return out
}

// Never feed raw Ideas back into a search: take the first line only, prefer a
// leading quoted query (repasted reports start with `"real query" ...`), and
// cap the length so a pasted blob can never blow up the prompt again.
function cleanQuery(raw: string): string {
  const first = ((raw ?? "").split("\n")[0] ?? "").trim()
  const quoted = first.match(/^["']([^"']{1,80})["']/)
  const q = (quoted ? quoted[1] : first.replace(/^["'\s]+|["'\s]+$/g, "")).trim()
  return q.slice(0, 100)
}

function resultsPath(sessionID: string): string {
  const safe = sessionID.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "session"
  return path.join(os.tmpdir(), `opencode-pluginsearch-${safe}.md`)
}

// Plugins the user already has: never shown, not even in the markdown.
async function installedTokens(ctx: { plugin: { list: (input?: any) => Promise<any> } }): Promise<Set<string>> {
  const set = new Set<string>(["pluginsearch"])
  try {
    const out: any = await ctx.plugin.list()
    const items: any[] = out?.data ?? out?.plugins ?? (Array.isArray(out) ? out : [])
    for (const p of items) {
      for (const f of [p?.id, p?.name, p?.package, p?.source]) {
        if (typeof f === "string" && f) {
          set.add(f.toLowerCase())
          const base = f.split("/").pop()
          if (base) set.add(base.toLowerCase())
        }
      }
    }
  } catch {
    // proceed without exclusion rather than failing the search
  }
  return set
}

// Our markdowns must not pile up: drop result files older than 24h.
// Same-session reruns overwrite their own file, so active sessions are unaffected.
async function sweepStaleResults(now: number): Promise<void> {
  try {
    const dir = os.tmpdir()
    const files = await fs.readdir(dir)
    const cutoff = now - 24 * 60 * 60 * 1000
    await Promise.all(
      files
        .filter((f) => f.startsWith("opencode-pluginsearch-") && f.endsWith(".md"))
        .map(async (f) => {
          try {
            const p = path.join(dir, f)
            const st = await fs.stat(p)
            if (st.mtimeMs < cutoff) await fs.unlink(p)
          } catch {
            // ignore single-file failures
          }
        }),
    )
  } catch {
    // ignore sweep failures entirely
  }
}

async function runSearch(query: string, current: string, installed: Set<string>): Promise<{ opts: Opt[]; warnings: string[] }> {  const opts: Opt[] = []
  const warnings: string[] = []
  try {
    for (const h of await searchNpm(query)) {
      if (opts.length >= 6) break
      const name = `${h.package.name}`.toLowerCase()
      const base = name.split("/").pop() ?? name
      if (installed.has(name) || installed.has(base)) continue
      opts.push({
        label: `${h.package.name}@${h.package.version}`,
        gist: `${h.package.description ?? "no description"} (npm, ${h.package.date?.slice(0, 10) ?? "?"}; compat unverified)`,
        install: `opencode plugin add ${h.package.name}@${h.package.version}`,
      })
    }
  } catch (e) {
    warnings.push(`npm search failed (${e instanceof Error ? e.message : String(e)})`)
  }
  if (opts.length < 6) {
    try {
      for (const m of await searchMarketplace(query, current, installed)) {
        if (opts.length >= 6) break
        opts.push(m)
      }
    } catch (e) {
      warnings.push(`marketplace unavailable (${e instanceof Error ? e.message : String(e)})`)
    }
  }
  return { opts, warnings }
}

export default Plugin.define({
  id: "pluginsearch",
  async setup(ctx) {
    const current = ctx.app.version ?? "unknown"

    await ctx.command.transform((editor) => {
      editor.add({
        name: "pluginsearch",
        description: "Search version-compatible OpenCode plugins from reliable sources (npm + community marketplace)",
        execute: async ({ sessionID, prompt, delivery }) => {
          const query = cleanQuery(prompt.text ?? "")
          if (!query) {
            await ctx.session.prompt({
              sessionID,
              delivery,
              files: prompt.files,
              text: "The user ran /pluginsearch without a query. Ask what kind of plugin they need, then wait. Do not search yet.",
            })
            return
          }
          await sweepStaleResults(Date.now())
          const installed = await installedTokens(ctx)
          const { opts, warnings } = await runSearch(query, current, installed)
          if (opts.length === 0) {
            await ctx.session.prompt({
              sessionID,
              delivery,
              files: prompt.files,
              text: `No OpenCode plugins found for "${query}"${warnings.length > 0 ? ` (${warnings.join("; ")})` : ""}. Suggest a broader query and stop.`,
            })
            return
          }
          const file = resultsPath(sessionID)
          await fs.writeFile(
            file,
            [
              `# pluginsearch "${query}" (${current})`,
              ``,
              ...opts.map((o, i) => `${i + 1}. ${o.label} | ${o.gist} | ${o.install}`),
              ...(warnings.length > 0 ? ["", ...warnings] : []),
              ``,
              `## Flow`,
              `- Ask with the question tool (header "Plugin search", question "Pick one to install"; option description = gist) + "none".`,
              `- A plugin pick → install it yourself right away with its exact install command via shell (approval applies). "none" → install nothing, just confirm nothing was installed.`,
              `- After installing, verify with \`opencode plugin list\`. If present: one tiny summary (what it does + the one thing needed to use it). If missing/failed: surface that instead of assuming success.`,
              `- Tell the user what THEY must do only if action on their side is actually required (e.g. service restart to activate); otherwise mention nothing.`,
              `- Free-typed answers (via "Type your own answer") are refinements, never installs: search deeply yourself (npm https://registry.npmjs.org/-/v1/search?text=<q>+opencode+plugin&size=8, keep only hits whose name/desc/keywords contain a query word; marketplace https://api.github.com/repos/Tommertom/opencode-plugin-marketplace/contents/plugins → *.plugin.json, same word rule + check opencode.minimumVersion/maximumVersion; always exclude already-installed plugins), then re-ask with the new shortlist or install the clear winner (approval applies).`,
            ].join("\n"),
            "utf8",
          )
          await ctx.session.prompt({
            sessionID,
            delivery,
            files: [...(prompt.files ?? []), { uri: pathToFileURL(file).href }],
            text: `Find OpenCode plugins for "${query}" so I can pick one (see attached options).`,
          })
        },
      })
    })
  },
})
