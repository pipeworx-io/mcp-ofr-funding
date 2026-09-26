# @pipeworx/ofr-funding

The Office of Financial Research (US Treasury) Short-Term Funding Monitor API — collateral- and tenor-level US repo market rates/volumes (DVP, GCF, tri-party) and money-market-fund balance-sheet composition, neither of which FRED or the NY Fed Desk's own release carries.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1683+ live data sources.

## Tools

- `ofr_repo_rates(collateral, tenor, measure, vintage, start_date, end_date, limit)` — repo rates or volumes for one collateral segment (dvp/gcf/tri/tri_ex_fed) x tenor (overnight/term bucket/collateral-type split) x measure (rate/volume/outstanding).
- `ofr_mmf_holdings(category, start_date, end_date, limit)` — monthly money-market-fund investment composition (repo by collateral/counterparty type, outright Treasuries/agencies, bank-related assets).
- `ofr_search_funding_series(query, dataset, limit)` — name/mnemonic lookup across the full 206-series repo+mmf catalog (OFR has no live search endpoint).
- `ofr_funding_anomaly(mnemonic OR collateral/tenor/measure/vintage, window_days)` — compares the latest observation to a trailing window and reports delta + z-score, stating the exact window used.

## Auth

Keyless. No registration, no API key, no rate-limit headers observed.

## Data sources

- `https://data.financialresearch.gov/v1/series/timeseries?mnemonic=...` — the only live per-query route. Returns a bare `[[date, value], ...]` array for one mnemonic. Used by all four tools for every actual data point returned.
- `https://data.financialresearch.gov/v1/series/dataset?dataset=repo` and `?dataset=mmf` — bulk metadata+data dump (~9MB gzip'd, ~450KB for mmf) used ONCE (2026-09-23) to generate `src/catalog.ts` (mnemonic → human name → start date → frequency). Never called at request time; too large to fetch per call in a Worker, and would be a bulk mirror if it were. The actual VALUES this pack returns always come from the `timeseries` endpoint above, live, per request.
- `https://www.financialresearch.gov/short-term-funding-monitor/` — the human-facing site these APIs back.

### Traps

- **`/v1/series/search`, `/v1/series/metadata`, `/v1/metadata/series`, `/v1/series/datasets` all answer `403 {"message":"Missing Authentication Token"}`.** This is API Gateway's stock response for an undefined route, not an actual auth requirement — there is no public discovery/search endpoint at all. That's why `ofr_search_funding_series` exists as a static, generated lookup table instead of a live search call.
- **Mnemonic grammar**: `REPO-{COLLATERAL}_{MEASURE}_{TENOR}-{VINTAGE}` for repo, `MMF-{...}-M` for MMF. Not every collateral/tenor/measure combination exists — e.g. DVP has no Treasury/Agency/Corporate collateral-type split, only GCF/TRI do. An invalid combination 400s upstream with body `Invalid mnemonic`; `ofr_repo_rates` surfaces that with a pointer to `ofr_search_funding_series` rather than guessing validity client-side.
- **Vintage matters**: OFR publishes a `preliminary` value first and a `final` revision a few days later, as a SEPARATE mnemonic suffix (`-P` vs `-F`), not an in-place update. Defaulting to preliminary gets you the freshest number; final is more accurate for anything more than a few days old.
- **Reporting lag**: the latest repo-rate observation is typically 1-2 calendar days behind today (e.g. probed 2026-09-23, latest tri-party overnight rate was dated 2026-09-21) — this is normal publication lag, not an outage.
- **`ofr_funding_anomaly`'s z-score is computed by this pack**, not an OFR-published statistic — it excludes the latest point from its own trailing window so the window and the point being judged never overlap.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "ofr-funding": {
      "url": "https://gateway.pipeworx.io/ofr-funding/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/ofr-funding/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1683+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ofr_repo_rates \
  -H 'Content-Type: application/json' \
  -d '{"collateral":"tri","tenor":"overnight","measure":"rate"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ofr_repo_rates`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "ofr-funding": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-ofr-funding"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-ofr-funding
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Ofr Funding data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
