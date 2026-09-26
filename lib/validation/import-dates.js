// Phase 6B: date handling for the one-time browser -> cloud import
// (approved design rev3 §4, decision D5).
//
// Principle: keep every date a browser could really have recorded; replace
// only values that cannot be a real past moment written by localStorage.
// A record is NEVER rejected because of a date.
//
//   Band A  2026-08-01T00:00:00Z .. now + 5 min    kept, no note
//   Band B  2008-01-01T00:00:00Z .. < 2026-08-01    kept exactly, note 'earlier_than_expected'
//   Band C  not a finite number, < 2008-01-01,      replaced (fallback chain), with a reason
//           or > now + 5 min
//
// 2026-08-01 is where Projects are EXPECTED to start (theme inventory,
// rev2 §4.1); it is not a validity floor. 2008-01-01 is a technical bound:
// no shipping browser had localStorage before then, so anything earlier is
// a clock/code error (most often 0 / 1970).
//
// `now` is always passed in by the caller (one value per request) so the dry
// run and the real import resolve identically for the same clock, and tests
// can use a fixed clock. In real use, "import time" fallbacks can differ
// between a preview and the later import; the storefront says so.

const EXPECTED_FROM_MS = Date.UTC(2026, 7, 1); // 2026-08-01T00:00:00Z
const POSSIBLE_FROM_MS = Date.UTC(2008, 0, 1); // 2008-01-01T00:00:00Z
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

const LEGACY_ID_TS_RE = /^(?:proj|home)_(\d{13})_\d{1,6}$/;

function band(value, now) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return { band: 'C', reason: 'unreadable' };
  if (value < POSSIBLE_FROM_MS) return { band: 'C', reason: 'unreadable' };
  if (value > now + FUTURE_TOLERANCE_MS) return { band: 'C', reason: 'future' };
  if (value < EXPECTED_FROM_MS) return { band: 'B' };
  return { band: 'A' };
}

function usable(value, now) {
  const b = band(value, now);
  return b.band === 'A' || b.band === 'B';
}

function entry(value, source, extra) {
  const out = { value, source };
  if (extra) Object.assign(out, extra);
  return out;
}

function keptEntry(value, now) {
  const b = band(value, now);
  return b.band === 'B'
    ? entry(value, 'record', { note: 'earlier_than_expected' })
    : entry(value, 'record');
}

function legacyIdTimestamp(legacyId) {
  if (typeof legacyId !== 'string') return null;
  const m = LEGACY_ID_TS_RE.exec(legacyId);
  return m ? Number(m[1]) : null;
}

/**
 * Resolve the stored dates for one imported record.
 *
 * @param {object} p
 * @param {string} p.legacyId         browser id (proj_<ms>_<n> / home_<ms>_<n>)
 * @param {*}      p.createdAt        raw value from the browser record
 * @param {*}      p.updatedAt        raw value from the browser record
 * @param {*}      [p.boardSavedAt]   raw moodBoard.savedAt (Projects only; undefined when no board/savedAt)
 * @param {*}      [p.planSavedAt]    raw spacePlan.savedAt (Projects only)
 * @param {string} [p.datePreference] 'import_time' when the customer opted in (Band B rows)
 * @param {number} p.now              request clock, ms
 * @returns {{createdAt, updatedAt, boardSavedAt?, planSavedAt?}} each {value, source, reason?, note?}
 */
function resolveImportDates(p) {
  const now = p.now;
  let created;
  let updated;

  if (p.datePreference === 'import_time') {
    created = entry(now, 'customer_choice');
    updated = entry(now, 'customer_choice');
  } else {
    // createdAt
    const cb = band(p.createdAt, now);
    if (cb.band === 'A' || cb.band === 'B') {
      created = keptEntry(p.createdAt, now);
    } else {
      const idTs = legacyIdTimestamp(p.legacyId);
      if (idTs !== null && usable(idTs, now)) {
        created = entry(idTs, 'id', { reason: cb.reason });
        if (band(idTs, now).band === 'B') created.note = 'earlier_than_expected';
      } else {
        created = entry(now, 'import', { reason: cb.reason });
      }
    }

    // updatedAt
    const ub = band(p.updatedAt, now);
    if (ub.band === 'A' || ub.band === 'B') {
      if (p.updatedAt >= created.value) {
        updated = keptEntry(p.updatedAt, now);
      } else {
        updated = entry(created.value, 'created', { reason: 'order_fixed' });
      }
    } else {
      const candidates = [p.boardSavedAt, p.planSavedAt].filter(
        (v) => usable(v, now) && v >= created.value
      );
      if (candidates.length) {
        const best = Math.max.apply(null, candidates);
        updated = entry(best, 'saved_date', {
          reason: ub.reason,
          from: best === p.planSavedAt ? 'spacePlan' : 'moodBoard',
        });
      } else {
        updated = entry(created.value, 'created', { reason: ub.reason });
      }
    }
  }

  const out = { createdAt: created, updatedAt: updated };

  // Board / plan savedAt (only when the field exists on the payload).
  for (const key of ['boardSavedAt', 'planSavedAt']) {
    if (p[key] === undefined) continue;
    const sb = band(p[key], now);
    if (sb.band === 'A' || sb.band === 'B') {
      out[key] = keptEntry(p[key], now);
    } else {
      out[key] = entry(updated.value, 'fallback', { reason: sb.reason });
    }
  }

  return out;
}

module.exports = {
  resolveImportDates,
  legacyIdTimestamp,
  EXPECTED_FROM_MS,
  POSSIBLE_FROM_MS,
  FUTURE_TOLERANCE_MS,
};
