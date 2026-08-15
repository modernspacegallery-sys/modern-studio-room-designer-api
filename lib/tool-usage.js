// Lightweight, store-wide usage counters for the Môdern Studio AI tools.
// This answers "which tool do customers use the most" — separate from the
// per-customer free-design limit tracked in usage-store.js (that one is
// about entitlement, this one is about aggregate popularity).

const { kv } = require('@vercel/kv');

const VALID_TOOLS = new Set(['room-designer', 'mood-board']);

function todayKey() {
  // YYYY-MM-DD, UTC — good enough for a simple daily breakdown.
  return new Date().toISOString().slice(0, 10);
}

async function recordToolUse(tool) {
  if (!VALID_TOOLS.has(tool)) return;
  const day = todayKey();
  try {
    await Promise.all([
      kv.incr(`toolusage:${tool}:total`),
      kv.incr(`toolusage:${tool}:day:${day}`),
    ]);
  } catch (err) {
    // Tracking is best-effort — never let a counting failure break the
    // actual feature (a redesign, a mood board) that triggered it.
    console.error('recordToolUse failed', tool, err);
  }
}

async function getToolUsageStats() {
  const tools = Array.from(VALID_TOOLS);
  const day = todayKey();
  const [totals, todays] = await Promise.all([
    Promise.all(tools.map((t) => kv.get(`toolusage:${t}:total`))),
    Promise.all(tools.map((t) => kv.get(`toolusage:${t}:day:${day}`))),
  ]);

  const result = { today: day, tools: {} };
  tools.forEach((t, i) => {
    result.tools[t] = {
      total: Number(totals[i]) || 0,
      today: Number(todays[i]) || 0,
    };
  });
  return result;
}

module.exports = { recordToolUse, getToolUsageStats, VALID_TOOLS };
