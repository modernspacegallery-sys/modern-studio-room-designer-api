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

// Phase 4D.30B -- modular prompt architecture. Each section below is an
// independently editable concern, concatenated (in this fixed order) by
// generateRedesign() into the single `prompt` string the OpenAI Images Edit
// endpoint requires. Splitting it this way means a future change to, say,
// one room's rules can never accidentally touch style text or the
// architecture-preservation clause. generateRedesign() remains the ONLY
// function that talks to OpenAI -- this phase does not add a second
// generation path or a second endpoint.
//
// Order matters: the two invariant, always-present sections (architecture
// preservation, then the Môdern design-quality standard) come first, then
// the two variable sections (room rules, then style), then the task framing
// that names what's actually being asked of the model. This keeps the
// highest-priority constraints -- what must NEVER change -- stated before
// anything about what should change.

// 1. ARCHITECTURE PRESERVATION -- invariant, present on every request.
// Explicitly enumerates every permanent structural element called out in
// Phase 4D.30A's audit (the previous version only named walls, windows,
// doors, ceiling height, and camera angle -- it never mentioned stairs,
// which is the most likely reason a staircase was altered in the observed
// production test). This is prompt-level guidance only; Phase 4D.30A Part 5
// also identified `input_fidelity` (Part 6 below) and output-size matching
// (Part 7 below) as additional, non-prompt levers on this same endpoint.
// Mask-based region protection is explicitly deferred (Part 8) -- this
// phase does not implement it.
const ARCHITECTURE_PRESERVATION =
  "CRITICAL ARCHITECTURAL PRESERVATION -- READ FIRST: Treat every permanent structural element visible in the source photo as immutable. This includes walls, windows, doors, openings, stairs, stair treads, stair landings, railings, columns, ceiling shape, ceiling height, built-ins, fireplaces, permanent cabinetry, floor-plan geometry, structural floor geometry, and overall structural proportions. Preserve the exact number, placement, shape, proportion, and geometry of each of these elements exactly as shown in the source photo. Do not create, remove, relocate, simplify, widen, narrow, or redesign any permanent architectural element. Preserve the exact camera position, camera angle, and perspective of the original photo. " +
  'The only things that may change are: movable furniture, rugs, textiles, decor, artwork, plants, decorative lighting fixtures, wall colors, and non-structural surface finishes where appropriate to the chosen style. This is an interior decor redesign, not a structural rebuild.';

// 2. MÔDERN SPACE GALLERY DESIGN QUALITY STANDARD -- invariant, present on
// every request, independent of style. Targets the "too sparse / generic /
// AI-staged" finding from Phase 4D.30A Part 2 directly: the prior Modern
// definition leaned on the same "minimalist"/"uncluttered" vocabulary as
// the Minimalist style itself, with nothing pushing back toward richness.
// This section applies underneath every style rather than being repeated
// in each STYLE_PROMPTS entry.
const DESIGN_QUALITY_STANDARD =
  'MÔDERN SPACE GALLERY DESIGN STANDARD: Style this room the way an experienced professional interior designer would for a sophisticated, editorial home-design feature -- warm, polished, intentional, layered, realistic, livable, aspirational, and visually complete. Avoid an empty, under-furnished, or showroom-sterile result, and avoid a generic, artificially-staged AI look. Also avoid random clutter, excessive decor, or repetitive accessories. Where suitable to this specific room and the chosen style -- but never forced into every space -- include thoughtful finishing details such as greenery, artwork, considered surface styling, layered lighting, textiles, material contrast, sculptural objects, side tables, or accent pieces. The result should feel visually balanced and genuinely designed, not merely furnished.';

// 3. ROOM RULES -- one short, principle-driven rule set per room type,
// keyed by the exact roomType values the Room Designer theme section sends
// (confirmed in Phase 4D.30A: livingroom, bedroom, kitchen, bathroom,
// diningroom, homeoffice, outdoor). Deliberately NOT a full per-room design
// treatise, and deliberately NOT combined into a room x style matrix (that
// would be 7 x 12 = 84 brittle combinations) -- each room's rules stay a
// handful of principles, concatenated with whichever style text applies.
const ROOM_RULES = {
  livingroom:
    'For this living room: arrange seating in a conversation-oriented grouping around a clear focal point; use a rug scaled to anchor the major seating pieces where the space allows; include a coffee table proportionate to the seating; add side tables where space allows; layer the lighting; preserve clear circulation paths; keep negative space balanced rather than empty or crowded.',
  bedroom:
    'For this bedroom: make the bed the clear focal point with appropriately scaled nightstands on the available side(s); keep clear circulation space around the bed; layer the lighting with an ambient source plus a bedside source; introduce soft textiles for warmth; keep the composition calm and restful rather than sparse or cluttered.',
  kitchen:
    'For this kitchen: keep all cabinetry, countertops, appliances, and fixtures exactly as shown -- these are permanent architecture; only restyle movable elements such as stools, small decor, textiles, and accessories on open counter space; maintain clear, functional circulation space.',
  bathroom:
    'For this bathroom: keep all fixtures, tile, cabinetry, and plumbing exactly as shown -- these are permanent architecture; only restyle movable elements such as towels, bath mats, small decor, and accessories; keep the result clean, calming, and uncluttered.',
  diningroom:
    'For this dining room: center the composition on a dining table sized appropriately to the space, with a properly scaled rug beneath it where the space allows; ensure seating is arranged for practical use; add a considered lighting fixture over the table when appropriate; keep circulation space around the table clear.',
  homeoffice:
    'For this home office: arrange the desk with a clear, functional work orientation; keep the desk surface styled with purpose rather than left empty; add appropriate task lighting; style any shelving or storage so it reads as organized rather than sparse or cluttered.',
  outdoor:
    'For this outdoor/patio space: use furniture and materials suited to outdoor use; arrange seating for comfortable gathering; keep plantings and greenery natural to the space; preserve all structural elements -- railings, decking, permanent structures -- exactly as shown.',
};

// Phase 4D.30B.2 -- trusted, fixed room-label map, keyed identically to
// ROOM_RULES. `roomType` arrives on the request body as ordinary
// client-controlled input (the route never validates it against an enum,
// unlike `style`), so it must never be interpolated into the prompt as raw
// text -- only a label looked up from this fixed map (or the generic
// fallback below) may reach the model. This is the ONLY source of a room
// label in the final prompt as of this phase; see generateRedesign().
const ROOM_LABELS = {
  livingroom: 'living room',
  bedroom: 'bedroom',
  kitchen: 'kitchen',
  bathroom: 'bathroom',
  diningroom: 'dining room',
  homeoffice: 'home office',
  outdoor: 'outdoor space',
};
const GENERIC_ROOM_LABEL = 'room';

// 4. STYLE PROMPTS -- richer design briefs than the previous single
// comma-list per style (Phase 4D.30A Part 4/5 audit). Each entry now
// addresses furniture silhouette, palette, material language, texture,
// lighting character, decorative density, and mood where relevant, aiming
// for styles that read as visually distinct rather than twelve variations
// on "neutral room, different furniture."
//
// Modern deliberately does NOT use the phrase "minimalist furniture" (or
// otherwise define itself in Minimalist's own vocabulary) -- this was the
// specific, named root cause in Phase 4D.30A Part 2 of Modern reading as a
// bare, sparse result. Minimalist keeps its own intentionally sparse
// identity; the two are written to read as different rooms.
const STYLE_PROMPTS = {
  modern:
    'Modern: clean-lined, sophisticated, warm contemporary furniture with sculptural silhouettes; a refined neutral-to-warm palette; a considered mix of materials such as wood, stone, glass, and metal alongside linen, wool, or other textured upholstery; polished but not stark -- restrained and finished rather than empty. Where appropriate, include art, greenery, styled surfaces, and sculptural lighting or accessories.',
  japandi:
    'Japandi: a calm fusion of Japanese minimalism and Scandinavian warmth; low-profile furniture in natural wood tones; a soft neutral palette with muted earth-tone accents; matte, tactile materials such as raw wood, linen, and stoneware; quiet, restrained styling with occasional organic or ceramic accents; a warm, serene mood.',
  'organic-modern':
    'Organic Modern: natural materials paired with soft, curved furniture silhouettes; warm earthy tones layered with cream and stone neutrals; textures such as boucle, linen, rattan, and raw wood; abundant plants and organic-shaped decor; a relaxed, grounded, tactile mood.',
  scandinavian:
    'Scandinavian: light wood furniture with simple, functional silhouettes; a bright palette of white, soft neutrals, and gentle accent tones; cozy textiles such as wool throws and woven textures; understated, purposeful decor; a warm, hygge-inspired mood balanced with clean simplicity.',
  industrial:
    'Industrial: exposed brick or concrete-look surfaces, black or blackened metal furniture frames, raw and weathered materials, leather upholstery, and Edison-style or exposed-bulb lighting; furniture with a utilitarian, factory-inspired silhouette; a moody, raw palette warmed by wood and leather accents.',
  'mid-century':
    'Mid-Century Modern: 1950s-60s inspired furniture with tapered legs and iconic sculptural silhouettes; warm walnut and teak wood tones; bold accent colors such as mustard, burnt orange, or teal; geometric patterns; brass or warm metal accents; a confident, retro-refined mood.',
  minimalist:
    'Minimalist: intentionally sparse and calm; only essential, well-chosen furnishings; a restrained, largely monochrome palette; strong negative space; a small number of decorative objects, each purposeful rather than incidental; clean lines and quiet visual stillness.',
  coastal:
    'Coastal: airy blues, sandy neutrals, and crisp whites; natural fiber textures such as rattan, jute, and linen; relaxed, breezy furniture silhouettes; light-catching materials like glass and driftwood tones; a casual, sunlit, effortless mood.',
  farmhouse:
    'Farmhouse: a collected, lived-in look with warm wood tones and vintage-inspired furniture pieces; cozy layered textiles; shiplap or beam-style architectural character where already present in the room; distressed or matte finishes; a warm, welcoming, unpretentious mood.',
  traditional:
    'Traditional: classic, elegant furniture silhouettes with refined detailing; rich warm wood tones; refined fabrics such as velvet or tailored upholstery; symmetrical, balanced arrangements; timeless, formal-but-livable styling with a sense of heritage.',
  luxury:
    'Luxury: rich materials such as marble, brass, and polished stone; refined, elevated furniture silhouettes; a sophisticated, tonal palette; statement lighting; tactile richness through velvet, silk, or other high-end textiles; art or sculptural objects; an elevated, polished, aspirational mood.',
  bohemian:
    'Bohemian: eclectic layered patterns and textiles; vibrant, warm color combinations; natural textures such as rattan, macrame, and woven fiber; abundant plants; artistic, global-inspired decorative accents; a warm, collected, personality-rich mood, balanced enough to avoid visual chaos.',
};

// -- Orientation-aware output size (Phase 4D.30B Part 7) --------------------
//
// The previous version always requested a fixed 1024x1024 output regardless
// of the uploaded photo's actual aspect ratio, which (per Phase 4D.30A Part
// 2/5) forces the model to reconstruct more of the frame than a same-aspect
// edit would -- an independent pressure toward altering geometry (e.g. the
// observed staircase distortion) that has nothing to do with prompt wording.
//
// This reads width/height directly from the image's own file headers using
// only Node's built-in Buffer -- no new npm dependency is added. Per this
// phase's explicit instruction, a dependency (e.g. a native image library)
// was considered and deliberately NOT added; only PNG and JPEG are
// supported (the two formats the Room Designer's own upload/optimization
// step realistically produces), and detection fails safe: any unsupported
// format, truncated buffer, or parsing error falls back to the original
// fixed '1024x1024', exactly matching prior behavior for that case.
function readPngDimensions(buffer) {
  // PNG signature is 8 bytes, followed immediately by the IHDR chunk:
  // 4-byte length, 4-byte type ("IHDR"), then 4-byte width + 4-byte height
  // (both big-endian), per the PNG spec -- always at this fixed offset.
  if (buffer.length < 24) return null;
  const isPng =
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a;
  if (!isPng) return null;
  const isIhdr = buffer[12] === 0x49 && buffer[13] === 0x48 && buffer[14] === 0x44 && buffer[15] === 0x52;
  if (!isIhdr) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

function readJpegDimensions(buffer) {
  // JPEG is a sequence of markers (0xFF followed by a marker byte). Width
  // and height live in the payload of the Start-Of-Frame marker (0xC0-0xCF,
  // excluding 0xC4/0xC8/0xCC which are not frame markers): 2-byte segment
  // length, 1-byte precision, then 2-byte height + 2-byte width, both
  // big-endian. Walk the marker chain rather than assuming a fixed offset,
  // since arbitrary metadata (EXIF, etc.) can precede the frame marker.
  //
  // Phase 4D.30B.2 hardening: the Start-Of-Scan marker (0xDA) ends the
  // marker chain -- everything after its header is entropy-coded
  // (compressed) scan data, not further markers. The previous version had
  // no concept of SOS and would keep walking past it, meaning a stray 0xFF
  // byte inside compressed scan data (including legitimate 0xFF00
  // byte-stuffing) could be misread as a fake marker with a bogus length,
  // in principle producing a spurious width/height from garbage bytes on a
  // corrupted or adversarial file (Phase 4D.30B.1 review finding). Per this
  // phase's explicit instruction, a well-formed JPEG always has its real
  // SOF marker before SOS, so reaching SOS with no SOF found yet means
  // there is nothing more to safely read: stop immediately and return null
  // (falls back to the fixed default size), rather than continuing into
  // the scan data at all.
  //
  // Also hardened here: every non-SOF/SOS marker's declared segment length
  // is validated before it's ever used to advance `offset` -- a
  // structurally invalid length (per the JPEG spec, the length field
  // includes itself, so any real segment length is >= 2) or a length that
  // would advance past the end of the buffer (a truncated/corrupt segment)
  // now returns null immediately instead of computing a bogus next offset.
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null; // not a JPEG (no SOI marker)
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      // Stray SOI/EOI mid-stream -- neither carries a length field.
      offset += 2;
      continue;
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      // Restart markers -- no length field either.
      offset += 2;
      continue;
    }
    if (marker === 0xda) {
      // Start Of Scan reached with no SOF found first: everything past
      // this point is compressed scan data, not markers. Stop scanning
      // entirely rather than risk misinterpreting it -- any SOF-like bytes
      // that happen to appear later in the entropy-coded data are
      // deliberately never reached or examined.
      return null;
    }
    // Every other marker (SOF included) has a 2-byte big-endian length
    // field immediately after it, and that length INCLUDES the 2 length
    // bytes themselves -- so a structurally valid value is always >= 2.
    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2) return null; // structurally invalid -- fail safe rather than guess
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      // The outer loop condition (offset + 9 < buffer.length) already
      // guarantees these two reads are in-bounds, independent of whatever
      // (possibly bogus) segmentLength claims -- they don't rely on it.
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      if (!width || !height) return null;
      return { width, height };
    }
    const nextOffset = offset + 2 + segmentLength;
    // A segment that claims to extend past the end of the buffer is
    // truncated/corrupt -- fail safe (null) rather than advance `offset`
    // to a position past the data and let the next loop check silently
    // exit. (segmentLength >= 2 already guarantees nextOffset > offset --
    // i.e. forward progress -- so no separate non-advancement check is
    // needed here.)
    if (nextOffset > buffer.length) return null;
    offset = nextOffset;
  }
  return null;
}

function getImageDimensions(buffer, mimeType) {
  try {
    if (mimeType === 'image/png') return readPngDimensions(buffer);
    if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') return readJpegDimensions(buffer);
    // Any other format (webp, gif, heic, etc.) is intentionally left
    // undetected rather than adding another hand-rolled parser or a
    // dependency -- callers fall back to the fixed default size.
    return null;
  } catch (err) {
    // A malformed/truncated buffer must never throw and break generation --
    // it only means orientation can't be determined, which already has a
    // safe fallback.
    return null;
  }
}

const SQUARE_ASPECT_TOLERANCE = 0.1; // within +/-10% of 1:1 is treated as "approximately square"

function chooseOutputSize(buffer, mimeType) {
  const dimensions = getImageDimensions(buffer, mimeType);
  if (!dimensions) return '1024x1024'; // unchanged fallback when orientation can't be determined
  const { width, height } = dimensions;
  const ratio = width / height;
  if (ratio > 1 + SQUARE_ASPECT_TOLERANCE) return '1536x1024'; // landscape
  if (ratio < 1 - SQUARE_ASPECT_TOLERANCE) return '1024x1536'; // portrait
  return '1024x1024'; // approximately square
}

// 5. Final source-image / task framing, plus the size/parameter choices
// made per-request. generateRedesign() remains the only function in this
// codebase that calls OpenAI -- this phase only changes what's inside it.
async function generateRedesign({ buffer, mimeType, style, roomType }) {
  const styleDescription = STYLE_PROMPTS[style] || STYLE_PROMPTS.modern;
  // Phase 4D.30B.2: `roomLabel` and `roomRule` are now BOTH derived
  // exclusively from the trusted, fixed ROOM_LABELS/ROOM_RULES maps --
  // `roomType` itself (client-controlled, never enum-validated at the route
  // level) is used only as a lookup KEY, never interpolated into the prompt
  // as text. An unrecognized or absent roomType falls back to the generic
  // "room" label and has no room-specific rule at all -- exactly the same
  // request-compatibility behavior as before (still 200s, still generates),
  // just without ever placing the raw supplied value into the prompt.
  const roomLabel = ROOM_LABELS[roomType] || GENERIC_ROOM_LABEL;
  const roomRule = ROOM_RULES[roomType] || '';
  const taskFraming = `TASK: Redesign this ${roomLabel}'s interior styling in the style described above, based on the photo provided.`;

  const prompt = [ARCHITECTURE_PRESERVATION, DESIGN_QUALITY_STANDARD, roomRule, styleDescription, taskFraming]
    .filter(Boolean)
    .join(' ');

  const outputSize = chooseOutputSize(buffer, mimeType);

  const form = new FormData();
  form.append('model', 'gpt-image-1');
  form.append('prompt', prompt);
  form.append('size', outputSize);
  // Phase 4D.30B Part 6: ask the Images Edit endpoint to hew more closely
  // to the source image outside the intended edit -- a same-endpoint,
  // same-model parameter (no new API surface), per Phase 4D.30A Part 5's
  // recommendation. Endpoint and model are unchanged.
  form.append('input_fidelity', 'high');
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
      // Phase 4D.29B: minimal sanitized diagnostic log. Never logs the
      // value itself (whatever a non-string redesignToken actually is --
      // could be an object, number, boolean, null, array, etc.), only the
      // fact that this branch was hit. No token, no body, no customerId,
      // no headers, no IP, no requestId.
      console.warn('redesign_token_rejected', { event: 'redesign_token_rejected', reason: 'non_string_token' });
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
      // Phase 4D.29B: minimal sanitized diagnostic log -- logs ONLY the
      // internal rejection reason string (one of the fixed, non-sensitive
      // enum values consumeRedesignToken()/verifyRedesignToken() can
      // return: secret_not_configured, malformed, bad_signature,
      // invalid_lifetime, issued_in_future, excessive_lifetime, expired,
      // already_consumed). Never logs the token, its payload, the nonce,
      // any customerId, the signature, or anything else about the
      // request. The HTTP response below is completely unchanged -- the
      // browser still only ever sees the same generic 401 text.
      console.warn('redesign_token_rejected', { event: 'redesign_token_rejected', reason: consumed.reason || 'unknown' });
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

// Phase 4D.30B: test-only introspection surface. Purely additive -- the
// module's export is still the same callable handler function it always
// was (`require('../api/redesign')` returns a function, exactly as before),
// this just attaches extra properties onto that same function object so
// the new prompt-architecture pieces can be unit-tested directly without
// duplicating them, re-parsing the file, or changing any call site.
// Nothing in this project requires or reads `._internal` outside tests.
module.exports._internal = {
  ARCHITECTURE_PRESERVATION,
  DESIGN_QUALITY_STANDARD,
  ROOM_RULES,
  ROOM_LABELS,
  GENERIC_ROOM_LABEL,
  STYLE_PROMPTS,
  getImageDimensions,
  chooseOutputSize,
};