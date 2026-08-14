// Tracks how many AI Room Designer generations each customer has used.
//
// IMPORTANT — known limitation (inherited from the existing theme code):
// `customerId` here is whatever value the browser sends, taken from Shopify's
// `customer.id` Liquid object with no signature or session token attached.
// That means a technically-savvy visitor could edit the request in devtools
// and pass an arbitrary/fake customerId to get a "fresh" set of free designs,
// or to read another customer's remaining count. This file adds IP-based rate
// limiting (see rate-limit.js) as a partial mitigation, but the real fix is to
// have the theme pass a verifiable identifier — e.g. a Shopify Customer
// Account API access token this backend can validate, or an Shopify App Proxy
// signed request — instead of a raw client-supplied ID. Flagging this clearly
// rather than silently shipping it as if it were secure.

const { kv } = require('@vercel/kv');

const FREE_LIMIT = parseInt(process.env.FREE_DESIGN_LIMIT || '2', 10);
// Effectively unlimited for AI+ subscribers, but still tracked (and still a
// real ceiling, via env var) rather than hard-coding true infinite usage.
const AI_PLUS_LIMIT = parseInt(process.env.AI_PLUS_DESIGN_LIMIT || '999999', 10);

function usageKey(customerId) {
  return `rd:used:${customerId}`;
}

async function getRemaining(customerId, limit = FREE_LIMIT) {
  const used = (await kv.get(usageKey(customerId))) || 0;
  return Math.max(0, limit - used);
}

async function recordGeneration(customerId, limit = FREE_LIMIT) {
  const used = await kv.incr(usageKey(customerId));
  return Math.max(0, limit - used);
}

module.exports = { getRemaining, recordGeneration, FREE_LIMIT, AI_PLUS_LIMIT };
