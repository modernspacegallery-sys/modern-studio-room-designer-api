// api/redesign.js
// Vercel serverless function: receives a room photo + style, asks OpenAI
// to redesign it while preserving the room's structure, returns the result.
//
// Deploy: connect this repo to Vercel, add OPENAI_API_KEY as an env var,
// and set ALLOWED_ORIGIN to your storefront domain (e.g. https://modernspacegallery.com).

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '8mb', // room photos can be a few MB; adjust if needed
    },
  },
};

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

export default async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { image, style, roomType } = req.body || {};

    if (!image || typeof image !== 'string' || !image.startsWith('data:image/')) {
      res.status(400).json({ error: 'Missing or invalid "image" (expected a data URL).' });
      return;
    }
    if (!style || !STYLE_PROMPTS[style]) {
      res.status(400).json({ error: 'Missing or unrecognized "style".' });
      return;
    }

    // Convert the data URL to a Blob for the multipart upload.
    const [meta, base64Data] = image.split(',');
    const mimeMatch = meta.match(/data:(.*);base64/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
    const buffer = Buffer.from(base64Data, 'base64');

    const MAX_BYTES = 6 * 1024 * 1024; // 6MB safety cap
    if (buffer.length > MAX_BYTES) {
      res.status(400).json({ error: 'Image is too large. Please upload a photo under 6MB.' });
      return;
    }

    const styleDescription = STYLE_PROMPTS[style];
    const roomLabel = roomType ? String(roomType).slice(0, 40) : 'room';

    const prompt =
      `Redesign this ${roomLabel} in a ${style.replace(/-/g, ' ')} style: ${styleDescription}. ` +
      `IMPORTANT: preserve the room's existing architecture exactly \u2014 keep the same walls, windows, doors, ` +
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
      res.status(502).json({ error: 'The design service is temporarily unavailable. Please try again.' });
      return;
    }

    const data = await openaiRes.json();
    const resultB64 = data?.data?.[0]?.b64_json;

    if (!resultB64) {
      res.status(502).json({ error: 'No image was returned. Please try again.' });
      return;
    }

    res.status(200).json({ image: `data:image/png;base64,${resultB64}` });
  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
