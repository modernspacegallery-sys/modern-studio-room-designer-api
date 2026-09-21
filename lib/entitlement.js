// Determines whether a customer has an active Môdern Studio AI+ subscription,
// and if so, the anchor date used to compute their current billing period
// (see lib/credits.js).
//
// Trust note: customerId is verified upstream via lib/verify-customer-token.js
// before this is ever called — this file only answers "does THIS Shopify
// customer ID have an active AI+ subscription," which is safe now that the
// caller's identity is cryptographically confirmed.
//
// Fail-closed by design: if Shopify is unreachable, the token is missing, or
// anything else goes wrong, this treats the customer as free-tier rather than
// silently granting paid access.
//
// Phase 5D controlled test override:
//
// STUDIO_CLOUD_AI_PLUS_TEST_CUSTOMER_IDS may contain a comma-separated list
// of verified Shopify customer IDs that should be treated as AI+ solely for
// controlled development/testing.
//
// This does NOT create a Shopify subscription contract, alter billing, or
// change entitlement for any customer not explicitly listed.
//
// The override is intentionally checked BEFORE the normal KV entitlement
// cache so a previously cached "free" result cannot block the controlled
// test account.

const { kv } = require('@vercel/kv');

const STORE_DOMAIN =
  process.env.SHOPIFY_STORE_DOMAIN ||
  'modernspacegallery.myshopify.com';

const ACCESS_TOKEN =
  process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

const API_VERSION = '2025-01';

const AI_PLUS_PRODUCT_ID =
  'gid://shopify/Product/9720923422963'; // Môdern Studio™ AI+

const CACHE_TTL_SECONDS = 600; // 10 minutes

const QUERY = `
  query CustomerAiPlusStatus($customerId: ID!) {
    customer(id: $customerId) {
      subscriptionContracts(first: 10) {
        edges {
          node {
            status
            createdAt
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

function getTestCustomerIds() {
  return new Set(
    (process.env.STUDIO_CLOUD_AI_PLUS_TEST_CUSTOMER_IDS || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  );
}

function isAiPlusTestCustomer(customerId) {
  if (!customerId) return false;

  return getTestCustomerIds().has(
    String(customerId)
  );
}

function getTestPeriodAnchor() {
  /*
   * The controlled test account needs a stable anchor so downstream AI+
   * credit-period logic can behave normally during testing.
   *
   * This is not a billing date and does not create any Shopify subscription.
   * It is only a deterministic entitlement-period anchor for the scoped
   * development override.
   */
  return '2026-09-01T00:00:00.000Z';
}

async function fetchEntitlementFromShopify(customerId) {
  if (!ACCESS_TOKEN) {
    console.error(
      'SHOPIFY_ADMIN_ACCESS_TOKEN is not set — treating all customers as free tier.'
    );

    return {
      tier: 'free',
      periodAnchor: null
    };
  }

  const res = await fetch(
    `https://${STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': ACCESS_TOKEN
      },
      body: JSON.stringify({
        query: QUERY,
        variables: {
          customerId:
            `gid://shopify/Customer/${customerId}`
        }
      })
    }
  );

  if (!res.ok) {
    throw new Error(
      `Shopify Admin API responded ${res.status}`
    );
  }

  const data = await res.json();

  if (data.errors) {
    throw new Error(
      'Shopify Admin API returned errors: ' +
      JSON.stringify(data.errors)
    );
  }

  const edges =
    (
      data.data &&
      data.data.customer &&
      data.data.customer.subscriptionContracts.edges
    ) || [];

  const activeAiPlusEdge =
    edges.find((edge) => {
      if (
        edge.node.status !== 'ACTIVE'
      ) {
        return false;
      }

      const lineEdges =
        (
          edge.node.lines &&
          edge.node.lines.edges
        ) || [];

      return lineEdges.some(
        (lineEdge) =>
          lineEdge.node.productId ===
          AI_PLUS_PRODUCT_ID
      );
    });

  if (!activeAiPlusEdge) {
    return {
      tier: 'free',
      periodAnchor: null
    };
  }

  return {
    tier: 'ai_plus',
    periodAnchor:
      activeAiPlusEdge.node.createdAt
  };
}

/**
 * @returns {Promise<{
 *   tier: 'free'|'ai_plus',
 *   periodAnchor: string|null
 * }>}
 */
async function getEntitlement(customerId) {
  /*
   * Phase 5D scoped test entitlement.
   *
   * Must happen before the cache lookup so a cached normal Shopify
   * entitlement result cannot override the explicit controlled test list.
   */
  if (isAiPlusTestCustomer(customerId)) {
    return {
      tier: 'ai_plus',
      periodAnchor: getTestPeriodAnchor()
    };
  }

  const key = cacheKey(customerId);

  const cached = await kv.get(key);

  if (
    cached &&
    (
      cached.tier === 'free' ||
      cached.tier === 'ai_plus'
    )
  ) {
    return cached;
  }

  let result;

  try {
    result =
      await fetchEntitlementFromShopify(
        customerId
      );
  } catch (err) {
    console.error(
      'entitlement lookup failed, defaulting to free tier',
      err
    );

    return {
      tier: 'free',
      periodAnchor: null
    };
  }

  await kv.set(
    key,
    result,
    {
      ex: CACHE_TTL_SECONDS
    }
  );

  return result;
}

module.exports = {
  getEntitlement,
  AI_PLUS_PRODUCT_ID
};
