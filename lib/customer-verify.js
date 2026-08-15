// Verifies that a client-supplied customerId corresponds to a real Shopify
// customer, before trusting it for usage tracking or entitlement checks.
//
// This does NOT fully close the trust gap described in usage-store.js and
// entitlement.js — it doesn't prove the request actually came from that
// customer. What it DOES stop: the trivial version of abuse where a script
// walks through arbitrary/incrementing numeric IDs to generate an endless
// stream of "fresh" free-tier allowances. Requiring a real, existing
// customer ID meaningfully raises the bar for that, even though a targeted
// attacker who already knows another real customer's exact ID could still
// pass that check. The complete fix is a Shopify App Proxy signed request
// (or Customer Account API token) so the theme can't lie about who's
// logged in at all — that requires deploying a config change through
// Shopify's CLI to this app, which is a separate follow-up project.

const { kv } = require('@vercel/kv');

const STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || 'modernspacegallery.myshopify.com';
const ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
const API_VERSION = '2025-01';

const CACHE_TTL_SECONDS = 86400; // 24 hours — customer existence rarely changes

const QUERY = `
  query CustomerExists($id: ID!) {
    customer(id: $id) {
      id
    }
  }
`;

function cacheKey(customerId) {
  return `custexists:${customerId}`;
}

/**
 * @returns {Promise<boolean>}
 */
async function customerExists(customerId) {
  const key = cacheKey(customerId);
  const cached = await kv.get(key);
  if (cached === 'yes' || cached === 'no') {
    return cached === 'yes';
  }

  if (!ACCESS_TOKEN) {
    console.error('SHOPIFY_ADMIN_ACCESS_TOKEN is not set — cannot verify customer, failing closed.');
    return false;
  }

  let exists = false;
  try {
    const res = await fetch(`https://${STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': ACCESS_TOKEN,
      },
      body: JSON.stringify({
        query: QUERY,
        variables: { id: `gid://shopify/Customer/${customerId}` },
      }),
    });

    if (!res.ok) {
      throw new Error(`Shopify Admin API responded ${res.status}`);
    }

    const data = await res.json();
    if (data.errors) {
      throw new Error('Shopify Admin API returned errors: ' + JSON.stringify(data.errors));
    }

    exists = Boolean(data.data && data.data.customer && data.data.customer.id);
  } catch (err) {
    console.error('customer existence check failed', err);
    // Fail closed: if Shopify is unreachable, don't grant access on the
    // strength of an ID we couldn't actually verify.
    return false;
  }

  await kv.set(key, exists ? 'yes' : 'no', { ex: CACHE_TTL_SECONDS });
  return exists;
}

module.exports = { customerExists };
