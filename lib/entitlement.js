// Determines whether a customer has an active Môdern Studio AI+ subscription.
//
// Trust note: `customerId` here is the same client-supplied value flagged in
// usage-store.js — this only proves whether *that* Shopify customer ID has an
// active AI+ subscription, not that the request actually came from that
// customer. That gap matters more now that real billing is involved. See
// usage-store.js for the full explanation; fixing it properly means having
// the theme send a verifiable identifier instead of a raw client-supplied ID.
//
// Fail-closed by design: if Shopify is unreachable, the token is missing, or
// anything else goes wrong, this treats the customer as free-tier rather than
// silently granting paid access.

const { kv } = require('@vercel/kv');

const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || 'modernspacegallery.myshopify.com';
const ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const API_VERSION = '2025-01';
const AI_PLUS_PRODUCT_ID = 'gid://shopify/Product/9720923422963'; // Môdern Studio™ AI+

// How long a "yes/no subscribed" result is cached before re-checking Shopify.
// Balances API load against how quickly a new subscriber sees AI+ unlock.
const CACHE_TTL_SECONDS = 600; // 10 minutes

const QUERY = `
  query CustomerAiPlusStatus($customerId: ID!) {
    customer(id: $customerId) {
      subscriptionContracts(first: 10) {
        edges {
          node {
            status
            lines(first: 5) {
              edges {
                node {
                  productId
                }
              }
            }
          }
        }
      }
    }
  }
`;

function cacheKey(customerId) {
  return `entitlement:${customerId}`;
}

async function fetchEntitlementFromShopify(customerId) {
  if (!ACCESS_TOKEN) {
    console.error('SHOPIFY_ADMIN_ACCESS_TOKEN is not set — treating all customers as free tier.');
    return 'free';
  }

  const res = await fetch(`https://${STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': ACCESS_TOKEN,
    },
    body: JSON.stringify({
      query: QUERY,
      variables: { customerId: `gid://shopify/Customer/${customerId}` },
    }),
  });

  if (!res.ok) {
    throw new Error(`Shopify Admin API responded ${res.status}`);
  }

  const data = await res.json();
  if (data.errors) {
    throw new Error('Shopify Admin API returned errors: ' + JSON.stringify(data.errors));
  }

  const edges =
    (data.data && data.data.customer && data.data.customer.subscriptionContracts.edges) || [];

  const hasActiveAiPlus = edges.some((edge) => {
    if (edge.node.status !== 'ACTIVE') return false;
    const lineEdges = (edge.node.lines && edge.node.lines.edges) || [];
    return lineEdges.some((lineEdge) => lineEdge.node.productId === AI_PLUS_PRODUCT_ID);
  });

  return hasActiveAiPlus ? 'ai_plus' : 'free';
}

/**
 * @returns {Promise<'free'|'ai_plus'>}
 */
async function getEntitlement(customerId) {
  const key = cacheKey(customerId);
  const cached = await kv.get(key);
  if (cached === 'free' || cached === 'ai_plus') {
    return cached;
  }

  let tier;
  try {
    tier = await fetchEntitlementFromShopify(customerId);
  } catch (err) {
    console.error('entitlement lookup failed, defaulting to free tier', err);
    return 'free';
  }

  await kv.set(key, tier, { ex: CACHE_TTL_SECONDS });
  return tier;
}

module.exports = { getEntitlement, AI_PLUS_PRODUCT_ID };
