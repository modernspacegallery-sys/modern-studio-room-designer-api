const { applyCors } = require('../lib/cors');
const {
  FREE_LIMIT,
  reserveFreeGeneration,
  commitFreeReservation,
  releaseFreeReservation,
  commitFreeReservationWithRequest,
  releaseFreeReservationWithRequest,
} = require('../lib/usage-store');
const { checkRateLimit } = require('../lib/rate-limit');
const { getEntitlement } = require('../lib/entitlement');
const { verifyCustomerToken } = require('../lib/verify-customer-token');
const { consumeRedesignToken } = require('../lib/redesign-token');
const { recordToolUse } = require('../lib/tool-usage');
const {
  computePeriodStart,
  computeNextReset,
  reserveCredit,
  commitCreditReservation,
  releaseCreditReservation,
  commitCreditReservationWithRequest,
  releaseCreditReservationWithRequest,
} = require('../lib/credits');
const { isIpOverFreeLimit, recordIpFreeUse } = require('../lib/ip-abuse-guard');
const { claimOrReclaimRequestSlot, markRequestRecord } = require('../lib/reservation-ledger');

// POST /api/redesign  { image, style, roomType, customerId, issuedAt, token, requestId? }
//                   or { image, style, roomType, redesignToken, requestId? }
// -> 200 { image: <data URL>, remaining, tier }
// -> 200 { status: 'completed', alreadyProcessed: true, remaining, tier }  (requestId replay of a completed request)
// -> 409 { error: 'already_processing' }  (requestId currently in flight elsewhere)
// -> 4xx/5xx { error, limitReached?: true, tier?, renewsOn? }
//
// Free-tier customers spend from the simple lifetime counter in
// usage-store.js, AND are subject to a secondary IP-based ceiling
// (lib/ip-abuse-guard.js) to blunt multi-account abuse. AI+ subscribers
// spend from their monthly credit balance and are exempt from the IP check.
//
// Phase 4D.25: the check-then-spend race across the ~30-60s OpenAI call is
// closed with an atomic reserve-before-generate / commit-or-release pattern
// (lib/reservation-ledger.js), so a failed generation -- or a process that
// dies mid-request -- can never permanently consume an allowance unit.
//
// Phase 4D.27A: this route now accepts TWO mutually exclusive authentication
// shapes on the same endpoint, during a migration window:
//
//   1. `redesignToken` (new, preferred) -- a short-lived, single-use,
//      HMAC-signed token minted by the Shopify App Proxy route
//      (api/proxy/redesign-token.js -> lib/redesign-token.js) from a
//      Shopify-verified identity. Selection between the two paths is by
//      PROPERTY PRESENCE on the request body, never by truthiness (Phase
//      4D.27A.2): as soon as `redesignToken` is an own property of the
//      body -- including "", whitespace, or a non-string value -- this
//      path is AUTHORITATIVE. `consumeRedesignToken()` is the only thing
//      that can produce a trusted customerId on this path, and ANY problem
//      with the supplied value (wrong type, empty/whitespace, malformed,
//      bad signature, expired, already consumed, secret not configured,
//      etc.) is a hard 401 with NO fallback to the legacy fields below,
//      even if the request also happens to include valid-looking
//      `customerId`/`issuedAt`/`token` fields. This is a deliberate
//      downgrade-prevention rule: a caller cannot send an empty, malformed,
//      or reused redesignToken as a way to make legacy auth get tried
//      instead.
//   2. `customerId` + `issuedAt` + `token` (legacy, unchanged) -- the
//      original theme-HMAC mechanism (lib/verify-customer-token.js). This
//      path is used ONLY when the request supplies NO `redesignToken`
//      property at all, and behaves exactly as it did before this phase.
//
// Everything downstream of authentication (requestId claim/replay,
// entitlement lookup, IP guard, reservation, generation, commit/release)
// operates on a single trusted `cleanCustomerId` regardless of which path
// produced it, and is unchanged from Phase 4D.25/4D.26 logic. `requestId`
// remains entirely optional, exactly as before.

const MAX_BYTES = 6 * 1024 * 1024;

const STYLE_PROMPTS = {
  modern: 'clean lines, neutral colors, minimalist furniture, uncluttered surfaces',
  japandi: 'Japanese minimalism blended with Scandinavian warmth, natural wood, low furniture, soft neutral palette',
  'organic-modern': 'natural materials, curved organic shapes, warm earthy tones, plants',
  scandinavian: 'light wood, white and soft neutral tones, cozy simplicity, functional furniture',
  industrial: 'exposed brick or concrete look, black metal accents, raw materials, Edison-style lighting',
  'mid-century': '1950s-60s inspired furniture, warm wood tones, bold accent colors, iconic silhouettes',
  minimalist: 'extremely uncluttered, monochrome palette, only essential furniture, lots of negative space',
  coastal: 'light airy blues and sandy neutrals, natural fiber textures, relaxed breezy feel',
  farmhouse: 'collected lived-in look, warm woods, vintage-inspired pieces, cozy textiles',
  traditional: 'classic elegant furniture, rich warm wood tones, refined fabrics, timeless details',
  luxury: 'rich materials like marble and brass, refined elevated furniture, sophisticated palette',
  bohemian: 'eclectic layered patterns, vibrant colors, natural textures, plants, artistic accents',
};

async function generateRedesign({ buffer, mimeType, style, roomType }) {
  const styleDescription = STYLE_PROMPTS[style] || STYLE_PROMPTS.modern;
  const roomLabel = roomType ? String(roomType).slice(0, 40) : 'room';
  const prompt =
    `Redesign this ${roomLabel} in a ${style.replace(/-/g, ' ')} style: ${styleDescription}. ` +
    `IMPORTANT: preserve the room's existing architecture exactly — keep the same walls, windows, doors, ` +
    `ceiling height, and camera angle. Only change the furniture, decor, colors, materials, and lighting fixtures. ` +
    `Do not add or remove windows or doors. Do not change the room's layout or perspective.`;

  const form = new FormData();
  form.append('model', 'gpt-image-1');
  form.append('prompt', prompt);
  form.append('size', '1024x1024');
  form.append('n', '1');
  form.append('image', new Blob([buffer], { type: mimeType }), 'room.png');

  const openaiRes = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });

  if (!openaiRes.ok) {
    const errText = await openaiRes.text();
    console.error('OpenAI error:', openaiRes.status, errText);
    throw Object.assign(new Error('The design service is temporarily unavailable. Please try again.'), {
      statusCode: 502,
    });
  }

  const data = await openaiRes.json();
  const resultB64 = data && data.data && data.data[0] && data.data[0].b64_json;
  if (!resultB64) {
    throw Object.assign(new Error('No image was returned. Please try again.'), { statusCode: 502 });
  }

  return `data:image/png;base64,${resultB64}`;
}

module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  const body = req.body || {};
  const { image, style, roomType, customerId, issuedAt, token, requestId, redesignToken } = body;

  // Structural validation (image/style/requestId syntax) happens BEFORE any
  // authentication -- a malformed request should never burn a single-use
  // redesignToken or trip the legacy-auth path, exactly as it never
  // consumed a reservation unit before this phase.
  if (!image || typeof image !== 'string' || !image.startsWith('data:image/')) {
    res.status(400).json({ error: 'Missing or invalid image.' });
    return;
  }
  if (!style || !STYLE_PROMPTS[style]) {
    res.status(400).json({ error: 'Missing or unrecognized style.' });
    return;
  }
  // requestId is entirely optional -- existing (legacy) callers, including
  // both the live theme and the unpublished theme as of this phase, never
  // send one, and every code path below must behave exactly as it did
  // before this phase when it's absent.
  const cleanRequestId = requestId != null ? String(requestId).trim() : '';
  if (cleanRequestId && !/^[A-Za-z0-9_-]{1,128}$/.test(cleanRequestId)) {
    res.status(400).json({ error: 'Invalid requestId.' });
    return;
  }

  const allowed = await checkRateLimit(req, 'redesign');
  if (!allowed) {
    res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    return;
  }

  // Authentication: exactly one of two mutually exclusive paths, selected by
  // PROPERTY PRESENCE, never by truthiness (Phase 4D.27A.2 hardening).
  //
  //   - `redesignToken` PRESENT on the body (any own property, including an
  //     empty string, whitespace, or a non-string value) -> the
  //     redesign-token path is authoritative. ANY problem with the supplied
  //     value -- wrong type, empty/whitespace, malformed, expired, already
  //     consumed, bad signature, missing signing secret -- is a generic 401
  //     with NO fallback to the legacy fields below, even when they are
  //     also present and would otherwise verify successfully. Truthiness
  //     ("" is falsy) must never be the gate here: a caller that explicitly
  //     sent an empty/invalid redesignToken has declared intent to use the
  //     new auth path, and an invalid value on that path must never be
  //     reinterpreted as "didn't send one."
  //   - `redesignToken` ABSENT (the property does not exist on the body at
  //     all) -> the unchanged legacy customerId/issuedAt/token path runs,
  //     exactly as it did before this phase.
  const hasRedesignToken = Object.prototype.hasOwnProperty.call(body, 'redesignToken');
  let cleanCustomerId;
  if (hasRedesignToken) {
    // Reject a non-string shape generically at the route boundary rather
    // than forwarding it into the token helper -- lib/redesign-token.js is
    // out of scope for this phase, and the route should not depend on how
    // gracefully a helper written for string input happens to handle a
    // non-string value.
    if (typeof redesignToken !== 'string') {
      res.status(401).json({ error: 'Could not verify your session. Please refresh the page and try again.' });
      return;
    }
    // Deliberately NOT filtered by truthiness: an empty or whitespace-only
    // string is still passed through (consumeRedesignToken's own malformed
    // check rejects "" the same way it rejects any other invalid shape),
    // so every invalid-value case reaches the identical generic-401 exit
    // below rather than a special-cased one.
    const cleanRedesignToken = redesignToken.trim();
    const consumed = await consumeRedesignToken(cleanRedesignToken);
    if (!consumed.ok) {
      // Every failure reason (malformed, bad_signature, expired,
      // already_consumed, secret_not_configured, invalid_lifetime,
      // issued_in_future, excessive_lifetime) collapses to the same
      // generic 401, matching the App Proxy routes' convention of never
      // distinguishing verification failure reasons externally, and
      // keeping "missing secret" indistinguishable from any other token
      // failure rather than surfacing it as a separate 500.
      res.status(401).json({ error: 'Could not verify your session. Please refresh the page and try again.' });
      return;
    }
    // consumeRedesignToken()/verifyRedesignToken() already format-validated
    // customerId against the same pattern used below, so no further check
    // is needed here.
    cleanCustomerId = consumed.customerId;
  } else {
    cleanCustomerId = String(customerId || '').trim();
    if (!/^[0-9]{1,30}$/.test(cleanCustomerId)) {
      res.status(400).json({ error: 'Invalid customerId.' });
      return;
    }
    if (!verifyCustomerToken(cleanCustomerId, issuedAt, token)) {
      res.status(401).json({ error: 'Could not verify your session. Please refresh the page and try again.' });
      return;
    }
  }

  // Cheap requestId dedupe check, before any entitlement/KV work for the
  // actual request -- a duplicate should be rejected (or replayed) as
  // cheaply as possible. claimOrReclaimRequestSlot is one atomic operation
  // (Phase 4D.25.1): if the prior attempt under this requestId ended
  // 'failed'/'released', it is reclaimed for this attempt right here,
  // atomically -- so a genuinely concurrent retry of the same failed
  // requestId can't also win; only one caller ever sees `claimed: true`.
  if (cleanRequestId) {
    const claim = await claimOrReclaimRequestSlot(cleanCustomerId, cleanRequestId);
    if (!claim.claimed) {
      const existing = claim.existing;
      if (existing && existing.status === 'completed') {
        res.status(200).json({
          status: 'completed',
          alreadyProcessed: true,
          remaining: existing.remaining,
          tier: existing.tier,
        });
        return;
      }
      // Genuinely 'in_flight' (or an unrecognized existing record --
      // treated the same, conservatively, as still in progress).
      res.status(409).json({ error: 'already_processing' });
      return;
    }
  }

  let reservation = null; // { reservationId, isAiPlus, customerId } once opened, for the catch block below
  let tier; // captured here so the catch block's error responses can still include it

  try {
    const entitlement = await getEntitlement(cleanCustomerId);
    tier = entitlement.tier;
    const isAiPlus = tier === 'ai_plus' && !!entitlement.periodAnchor;
    const periodStart = isAiPlus ? computePeriodStart(entitlement.periodAnchor) : null;

    // Free-tier customers get a second check: has this IP already used up
    // its shared free-design allowance, regardless of which customerId is
    // asking? AI+ subscribers skip this entirely.
    if (!isAiPlus) {
      const ipBlocked = await isIpOverFreeLimit(req);
      if (ipBlocked) {
        if (cleanRequestId) await markRequestRecord(cleanCustomerId, cleanRequestId, 'failed').catch(() => {});
        res.status(403).json({ error: "You've used your free designs.", limitReached: true, tier: 'free' });
        return;
      }
    }

    // Image decode/size-validation happens BEFORE reservation (moved ahead
    // of the credit check from the pre-4D.25 flow, per Phase 4D.25 Part 7):
    // a malformed payload should never consume a reservation unit, and
    // decoding is cheap compared to a KV round-trip, so there's no
    // real-request cost to validating it first.
    const [meta, base64Data] = image.split(',');
    const mimeMatch = /data:(.*);base64/.exec(meta);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
    const buffer = Buffer.from(base64Data, 'base64');
    if (buffer.length > MAX_BYTES) {
      if (cleanRequestId) await markRequestRecord(cleanCustomerId, cleanRequestId, 'failed').catch(() => {});
      res.status(400).json({ error: 'Image is too large. Please upload a photo under 6MB.' });
      return;
    }

    // Atomic reserve — this is the fix for the check-then-spend race.
    // Rejects (and restores the counter) BEFORE any OpenAI call, exactly
    // like the pre-4D.25 check did, but now without a window where a
    // concurrent request could slip past the same check.
    const reserveResult = isAiPlus
      ? await reserveCredit(cleanCustomerId, periodStart, 'standard_redesign')
      : await reserveFreeGeneration(cleanCustomerId, FREE_LIMIT);

    if (!reserveResult.ok) {
      if (cleanRequestId) await markRequestRecord(cleanCustomerId, cleanRequestId, 'failed').catch(() => {});
      res.status(403).json({
        error: isAiPlus ? "You're out of AI Design Credits for this billing period." : "You've used your free designs.",
        limitReached: true,
        tier,
        renewsOn: isAiPlus ? computeNextReset(periodStart) : undefined,
      });
      return;
    }

    reservation = { reservationId: reserveResult.reservationId, isAiPlus, customerId: cleanCustomerId };

    const resultImage = await generateRedesign({ buffer, mimeType, style, roomType });

    const remaining = reserveResult.remaining;

    // Success: commit the reservation (no counter change -- it was already
    // applied atomically at reserve time) and preserve today's existing
    // success-only IP-accounting semantics for free tier. When a requestId
    // was supplied, the commit AND the requestId's 'completed' state are
    // applied in ONE atomic step (Phase 4D.25.2) -- there is no window
    // where the reservation is committed but the requestId record isn't,
    // which is what makes a later replay of this requestId safe.
    if (cleanRequestId) {
      const commitFn = isAiPlus ? commitCreditReservationWithRequest : commitFreeReservationWithRequest;
      await commitFn(cleanCustomerId, reservation.reservationId, cleanRequestId, { remaining, tier });
    } else {
      const commitFn = isAiPlus ? commitCreditReservation : commitFreeReservation;
      await commitFn(cleanCustomerId, reservation.reservationId);
    }
    if (!isAiPlus) {
      recordIpFreeUse(req).catch(() => {}); // best-effort, never blocks the response, unchanged from before
    }
    reservation = null; // resolved -- the catch block below must not also release it

    recordToolUse('room-designer').catch(() => {});

    res.status(200).json({ image: resultImage, remaining, tier });
  } catch (err) {
    if (reservation) {
      // Generation failed (or something else threw) after a reservation was
      // opened -- refund it so this failure never permanently consumes an
      // allowance unit. Best-effort: if the release itself fails, the lazy
      // reconciliation on this customer's *next* request still recovers it,
      // however long that takes -- an unresolved reservation carries no TTL
      // (see reservation-ledger.js). When a requestId was supplied, release
      // and marking it 'failed' happen in one atomic step too, symmetric
      // with the success path.
      if (cleanRequestId) {
        const releaseFn = reservation.isAiPlus ? releaseCreditReservationWithRequest : releaseFreeReservationWithRequest;
        await releaseFn(reservation.customerId, reservation.reservationId, cleanRequestId).catch(() => {});
      } else {
        const releaseFn = reservation.isAiPlus ? releaseCreditReservation : releaseFreeReservation;
        await releaseFn(reservation.customerId, reservation.reservationId).catch(() => {});
      }
    } else if (cleanRequestId) {
      // No reservation was ever opened (failure happened before reserve --
      // e.g. the IP guard or an oversized image) -- nothing to couple this
      // write to atomically, so it's a plain bookkeeping write.
      await markRequestRecord(cleanCustomerId, cleanRequestId, 'failed').catch(() => {});
    }
    console.error('redesign failed', err);
    const statusCode = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    const safeMessage =
      statusCode === 422 || statusCode === 400 ? err.message : 'Something went wrong generating your design. Please try again.';
    res.status(statusCode).json({ error: safeMessage });
  }
};
