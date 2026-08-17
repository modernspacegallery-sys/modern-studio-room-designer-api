// Credit-based usage tracking for Môdern Studio™ AI+ subscribers.
//
// Free-tier customers are NOT tracked here — they use the simple lifetime
// counter in usage-store.js (2 free designs total, no monthly reset), per
// spec: free tier is a one-time trial, not a recurring allowance. AI+
// subscribers get 20 credits that reset every billing cycle, tracked here.
//
// Costs per operation are configurable via env vars rather than hardcoded,
// so a future "advanced generation = 2 credits" doesn't require touching
// every call site — just add an entry to CREDIT_COSTS and reference its key.

const { kv } = require('@vercel/kv');

const AI_PLUS_MONTHLY_CREDITS = parseInt(process.env.AI_PLUS_MONTHLY_CREDITS || '20', 10);

const CREDIT_COSTS = {
  standard_redesign: parseInt(process.env.CREDIT_COST_STANDARD_REDESIGN || '1', 10),
  // Future operation types go here, e.g.:
  // advanced_redesign: parseInt(process.env.CREDIT_COST_ADVANCED_REDESIGN || '2', 10),
  // mood_board_refine: parseInt(process.env.CREDIT_COST_MOOD_BOARD_REFINE || '1', 10),
};

function costOf(operationType) {
  const cost = CREDIT_COSTS[operationType];
  if (!cost || cost < 1) {
    console.error(`Unknown or invalid operationType "${operationType}" — defaulting cost to 1.`);
    return 1;
  }
  return cost;
}

// Computes the start of the customer's CURRENT billing period, anchored to
// when their subscription contract was created, advancing by whole months
// from there — rather than resetting on the 1st of the calendar month,
// which wouldn't match what they're actually being billed for.
function computePeriodStart(contractCreatedAt) {
  const anchor = new Date(contractCreatedAt);
  const now = new Date();

  let periodStart = new Date(anchor);
  while (true) {
    const next = new Date(periodStart);
    next.setUTCMonth(next.getUTCMonth() + 1);
    if (next > now) break;
    periodStart = next;
  }
  return periodStart.toISOString().slice(0, 10); // YYYY-MM-DD, stable KV key
}

// Human-usable "credits reset on" date — one month after the current period start.
function computeNextReset(periodStart) {
  const d = new Date(periodStart + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

function creditsKey(customerId, periodStart) {
  return `credits:${customerId}:${periodStart}`;
}

async function getCreditsRemaining(customerId, periodStart) {
  const used = (await kv.get(creditsKey(customerId, periodStart))) || 0;
  return Math.max(0, AI_PLUS_MONTHLY_CREDITS - used);
}

async function spendCredits(customerId, periodStart, operationType) {
  const cost = costOf(operationType);
  const used = await kv.incrby(creditsKey(customerId, periodStart), cost);
  return { remaining: Math.max(0, AI_PLUS_MONTHLY_CREDITS - used), cost };
}

module.exports = {
  AI_PLUS_MONTHLY_CREDITS,
  CREDIT_COSTS,
  computePeriodStart,
  computeNextReset,
  getCreditsRemaining,
  spendCredits,
};
