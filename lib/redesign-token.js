// Phase 4D.26 -- App Proxy redesign-token identity bridge.
//
// Purpose: lets api/proxy/redesign-token.js mint a short-lived,
// single-use, cryptographically signed token bound to exactly one
// customerId (a value the route must have already established via a
// verified Shopify App Proxy signature -- see lib/verify-shopify-proxy.js).
// A future phase (4D.27) will have /api/redesign accept and consume this
// token INSTEAD of trusting a browser-supplied customerId + the legacy
// issuedAt/token HMAC construction. This phase does NOT wire /api/redesign
// to consume tokens yet -- api/redesign.js is completely untouched. Mint
// and consume are both implemented and tested now specifically so the
// single-use property can be proven ahead of that cutover, per the
// project's standing "verify, don't assume" practice.
//
// -- Why a custom compact HMAC token, not a JWT library --
// No JWT package is installed in this project (package.json lists only
// @vercel/blob and @vercel/kv as dependencies), and the payload here is
// tiny and fixed-shape (customerId, two timestamps, a nonce). Adding a new
// dependency for this would be pure overhead for no real gain. The format
// is the simplest thing that gives the required properties:
//   base64url(JSON payload) + "." + hex HMAC-SHA256 signature
//
// -- Why a signed token alone is NOT enough -- single-use enforcement --
// A signed token proves authenticity and lets expiry be checked, but by
// itself is replayable any number of times until it expires. The
// architecture requires single-use, so every token carries a unique
// `nonce` (crypto.randomUUID()), and consumeRedesignToken() atomically
// claims that nonce with a single real Redis command:
//   SET redesign:token-used:{nonce} 1 NX EX <ttl>
// This was freshly verified against the actual installed client's source
// (not assumed from docs): @upstash/redis's SetCommand
// (packages/redis/pkg/commands/set.ts) maps `{ nx: true, ex: <n> }`
// directly onto `SET key value NX EX <n>` -- one real, atomic Redis
// command, not a GET-then-SET pair. SET NX returns null when the key
// already exists, so a replay of the same token is correctly rejected;
// there is no window between "check" and "claim" for two concurrent
// consumes of the same token to both succeed.
//
// -- Verification order, and why it matters --
// consumeRedesignToken() always verifies the signature, THEN checks
// expiry/shape, and only THEN attempts the atomic KV claim. A malformed or
// already-expired token never touches KV at all: there is nothing to clean
// up afterward, and there is no way to cheaply generate KV writes just by
// sending garbage tokens.
//
// -- Secrets --
// Signed with ROOM_DESIGNER_REDESIGN_TOKEN_SECRET -- a NEW, DEDICATED env
// var. Never SHOPIFY_STUDIO_PROXY_CLIENT_SECRET (that verifies a
// completely different signature, Shopify's own, over the App Proxy
// request), never CUSTOMER_TOKEN_SECRET (the legacy theme-HMAC secret this
// token is meant to eventually replace), never OPENAI_API_KEY. If
// ROOM_DESIGNER_REDESIGN_TOKEN_SECRET is not configured, every mint/verify
// call throws/fails closed -- the route catches that and returns a generic
// 500, and never describes the missing-secret condition to the storefront.
//
// -- What this file deliberately does NOT do --
// It does not verify the Shopify App Proxy signature (that responsibility
// stays entirely in lib/verify-shopify-proxy.js -- this file never reads
// req.query or knows anything about App Proxy canonicalization), and it
// does not decide entitlement, credits, or usage -- this is authentication
// (who is this) only, never authorization (what are they allowed to do).

const crypto = require('crypto');
const { kv } = require('@vercel/kv');

const SECRET_ENV_VAR = 'ROOM_DESIGNER_REDESIGN_TOKEN_SECRET';

// Lifetime: within the spec's recommended 60-120s window. Short on purpose
// -- this token exists only to bridge one App-Proxy-verified page load to
// one imminent /api/redesign call, not to act as a session token.
const TOKEN_TTL_SECONDS = 90;

// How far into the future a token's `issuedAt` is still tolerated, to
// absorb ordinary clock drift without opening a meaningful forward-dating
// window. Deliberately its own small constant, unrelated to
// lib/verify-shopify-proxy.js's CLOCK_SKEW_SECONDS -- these are two
// unrelated signatures over two unrelated payloads, minted/verified by two
// independent mechanisms; conflating their skew tolerances would be a
// coincidence, not a design decision.
const MAX_FUTURE_SKEW_SECONDS = 5;

// Single-use claim record TTL: a token can only ever be validly presented
// within its own TOKEN_TTL_SECONDS window (an expired token is rejected by
// verifyRedesignToken before the KV claim is ever attempted), so the claim
// record only needs to outlive that plus a small safety margin. This is
// NOT a long-lived audit record the way the reservation ledger's resolved
// records are -- it exists purely to block replay for as long as replay is
// even theoretically possible.
const CONSUME_RECORD_TTL_SECONDS = TOKEN_TTL_SECONDS + 30;

// Matches the stricter customerId validation used elsewhere in this
// project (api/usage.js, api/redesign.js) -- a bounded digit string, not
// merely "all digits" (lib/verify-shopify-proxy.js's own check is looser,
// but this file re-validates independently rather than trusting that
// looser check transitively).
const CUSTOMER_ID_PATTERN = /^[0-9]{1,30}$/;

function getSecret() {
  const secret = process.env[SECRET_ENV_VAR];
  if (!secret) {
    throw new Error(`${SECRET_ENV_VAR} is not configured`);
  }
  return secret;
}

function base64urlEncode(str) {
  return Buffer.from(str, 'utf8').toString('base64url');
}
function base64urlDecode(str) {
  return Buffer.from(str, 'base64url').toString('utf8');
}

function sign(payloadB64, secret) {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('hex');
}

function consumeKey(nonce) {
  return `redesign:token-used:${nonce}`;
}

// Mint a fresh, single-use redesign token bound to `customerId`.
//
// `customerId` MUST already be a trusted value: the caller (the App Proxy
// route) must have obtained it from a verified Shopify signature, never
// from a browser-supplied query/body parameter -- this function does not
// re-verify WHO the customer is, only that the string is a syntactically
// valid Shopify numeric customer id, and signs it into the token.
//
// Throws if ROOM_DESIGNER_REDESIGN_TOKEN_SECRET is not configured or
// customerId doesn't match CUSTOMER_ID_PATTERN -- both are caller/config
// bugs, not end-user input errors, so the route turns either into a
// generic 500 rather than trying to describe them to the storefront.
function mintRedesignToken(customerId) {
  const secret = getSecret();
  if (!CUSTOMER_ID_PATTERN.test(String(customerId))) {
    throw new Error('mintRedesignToken: invalid customerId');
  }
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    customerId: String(customerId),
    issuedAt: now,
    expiresAt: now + TOKEN_TTL_SECONDS,
    nonce: crypto.randomUUID(),
  };
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const signature = sign(payloadB64, secret);
  return { token: `${payloadB64}.${signature}`, expiresIn: TOKEN_TTL_SECONDS };
}

// Cryptographic + shape + expiry verification ONLY -- this function never
// touches KV and never consumes anything. Returns { ok: true, payload } or
// { ok: false, reason }. `reason` is for internal logging/tests only;
// callers must never echo it verbatim to an end user.
function verifyRedesignToken(token) {
  let secret;
  try {
    secret = getSecret();
  } catch (err) {
    return { ok: false, reason: 'secret_not_configured' };
  }

  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
    return { ok: false, reason: 'malformed' };
  }
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [payloadB64, signature] = parts;
  if (!payloadB64 || !signature) return { ok: false, reason: 'malformed' };

  let expectedSignature;
  try {
    expectedSignature = sign(payloadB64, secret);
  } catch (err) {
    return { ok: false, reason: 'malformed' };
  }

  // timingSafeEqual requires equal-length buffers -- an attacker-chosen
  // signature of a different length must fail closed here, not throw.
  const providedBuf = Buffer.from(signature, 'utf8');
  const expectedBuf = Buffer.from(expectedSignature, 'utf8');
  if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64));
  } catch (err) {
    return { ok: false, reason: 'malformed' };
  }

  // Phase 4D.26.1: timestamps must be INTEGER Unix-seconds, not merely
  // finite numbers -- Number.isFinite(1.5) is true, but a fractional
  // second is not a value mintRedesignToken ever produces and has no
  // sensible meaning here, so it's rejected as malformed rather than
  // silently floored/truncated somewhere downstream.
  if (
    !payload ||
    typeof payload !== 'object' ||
    !CUSTOMER_ID_PATTERN.test(String(payload.customerId)) ||
    !Number.isInteger(payload.issuedAt) ||
    !Number.isInteger(payload.expiresAt) ||
    typeof payload.nonce !== 'string' ||
    payload.nonce.length === 0 ||
    payload.nonce.length > 200
  ) {
    return { ok: false, reason: 'malformed' };
  }

  // Phase 4D.26.1: an internally impossible token -- expiresAt at or
  // before issuedAt -- must never verify, independent of what `now`
  // happens to be. Without this, a correctly-signed token with e.g.
  // issuedAt = now+5, expiresAt = now+1 could slip past both the
  // future-skew check (5 <= MAX_FUTURE_SKEW_SECONDS) and the lifetime
  // check (a NEGATIVE difference is never "> TOKEN_TTL_SECONDS") while
  // expiresAt is still nominally in the future -- an external review
  // caught exactly this gap. mintRedesignToken() never produces such a
  // payload, but the verifier must reject its own invariant violations on
  // its own terms before this becomes an authentication boundary for
  // /api/redesign (Phase 4D.27).
  if (payload.expiresAt <= payload.issuedAt) {
    return { ok: false, reason: 'invalid_lifetime' };
  }

  const now = Math.floor(Date.now() / 1000);

  if (payload.issuedAt > now + MAX_FUTURE_SKEW_SECONDS) {
    return { ok: false, reason: 'issued_in_future' };
  }
  // Maximum SIGNED lifetime, enforced independently of the payload's own
  // arithmetic: even a signature-valid payload must not claim a lifetime
  // longer than mintRedesignToken ever issues (exactly TOKEN_TTL_SECONDS).
  // Phase 4D.26.1: this bound is now exactly TOKEN_TTL_SECONDS, not
  // TOKEN_TTL_SECONDS + MAX_FUTURE_SKEW_SECONDS -- MAX_FUTURE_SKEW_SECONDS
  // exists only to tolerate ordinary clock drift on WHEN a token was
  // issued, and must never be allowed to silently stretch how long a
  // token's own signed lifetime is permitted to be.
  if (payload.expiresAt - payload.issuedAt > TOKEN_TTL_SECONDS) {
    return { ok: false, reason: 'excessive_lifetime' };
  }
  // Phase 4D.26.1: the conventional inclusive boundary -- a token whose
  // expiresAt is exactly `now` is treated as already expired (<=, not <),
  // so no token is ever granted an extra boundary second of validity.
  if (payload.expiresAt <= now) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, payload };
}

// Atomically consume a redesign token: verify it cryptographically, check
// its expiry/shape, and ONLY THEN attempt a single atomic KV claim on its
// nonce. Returns { ok: true, customerId } on a genuine first use, or
// { ok: false, reason } for any failure -- malformed, bad signature,
// expired/not-yet-valid, or already consumed (a replay). See the file
// header for why the KV claim is one SET NX EX, not a read then a write.
async function consumeRedesignToken(token) {
  const verification = verifyRedesignToken(token);
  if (!verification.ok) return verification;

  const { payload } = verification;
  const key = consumeKey(payload.nonce);
  const claimed = await kv.set(key, '1', { nx: true, ex: CONSUME_RECORD_TTL_SECONDS });
  if (claimed !== 'OK') {
    return { ok: false, reason: 'already_consumed' };
  }
  return { ok: true, customerId: payload.customerId };
}

module.exports = {
  SECRET_ENV_VAR,
  TOKEN_TTL_SECONDS,
  MAX_FUTURE_SKEW_SECONDS,
  CONSUME_RECORD_TTL_SECONDS,
  mintRedesignToken,
  verifyRedesignToken,
  consumeRedesignToken,
};
