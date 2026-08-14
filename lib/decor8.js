// Thin wrapper around Decor8 AI's room redesign endpoint.
// Docs: https://api-docs.decor8.ai/  (base URL https://api.decor8.ai)
//
// VERIFY BEFORE LAUNCH: the STYLE_MAP and ROOM_TYPE_MAP below translate the
// values already used in the theme's style-picker (assets/studio-room-designer.js
// and sections/studio-tool-room-designer.liquid) into Decor8's expected enum
// strings. I could confirm Decor8's request/response shape and auth format
// from their public docs and SDK examples, but I do NOT have a Decor8 API key
// to test live calls, and I could not confirm the *complete* list of their
// accepted design_style / room_type enum values from outside their dashboard.
// A couple of these mappings (organic-modern, mid-century in particular) are
// my best reasonable guess at their naming convention, not a verified value.
// Before going live: sign up for a Decor8 account, check the exact accepted
// values in their dashboard/API playground (https://www.decor8.ai/api-docs/playground),
// and correct any entries below that don't match.

const DECOR8_BASE_URL = 'https://api.decor8.ai';

const STYLE_MAP = {
  modern: 'modern',
  japandi: 'japandi',
  'organic-modern': 'modern_organic', // VERIFY
  scandinavian: 'scandinavian',
  industrial: 'industrial',
  'mid-century': 'midcentury_modern', // VERIFY
  minimalist: 'minimalist',
  coastal: 'coastal',
  farmhouse: 'farmhouse',
  traditional: 'traditional',
  luxury: 'glam', // VERIFY — Decor8's closest documented equivalent to "luxury"
  bohemian: 'bohemian',
};

// The theme's room-type picker (added to studio-room-designer.js /
// studio-tool-room-designer.liquid) sends one of these keys directly. 'room'
// is kept as a fallback only, in case a request ever arrives without a
// selected room type.
const ROOM_TYPE_MAP = {
  room: 'livingroom',
  livingroom: 'livingroom',
  bedroom: 'bedroom',
  kitchen: 'kitchen',
  bathroom: 'bathroom',
  diningroom: 'diningroom',
  homeoffice: 'homeoffice',
  outdoor: 'outdoor',
};

function resolveStyle(style) {
  return STYLE_MAP[style] || 'modern';
}

function resolveRoomType(roomType) {
  return ROOM_TYPE_MAP[roomType] || 'livingroom';
}

async function generateRedesign({ imageUrl, style, roomType }) {
  const apiKey = process.env.DECOR8_API_KEY;
  if (!apiKey) {
    throw Object.assign(new Error('DECOR8_API_KEY is not configured.'), { statusCode: 500 });
  }

  const response = await fetch(`${DECOR8_BASE_URL}/generate_designs_for_room`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input_image_url: imageUrl,
      room_type: resolveRoomType(roomType),
      design_style: resolveStyle(style),
      num_images: 1,
    }),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok || !data || data.error) {
    const message = (data && (data.message || data.error)) || `Decor8 API error (status ${response.status})`;
    throw Object.assign(new Error(message), { statusCode: 502 });
  }

  const image = data.info && data.info.images && data.info.images[0];
  if (!image || !image.url) {
    throw Object.assign(new Error('Decor8 returned no image.'), { statusCode: 502 });
  }

  return image.url;
}

module.exports = { generateRedesign };
