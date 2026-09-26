interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * OFR Short-Term Funding Monitor API — data.financialresearch.gov/v1, keyless,
 * no auth wall. The Office of Financial Research (US Treasury) publishes
 * collateral- and tenor-level US repo market data (DVP, GCF, and tri-party
 * segments) and money-market-fund balance-sheet composition, both series the
 * NY Fed's own release does not carry.
 *
 * DIFFERENT FROM `fred` and `nyfed-markets`:
 * - FRED (mcps/fred) has single daily reference rates (SOFR, EFFR...) with no
 *   collateral or tenor breakdown.
 * - nyfed-markets (mcps/nyfed-markets) has the Desk's OWN repo/RRP OPERATIONS
 *   (auctions it runs) and SOMA holdings — the Fed's OWN book.
 * - THIS pack has neither: it's OFR's independent collateral/tenor
 *   decomposition of the PRIVATE tri-party/GCF/DVP repo market (who's repo-ing
 *   what, at what rate, for how long) and money market fund investment
 *   composition (how much of MMF assets sit in repo vs Treasuries vs agencies,
 *   and with which counterparty type). No other pack in this catalog has
 *   either of these.
 *
 * PROVENANCE / TRAPS, captured live 2026-09-23:
 *
 * - Base: https://data.financialresearch.gov/v1/series/timeseries?mnemonic=X
 *   returns a bare `[[date, value], ...]` array for ONE mnemonic — this is the
 *   only live per-query route this pack uses.
 *
 * - `/v1/series/search`, `/v1/series/metadata`, `/v1/metadata/series` and
 *   `/v1/series/datasets` ALL answer 403 `{"message":"Missing Authentication
 *   Token"}` — this is API Gateway's stock response for a route that does not
 *   exist, not an auth requirement on a route that does. There is no public
 *   discovery endpoint. `/v1/series/dataset?dataset=repo` (or `mmf`) DOES work
 *   and returns every mnemonic's name/description/schedule in one ~9MB blob —
 *   too large to fetch per call in a Worker, and would be a bulk mirror of the
 *   METADATA (not the data) if baked in wholesale. Instead this pack ships
 *   `catalog.ts`, a name+mnemonic+start_date table generated from ONE such
 *   pull (2026-09-23) — see that file's header. The actual numbers are never
 *   pulled from that bulk endpoint; every value returned by this pack's tools
 *   comes from a live per-mnemonic `timeseries` call made during the request.
 *
 * - Mnemonic grammar (repo dataset): `REPO-{COLLATERAL}_{MEASURE}_{TENOR}-{VINTAGE}`.
 *     COLLATERAL: DVP | GCF | TRI | TRIV1 (TRIV1 = tri-party excluding Fed's
 *       own reverse-repo counterparty trades)
 *     MEASURE:    AR (volume-weighted average rate, %) | TV (transaction
 *       volume, $) | OV (outstanding volume, $)
 *     TENOR:      OO (overnight/open) | B27 (2-7d) | B830 (8-30d) | LE30
 *       (<=30d) | G30 (>30d) | TOT (total) | T (Treasury collateral only) |
 *       AG (agency collateral only) | CORD (corporate debt collateral, TRI
 *       only) | O (other collateral, TRI only)
 *     VINTAGE:    P (preliminary) | F (final, usually a few days later)
 *   NOT every combination exists (e.g. DVP has no T/AG/CORD/O collateral
 *   split). An invalid combination 400s upstream with body "Invalid
 *   mnemonic" — this pack passes that straight through with the mnemonic it
 *   tried, rather than guessing at validity client-side.
 */

import { OFR_SERIES_CATALOG, type OfrSeriesInfo } from './catalog.js';

const UA = 'pipeworx-mcp/1.0 (+https://pipeworx.io)';
const BASE = 'https://data.financialresearch.gov/v1';

type Observation = [string, number | null];

async function fetchSeries(mnemonic: string): Promise<Observation[]> {
  const res = await fetchWithTimeout(
    `${BASE}/series/timeseries?mnemonic=${encodeURIComponent(mnemonic)}`,
    { headers: { 'User-Agent': UA } },
    'OFR Short-Term Funding Monitor',
  );
  if (!res.ok) {
    if (res.status === 400) {
      throw new Error(
        `OFR rejected mnemonic "${mnemonic}" as invalid (that collateral/measure/tenor combination does not exist). ` +
          'Call ofr_search_funding_series to browse valid mnemonics.',
      );
    }
    throw await httpError(res, 'OFR Short-Term Funding Monitor');
  }
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) throw new Error('upstream_down: OFR timeseries endpoint returned an unexpected shape.');
  return data as Observation[];
}

function clamp(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function checkDate(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v);
  if (!DATE_RE.test(s)) throw new Error(`${field} must be YYYY-MM-DD, got "${s}".`);
  return s;
}

function catalogEntry(mnemonic: string): OfrSeriesInfo | undefined {
  return OFR_SERIES_CATALOG.find((r) => r.mnemonic === mnemonic);
}

// ---------------------------------------------------------------------------
// 1. Repo rates & volumes by collateral + tenor
// ---------------------------------------------------------------------------

const COLLATERAL_MAP: Record<string, string> = {
  dvp: 'DVP',
  gcf: 'GCF',
  tri: 'TRI',
  tri_ex_fed: 'TRIV1',
};
const TENOR_MAP: Record<string, string> = {
  overnight: 'OO',
  term_2_7d: 'B27',
  term_8_30d: 'B830',
  term_le_30d: 'LE30',
  term_over_30d: 'G30',
  total: 'TOT',
  treasury: 'T',
  agency: 'AG',
  corporate: 'CORD',
  other: 'O',
};
const MEASURE_MAP: Record<string, string> = { rate: 'AR', volume: 'TV', outstanding: 'OV' };

function buildRepoMnemonic(args: Record<string, unknown>): string {
  const collateralKey = String(args.collateral ?? 'tri').toLowerCase();
  const tenorKey = String(args.tenor ?? 'overnight').toLowerCase();
  const measureKey = String(args.measure ?? 'rate').toLowerCase();
  const vintage = String(args.vintage ?? 'preliminary').toLowerCase();

  const collateral = COLLATERAL_MAP[collateralKey];
  if (!collateral) throw new Error(`collateral must be one of: ${Object.keys(COLLATERAL_MAP).join(', ')}.`);
  const tenor = TENOR_MAP[tenorKey];
  if (!tenor) throw new Error(`tenor must be one of: ${Object.keys(TENOR_MAP).join(', ')}.`);
  const measure = MEASURE_MAP[measureKey];
  if (!measure) throw new Error(`measure must be one of: ${Object.keys(MEASURE_MAP).join(', ')}.`);
  if (!['preliminary', 'final'].includes(vintage)) throw new Error('vintage must be one of: preliminary, final.');
  const vintageCode = vintage === 'preliminary' ? 'P' : 'F';

  return `REPO-${collateral}_${measure}_${tenor}-${vintageCode}`;
}

function trimWindow(obs: Observation[], startDate?: string, endDate?: string): Observation[] {
  if (!startDate && !endDate) return obs;
  return obs.filter(([d]) => (!startDate || d >= startDate) && (!endDate || d <= endDate));
}

async function ofrRepoRates(args: Record<string, unknown>) {
  const mnemonic = buildRepoMnemonic(args);
  const startDate = checkDate(args.start_date, 'start_date');
  const endDate = checkDate(args.end_date, 'end_date');
  const limit = clamp(args.limit, 30, 1, 250);

  const series = await fetchSeries(mnemonic);
  const windowed = trimWindow(series, startDate, endDate);
  const nonNullTail = windowed.slice(-limit);
  const info = catalogEntry(mnemonic);
  const latest = [...windowed].reverse().find(([, v]) => v !== null);

  if (windowed.length === 0) {
    return {
      found: false,
      reason: 'no_observations_in_window',
      mnemonic,
      hint: startDate || endDate ? `No observations for "${mnemonic}" between ${startDate ?? 'the start'} and ${endDate ?? 'today'}.` : `Series "${mnemonic}" has no observations at all — this would be unusual; check the mnemonic.`,
    };
  }

  return {
    found: true,
    mnemonic,
    name: info?.name,
    latest_date: latest?.[0],
    latest_value: latest?.[1],
    unit: MEASURE_MAP[String(args.measure ?? 'rate').toLowerCase()] === 'AR' ? 'percent' : 'USD',
    total_observations: windowed.length,
    returned: nonNullTail.length,
    observations: nonNullTail.map(([date, value]) => ({ date, value })),
    source: `OFR Short-Term Funding Monitor — U.S. Repo Markets Data Release (financialresearch.gov/short-term-funding-monitor/datasets/repo).`,
  };
}

// ---------------------------------------------------------------------------
// 2. MMF holdings
// ---------------------------------------------------------------------------

const MMF_CATEGORY_MAP: Record<string, string> = {
  total: 'MMF-MMF_TOT-M',
  repo_total: 'MMF-MMF_RP_TOT-M',
  repo_overnight: 'MMF-MMF_RP_OO-M',
  repo_term_le_30d: 'MMF-MMF_RP_LE30-M',
  repo_term_over_30d: 'MMF-MMF_RP_G30-M',
  repo_treasury_total: 'MMF-MMF_RP_T_TOT-M',
  repo_treasury_overnight: 'MMF-MMF_RP_T_OO-M',
  repo_agency_total: 'MMF-MMF_RP_AG_TOT-M',
  repo_agency_overnight: 'MMF-MMF_RP_AG_OO-M',
  repo_other_collateral_total: 'MMF-MMF_RP_OA_TOT-M',
  repo_with_domestic_institutions: 'MMF-MMF_RP_wDFI-M',
  repo_with_foreign_institutions: 'MMF-MMF_RP_wFFI-M',
  repo_with_fed: 'MMF-MMF_RP_wFR-M',
  repo_cleared_by_ficc: 'MMF-MMF_RP_wFICC-M',
  repo_with_other_counterparties: 'MMF-MMF_RP_wOCP-M',
  treasury_securities: 'MMF-MMF_T_TOT-M',
  agency_securities: 'MMF-MMF_AG_TOT-M',
  bank_related_assets: 'MMF-MMF_BRA_TOT-M',
  other_assets: 'MMF-MMF_OA_TOT-M',
  median_yield_repo_overnight: 'MMF-MY_MMF_RP_OO-M',
  median_yield_repo_treasury_overnight: 'MMF-MY_MMF_RP_T_OO-M',
};

async function ofrMmfHoldings(args: Record<string, unknown>) {
  const categoryKey = String(args.category ?? 'repo_total').toLowerCase();
  const mnemonic = MMF_CATEGORY_MAP[categoryKey];
  if (!mnemonic) {
    throw new Error(`category must be one of: ${Object.keys(MMF_CATEGORY_MAP).join(', ')}. Call ofr_search_funding_series with dataset:"mmf" for the full list of 42 underlying series.`);
  }
  const startDate = checkDate(args.start_date, 'start_date');
  const endDate = checkDate(args.end_date, 'end_date');
  const limit = clamp(args.limit, 24, 1, 200);

  const series = await fetchSeries(mnemonic);
  const windowed = trimWindow(series, startDate, endDate);
  const tail = windowed.slice(-limit);
  const info = catalogEntry(mnemonic);
  const latest = [...windowed].reverse().find(([, v]) => v !== null);

  if (windowed.length === 0) {
    return { found: false, reason: 'no_observations_in_window', category: categoryKey, mnemonic };
  }

  return {
    found: true,
    category: categoryKey,
    mnemonic,
    name: info?.name,
    unit: categoryKey.startsWith('median_yield') ? 'percent' : 'USD',
    frequency: 'Monthly',
    latest_date: latest?.[0],
    latest_value: latest?.[1],
    total_observations: windowed.length,
    returned: tail.length,
    observations: tail.map(([date, value]) => ({ date, value })),
    source: 'OFR Short-Term Funding Monitor — U.S. Money Market Funds Data Release (financialresearch.gov/short-term-funding-monitor/datasets/mmf).',
  };
}

// ---------------------------------------------------------------------------
// 3. Series discovery
// ---------------------------------------------------------------------------

async function ofrSearchFundingSeries(args: Record<string, unknown>) {
  const query = args.query ? String(args.query).trim().toLowerCase() : undefined;
  const dataset = args.dataset ? String(args.dataset).toLowerCase() : 'all';
  if (!['repo', 'mmf', 'all'].includes(dataset)) throw new Error('dataset must be one of: repo, mmf, all.');
  const limit = clamp(args.limit, 30, 1, 206);

  let rows = OFR_SERIES_CATALOG;
  if (dataset !== 'all') rows = rows.filter((r) => r.dataset === dataset);
  if (query) rows = rows.filter((r) => r.name.toLowerCase().includes(query) || r.mnemonic.toLowerCase().includes(query));

  const total = rows.length;
  if (total === 0) {
    return {
      found: false,
      reason: 'no_matches',
      hint: `No series matched "${query ?? ''}" in dataset "${dataset}". Try a broader term like "treasury", "overnight", "tri-party", or "money market".`,
    };
  }
  return {
    found: true,
    query,
    dataset,
    total_matching: total,
    returned: Math.min(limit, total),
    series: rows.slice(0, limit),
    note: 'This is a static catalog of mnemonic names/start dates (OFR publishes no live search endpoint — /v1/series/search 403s). Use ofr_repo_rates (collateral/tenor/measure) or ofr_mmf_holdings (category) for the friendly interface, or pass any mnemonic here to ofr_funding_anomaly directly.',
    source: 'OFR Short-Term Funding Monitor — series catalog (financialresearch.gov/short-term-funding-monitor).',
  };
}

// ---------------------------------------------------------------------------
// 4. Anomaly detector
// ---------------------------------------------------------------------------

async function ofrFundingAnomaly(args: Record<string, unknown>) {
  const mnemonic = args.mnemonic ? String(args.mnemonic).trim() : buildRepoMnemonic(args);
  const windowDays = clamp(args.window_days, 20, 5, 120);

  const series = (await fetchSeries(mnemonic)).filter(([, v]) => v !== null) as Array<[string, number]>;
  if (series.length < 2) {
    return { found: false, reason: 'insufficient_observations', mnemonic, total_observations: series.length };
  }

  const latest = series[series.length - 1];
  const windowObs = series.slice(-(windowDays + 1), -1); // trailing window, EXCLUDING the latest point
  if (windowObs.length === 0) {
    return {
      found: false,
      reason: 'insufficient_window',
      mnemonic,
      hint: `Series only has ${series.length} observation(s) — not enough to build a trailing window before the latest one.`,
    };
  }

  const values = windowObs.map(([, v]) => v);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  const stddev = Math.sqrt(variance);
  const delta = latest[1] - mean;
  const zScore = stddev > 0 ? delta / stddev : null;

  const info = catalogEntry(mnemonic);
  return {
    found: true,
    mnemonic,
    name: info?.name,
    latest_date: latest[0],
    latest_value: latest[1],
    window: {
      start_date: windowObs[0][0],
      end_date: windowObs[windowObs.length - 1][0],
      n_observations: windowObs.length,
      mean,
      stddev,
    },
    delta,
    z_score: zScore,
    z_score_note: stddev === 0 ? 'stddev is 0 over this window (a flat series) — z_score is not defined; use delta instead.' : `|z_score| > 2 is an unusual move relative to the trailing ${windowObs.length} observations.`,
    source: 'OFR Short-Term Funding Monitor — computed by this pack from live timeseries data, not an OFR-published statistic.',
  };
}

// ---------------------------------------------------------------------------

const tools: McpToolExport['tools'] = [
  {
    name: 'ofr_repo_rates',
    description:
      'US repo market rates/volumes broken out by COLLATERAL segment (dvp = FICC DVP service, gcf = GCF Repo service, tri = tri-party, tri_ex_fed = tri-party excluding the Fed\'s own ON RRP counterparty trades) and TENOR (overnight, term buckets, or a treasury/agency/corporate/other collateral-type split). measure=rate (default, %) or volume/outstanding ($). This is OFR\'s independent collateral/tenor decomposition of the private repo market — neither FRED nor nyfed-markets has this breakdown; FRED only has single daily SOFR/EFFR-style aggregates, and nyfed-markets only has the NY Fed Desk\'s OWN operations, not the broader market. Not every collateral/tenor/measure combination exists (upstream 400s "Invalid mnemonic" on an invalid one — try ofr_search_funding_series to browse what does).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        collateral: { type: 'string', enum: ['dvp', 'gcf', 'tri', 'tri_ex_fed'], description: 'Default tri (tri-party, the largest and most-watched segment).' },
        tenor: { type: 'string', enum: ['overnight', 'term_2_7d', 'term_8_30d', 'term_le_30d', 'term_over_30d', 'total', 'treasury', 'agency', 'corporate', 'other'], description: 'Default overnight. treasury/agency/corporate/other are collateral-TYPE splits, not term buckets, and are only valid for some collateral segments.' },
        measure: { type: 'string', enum: ['rate', 'volume', 'outstanding'], description: 'rate = volume-weighted average rate (%). volume = transaction volume ($). outstanding = outstanding volume ($, not available for every segment). Default rate.' },
        vintage: { type: 'string', enum: ['preliminary', 'final'], description: 'OFR revises rates a few days after first publication. Default preliminary (freshest).' },
        start_date: { type: 'string', description: 'YYYY-MM-DD, inclusive.' },
        end_date: { type: 'string', description: 'YYYY-MM-DD, inclusive.' },
        limit: { type: 'number', description: 'Max observations to return, most recent last. Default 30, max 250.' },
      },
    },
  },
  {
    name: 'ofr_mmf_holdings',
    description:
      "Money market mutual fund investment composition, monthly, from OFR's MMF Data Release — how much of aggregate MMF assets sit in repo (overall, or split by Treasury/agency/other collateral and by counterparty type: domestic institutions, foreign institutions, the Fed, FICC-cleared, other), plus outright Treasury/agency securities, bank-related assets, and other assets. Distinct from any credit-rating or fund-flow data — this is balance-sheet COMPOSITION. category defaults to repo_total; call ofr_search_funding_series with dataset:\"mmf\" to see all 42 underlying series (including median-yield variants).",
    inputSchema: {
      type: 'object' as const,
      properties: {
        category: {
          type: 'string',
          enum: [
            'total', 'repo_total', 'repo_overnight', 'repo_term_le_30d', 'repo_term_over_30d',
            'repo_treasury_total', 'repo_treasury_overnight', 'repo_agency_total', 'repo_agency_overnight',
            'repo_other_collateral_total', 'repo_with_domestic_institutions', 'repo_with_foreign_institutions',
            'repo_with_fed', 'repo_cleared_by_ficc', 'repo_with_other_counterparties',
            'treasury_securities', 'agency_securities', 'bank_related_assets', 'other_assets',
            'median_yield_repo_overnight', 'median_yield_repo_treasury_overnight',
          ],
          description: 'Default repo_total.',
        },
        start_date: { type: 'string', description: 'YYYY-MM-DD, inclusive.' },
        end_date: { type: 'string', description: 'YYYY-MM-DD, inclusive.' },
        limit: { type: 'number', description: 'Max monthly observations to return. Default 24, max 200.' },
      },
    },
  },
  {
    name: 'ofr_search_funding_series',
    description:
      'Browse the full catalog of OFR repo-market and money-market-fund mnemonics by name (e.g. "tri-party", "GCF", "corporate debt", "federal reserve") — use this to find the exact series behind ofr_repo_rates/ofr_mmf_holdings, or a raw mnemonic to pass to ofr_funding_anomaly. OFR publishes no live search API, so this is a name/mnemonic lookup table, not a live call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Substring to match against the series name or mnemonic (case-insensitive). Omit to list everything in the chosen dataset.' },
        dataset: { type: 'string', enum: ['repo', 'mmf', 'all'], description: 'Default all.' },
        limit: { type: 'number', description: 'Default 30, max 206 (the full catalog).' },
      },
    },
  },
  {
    name: 'ofr_funding_anomaly',
    description:
      'Compares the LATEST observation of a repo or MMF series to its trailing window (mean, stddev over the N observations before it) and reports the delta and z-score — "what changed unusually" in short-term funding markets. Pass either the same collateral/tenor/measure/vintage args as ofr_repo_rates (default: tri-party overnight rate), or a raw mnemonic from ofr_search_funding_series/ofr_mmf_holdings. Always states the exact window used (start date, end date, n observations) alongside the number.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mnemonic: { type: 'string', description: 'A raw OFR mnemonic (e.g. from ofr_search_funding_series). Overrides collateral/tenor/measure/vintage when given.' },
        collateral: { type: 'string', enum: ['dvp', 'gcf', 'tri', 'tri_ex_fed'], description: 'Used only when mnemonic is omitted. Default tri.' },
        tenor: { type: 'string', enum: ['overnight', 'term_2_7d', 'term_8_30d', 'term_le_30d', 'term_over_30d', 'total', 'treasury', 'agency', 'corporate', 'other'], description: 'Used only when mnemonic is omitted. Default overnight.' },
        measure: { type: 'string', enum: ['rate', 'volume', 'outstanding'], description: 'Used only when mnemonic is omitted. Default rate.' },
        vintage: { type: 'string', enum: ['preliminary', 'final'], description: 'Used only when mnemonic is omitted. Default preliminary.' },
        window_days: { type: 'number', description: 'Trailing window size (observations before the latest one). Default 20, min 5, max 120.' },
      },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'ofr_repo_rates':
      return ofrRepoRates(args);
    case 'ofr_mmf_holdings':
      return ofrMmfHoldings(args);
    case 'ofr_search_funding_series':
      return ofrSearchFundingSeries(args);
    case 'ofr_funding_anomaly':
      return ofrFundingAnomaly(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool } satisfies McpToolExport;
