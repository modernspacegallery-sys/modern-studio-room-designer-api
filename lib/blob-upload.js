// Decor8 AI's API requires a publicly-reachable HTTPS URL for the input photo
// (it does not accept a base64 upload directly) — see README "How this works".
// The theme sends the photo as a base64 data URL, so we re-host it briefly on
// Vercel Blob to get a URL Decor8 can fetch, before calling their API.

const { put } = require('@vercel/blob');
const crypto = require('crypto');

const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // matches the 6MB limit already enforced client-side

function parseDataUrl(dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/.exec(dataUrl || '');
  if (!match) return null;
  const [, mime, base64] = match;
  const buffer = Buffer.from(base64, 'base64');
  return { mime, buffer };
}

async function uploadRoomPhoto(dataUrl) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) {
    throw Object.assign(new Error('Invalid image format. Please upload a JPG, PNG, or WEBP photo.'), {
      statusCode: 422,
    });
  }
  if (parsed.buffer.length > MAX_IMAGE_BYTES) {
    throw Object.assign(new Error('That photo is too large. Please choose a photo under 6MB.'), {
      statusCode: 422,
    });
  }

  const ext = parsed.mime.split('/')[1];
  const filename = `room-uploads/${crypto.randomUUID()}.${ext}`;

  const blob = await put(filename, parsed.buffer, {
    access: 'public',
    contentType: parsed.mime,
    // Uploaded room photos are only needed for the few seconds it takes
    // Decor8 to fetch and process them. Consider wiring up a periodic
    // cleanup (Vercel Blob doesn't currently support TTL natively) to
    // delete objects under room-uploads/ after e.g. 24 hours, both for
    // customer privacy and to keep storage cost near zero.
  });

  return blob.url;
}

module.exports = { uploadRoomPhoto, MAX_IMAGE_BYTES };
