const { applyCors } = require('../lib/cors');
const { getRemaining, recordGeneration, FREE_LIMIT } = require('../lib/usage-store');
const { checkRateLimit } = require('../lib/rate-limit');
const { getEntitlement } = require('../lib/entitlement');
const { verifyCustomerToken } = require('../lib/verify-customer-token');
const { recordToolUse } = require('../lib/tool-usage');
const { getCreditsRemaining, spendCredits, computePeriodStart, computeNextReset, CREDIT_COSTS } = require('../lib/credits');
const { isIpOverFreeLimit, recordIpFreeUse } = require('../lib/ip-abuse-guard');

// POST /api/redesign  { image, style, roomType, customerId, issuedAt, token }
// -> 200 { image: <data URL>, remaining, tier }
// -> 4xx/5xx { error, limitReached?: true, tier?, renewsOn? }
//
// Free-tier customers spend from the simple lifetime counter in
// usage-store.js, AND are subject to a secondary IP-based ceiling
// (lib/ip-abuse-guard.js) to blunt multi-account abuse. AI+ subscribers
// spend from their monthly credit balance and are exempt from the IP check.

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

  const { image, style, roomType, customerId, issuedAt, token } = req.body || {};

  const cleanCustomerId = String(customerId || '').trim();
  if (!/^[0-9]{1,30}$/.test(cleanCustomerId)) {
    res.status(400).json({ error: 'Invalid customerId.' });
    return;
  }
  if (!image || typeof image !== 'string' || !image.startsWith('data:image/')) {
    res.status(400).json({ error: 'Missing or invalid image.' });
    return;
  }
  if (!style || !STYLE_PROMPTS[style]) {
    res.status(400).json({ error: 'Missing or unrecognized style.' });
    return;
  }

  const allowed = await checkRateLimit(req, 'redesign');
  if (!allowed) {
    res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    return;
  }

  if (!verifyCustomerToken(cleanCustomerId, issuedAt, token)) {
    res.status(401).json({ error: 'Could not verify your session. Please refresh the page and try again.' });
    return;
  }

  try {
    const { tier, periodAnchor } = await getEntitlement(cleanCustomerId);
    const isAiPlus = tier === 'ai_plus' && !!periodAnchor;
    const periodStart = isAiPlus ? computePeriodStart(periodAnchor) : null;

    // Free-tier customers get a second check: has this IP already used up
    // its shared free-design allowance, regardless of which customerId is
    // asking? AI+ subscribers skip this entirely.
    if (!isAiPlus) {
      const ipBlocked = await isIpOverFreeLimit(req);
      if (ipBlocked) {
        res.status(403).json({ error: "You've used your free designs.", limitReached: true, tier: 'free' });
        return;
      }
    }

    // Check BEFORE generating — never call OpenAI for a request we're going to reject anyway.
    const remainingBefore = isAiPlus
      ? await getCreditsRemaining(cleanCustomerId, periodStart)
      : await getRemaining(cleanCustomerId, FREE_LIMIT);
    const costOfThisOperation = isAiPlus ? CREDIT_COSTS.standard_redesign : 0;

    if (isAiPlus ? remainingBefore < costOfThisOperation : remainingBefore <= 0) {
      res.status(403).json({
        error: isAiPlus ? "You're out of AI Design Credits for this billing period." : "You've used your free designs.",
        limitReached: true,
        tier,
        renewsOn: isAiPlus ? computeNextReset(periodStart) : undefined,
      });
      return;
    }

    const [meta, base64Data] = image.split(',');
    const mimeMatch = /data:(.*);base64/.exec(meta);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
    const buffer = Buffer.from(base64Data, 'base64');
    if (buffer.length > MAX_BYTES) {
      res.status(400).json({ error: 'Image is too large. Please upload a photo under 6MB.' });
      return;
    }

    const resultImage = await generateRedesign({ buffer, mimeType, style, roomType });

    let remaining;
    if (isAiPlus) {
      const spendResult = await spendCredits(cleanCustomerId, periodStart, 'standard_redesign');
      remaining = spendResult.remaining;
    } else {
      remaining = await recordGeneration(cleanCustomerId, FREE_LIMIT);
      recordIpFreeUse(req).catch(() => {}); // best-effort, never blocks the response
    }

    recordToolUse('room-designer').catch(() => {});

    res.status(200).json({ image: resultImage, remaining, tier });
  } catch (err) {
    console.error('redesign failed', err);
    const statusCode = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    const safeMessage =
      statusCode === 422 || statusCode === 400 ? err.message : 'Something went wrong generating your design. Please try again.';
    res.status(statusCode).json({ error: safeMessage });
  }
};
