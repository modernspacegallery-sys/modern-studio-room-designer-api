const { applyCors } = require('../lib/cors');
const { getRemaining, recordGeneration, FREE_LIMIT, AI_PLUS_LIMIT } = require('../lib/usage-store');
const { checkRateLimit } = require('../lib/rate-limit');
const { getEntitlement } = require('../lib/entitlement');

// POST /api/redesign  { image, style, roomType, customerId }
// Matches the contract expected by assets/studio-room-designer.js:
//   -> 200 { image: <data URL>, remaining: <number> }
//   -> 4xx/5xx { error: <string>, limitReached?: true }
//
// Uses OpenAI's image edit endpoint (gpt-image-1) directly. The theme already
// compresses photos client-side to stay under Vercel's fixed request body
// limit for serverless functions, so the image goes straight from the
// browser to this function to OpenAI — no separate upload-to-blob-storage
// step needed.

const MAX_BYTES = 6 * 1024 * 1024; // safety cap, in addition to client-side compression

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
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
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

  const { image, style, roomType, customerId } = req.body || {};

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

  try {
    const tier = await getEntitlement(cleanCustomerId);
    const limit = tier === 'ai_plus' ? AI_PLUS_LIMIT : FREE_LIMIT;

    const remainingBefore = await getRemaining(cleanCustomerId, limit);
    if (remainingBefore <= 0) {
      res.status(403).json({ error: "You've used your free designs.", limitReached: true });
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
    const remaining = await recordGeneration(cleanCustomerId, limit);

    res.status(200).json({ image: resultImage, remaining, tier });
  } catch (err) {
    console.error('redesign failed', err);
    const statusCode = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    const safeMessage =
      statusCode === 422 || statusCode === 400
        ? err.message
        : 'Something went wrong generating your design. Please try again.';
    res.status(statusCode).json({ error: safeMessage });
  }
};
