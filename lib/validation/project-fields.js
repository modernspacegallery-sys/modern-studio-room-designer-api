// Field-level validation for Project/Home payloads, per Phase 5B Section C.2.
//
// The `room` allow-list below is not invented for this phase -- it is copied
// verbatim from api/redesign.js's ROOM_RULES/ROOM_LABELS keys, the only
// place in this codebase that already enforces a fixed room vocabulary.
// Reusing it (rather than defining a second, possibly-drifting list) means a
// Project's `room` field always matches a room Room Designer actually knows
// how to redesign.
const ROOM_KEYS = [
  'livingroom',
  'bedroom',
  'kitchen',
  'bathroom',
  'diningroom',
  'homeoffice',
  'outdoor',
];

// Mood Board uses its own existing room recipe keys in the storefront.
// These are intentionally preserved inside moodBoard.room so a saved board
// can be reopened in the Mood Board tool exactly as it was created.
//
// This is separate from the Project-level `room` field above. The Project
// continues to use the canonical backend room vocabulary.
const MOOD_BOARD_ROOM_KEYS = [
  'bedroom-collection',
  'living-room-collection',
  'kitchen-collection',
  'bathroom-collection',
  'office-furniture',
  'outdoor-furniture',
];

const MAX_NAME_LENGTH = 200;
const MAX_ROOM_LABEL_LENGTH = 80;
const MAX_MOOD_BOARD_INSPIRATION = 3;
const MAX_INSPIRATION_TITLE_LENGTH = 300;
const MAX_INSPIRATION_URL_LENGTH = 2000;
const MAX_TIMESTAMP = 1000000000000000;

class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

function requireNonEmptyString(value, field, maxLength) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${field} must be a non-empty string.`, field);
  }

  if (maxLength && value.length > maxLength) {
    throw new ValidationError(
      `${field} must be ${maxLength} characters or fewer.`,
      field
    );
  }

  return value.trim();
}

function validateRoom(value) {
  if (typeof value !== 'string' || !ROOM_KEYS.includes(value)) {
    throw new ValidationError(
      `room must be one of: ${ROOM_KEYS.join(', ')}.`,
      'room'
    );
  }

  return value;
}

function validateMoodBoardRoom(value) {
  if (
    typeof value !== 'string' ||
    !MOOD_BOARD_ROOM_KEYS.includes(value)
  ) {
    throw new ValidationError(
      `moodBoard.room must be one of: ${MOOD_BOARD_ROOM_KEYS.join(', ')}.`,
      'moodBoard.room'
    );
  }

  return value;
}

function validateOptionalString(value, field, maxLength) {
  if (value === undefined || value === null) return null;

  if (typeof value !== 'string') {
    throw new ValidationError(
      `${field} must be a string if provided.`,
      field
    );
  }

  if (maxLength && value.length > maxLength) {
    throw new ValidationError(
      `${field} must be ${maxLength} characters or fewer.`,
      field
    );
  }

  return value;
}

// Mood Board / Space Plan payloads are stored as JSONB, but "opaque" does
// not mean "unvalidated" -- Phase 5B Section C.2 requires field-by-field
// validation against each payload's known shape before storage.
//
// Phase 5D extends Mood Board validation only enough to preserve the fields
// the existing storefront Mood Board already creates and later consumes:
// room, style, colors, inspiration, and savedAt. Existing materials and
// productIds support is preserved unchanged.

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// Shared by moodBoard.savedAt and (Phase 5D) spacePlan.savedAt -- same
// bound, same shape, only the field name in the error message differs.
function validateTimestamp(value, field) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_TIMESTAMP
  ) {
    throw new ValidationError(
      `${field} must be a valid numeric timestamp.`,
      field
    );
  }

  return value;
}

function validateMoodBoardTimestamp(value) {
  return validateTimestamp(value, 'moodBoard.savedAt');
}

function validateMoodBoardInspiration(value) {
  if (!Array.isArray(value) || value.length > MAX_MOOD_BOARD_INSPIRATION) {
    throw new ValidationError(
      `moodBoard.inspiration must be an array of at most ${MAX_MOOD_BOARD_INSPIRATION} items.`,
      'moodBoard.inspiration'
    );
  }

  return value.map((item, i) => {
    if (
      typeof item !== 'object' ||
      item === null ||
      Array.isArray(item)
    ) {
      throw new ValidationError(
        `moodBoard.inspiration[${i}] must be an object.`,
        'moodBoard.inspiration'
      );
    }

    const cleaned = {
      title: requireNonEmptyString(
        item.title,
        `moodBoard.inspiration[${i}].title`,
        MAX_INSPIRATION_TITLE_LENGTH
      ),
      url: requireNonEmptyString(
        item.url,
        `moodBoard.inspiration[${i}].url`,
        MAX_INSPIRATION_URL_LENGTH
      ),
    };

    if (item.image !== undefined && item.image !== null && item.image !== '') {
      cleaned.image = requireNonEmptyString(
        item.image,
        `moodBoard.inspiration[${i}].image`,
        MAX_INSPIRATION_URL_LENGTH
      );
    }

    return cleaned;
  });
}

function validateMoodBoard(value) {
  if (value === undefined || value === null) return null;

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(
      'moodBoard must be an object if provided.',
      'moodBoard'
    );
  }

  const out = {};

  if (value.room !== undefined) {
    out.room = validateMoodBoardRoom(value.room);
  }

  if (value.style !== undefined) {
    out.style = requireNonEmptyString(
      value.style,
      'moodBoard.style',
      60
    );
  }

  if (value.colors !== undefined) {
    if (!Array.isArray(value.colors) || value.colors.length > 12) {
      throw new ValidationError(
        'moodBoard.colors must be an array of at most 12 items.',
        'moodBoard.colors'
      );
    }

    out.colors = value.colors.map((c, i) => {
      if (typeof c !== 'string' || !HEX_COLOR_RE.test(c)) {
        throw new ValidationError(
          `moodBoard.colors[${i}] must be a hex color like #A1B2C3.`,
          'moodBoard.colors'
        );
      }

      return c.toUpperCase();
    });
  }

  if (value.inspiration !== undefined) {
    out.inspiration = validateMoodBoardInspiration(
      value.inspiration
    );
  }

  if (value.savedAt !== undefined) {
    out.savedAt = validateMoodBoardTimestamp(
      value.savedAt
    );
  }

  if (value.materials !== undefined) {
    if (
      !Array.isArray(value.materials) ||
      value.materials.length > 20
    ) {
      throw new ValidationError(
        'moodBoard.materials must be an array of at most 20 items.',
        'moodBoard.materials'
      );
    }

    out.materials = value.materials.map((m, i) =>
      requireNonEmptyString(
        m,
        `moodBoard.materials[${i}]`,
        60
      )
    );
  }

  if (value.productIds !== undefined) {
    if (
      !Array.isArray(value.productIds) ||
      value.productIds.length > 100
    ) {
      throw new ValidationError(
        'moodBoard.productIds must be an array of at most 100 items.',
        'moodBoard.productIds'
      );
    }

    out.productIds = value.productIds.map((p, i) =>
      requireNonEmptyString(
        String(p),
        `moodBoard.productIds[${i}]`,
        100
      )
    );
  }

  return out;
}

const MAX_DIMENSION_INCHES = 100000;
// Sanity bound only, not a real-world limit -- rejects garbage/overflow,
// not unusual rooms.

// Phase 5D: Space Planner's own dimension inputs are in FEET, not inches
// (spacePlan.length / spacePlan.width, as distinct from the pre-existing
// spacePlan.roomWidthIn / spacePlan.roomLengthIn, which stay in inches and
// are untouched below). This is a separate sanity bound only, for the same
// reason as MAX_DIMENSION_INCHES -- not a real-world room-size limit.
const MAX_ROOM_DIMENSION_FEET = 1000;

const MAX_SPACE_PLAN_OWNED_ITEM_NAME_LENGTH = 120;
const MAX_SPACE_PLAN_OWNED_ITEMS = 20;

const BED_SIZE_VALUES = ['twin', 'full', 'queen', 'king', 'cal-king'];

// `max` defaults to the original inches bound so every existing call site
// (roomWidthIn, roomLengthIn, items[].widthIn/depthIn) is unaffected.
function validatePositiveNumber(value, field, max = MAX_DIMENSION_INCHES) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > max
  ) {
    throw new ValidationError(
      `${field} must be a positive, finite number.`,
      field
    );
  }

  return value;
}

// Space Planner's `collection` field reuses the same MOOD_BOARD_ROOM_KEYS
// list Mood Board's `room` field already validates against.
function validateSpacePlanCollection(value) {
  if (typeof value !== 'string' || !MOOD_BOARD_ROOM_KEYS.includes(value)) {
    throw new ValidationError(
      `spacePlan.collection must be one of: ${MOOD_BOARD_ROOM_KEYS.join(', ')}.`,
      'spacePlan.collection'
    );
  }

  return value;
}

function validateBedSize(value) {
  if (value === undefined || value === null) return null;

  if (typeof value !== 'string' || !BED_SIZE_VALUES.includes(value)) {
    throw new ValidationError(
      `spacePlan.bedSize must be one of: ${BED_SIZE_VALUES.join(', ')}.`,
      'spacePlan.bedSize'
    );
  }

  return value;
}

function validateSpacePlanOwnedItems(value) {
  if (!Array.isArray(value) || value.length > MAX_SPACE_PLAN_OWNED_ITEMS) {
    throw new ValidationError(
      `spacePlan.ownedItems must be an array of at most ${MAX_SPACE_PLAN_OWNED_ITEMS} items.`,
      'spacePlan.ownedItems'
    );
  }

  return value.map((item, i) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new ValidationError(
        `spacePlan.ownedItems[${i}] must be an object.`,
        'spacePlan.ownedItems'
      );
    }

    return {
      name: requireNonEmptyString(
        item.name,
        `spacePlan.ownedItems[${i}].name`,
        MAX_SPACE_PLAN_OWNED_ITEM_NAME_LENGTH
      ),
      w: validatePositiveNumber(
        item.w,
        `spacePlan.ownedItems[${i}].w`
      ),
      d: validatePositiveNumber(
        item.d,
        `spacePlan.ownedItems[${i}].d`
      ),
    };
  });
}

function validateSpacePlan(value) {
  if (value === undefined || value === null) return null;

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(
      'spacePlan must be an object if provided.',
      'spacePlan'
    );
  }

  const out = {};

  if (value.roomWidthIn !== undefined) {
    out.roomWidthIn = validatePositiveNumber(
      value.roomWidthIn,
      'spacePlan.roomWidthIn'
    );
  }

  if (value.roomLengthIn !== undefined) {
    out.roomLengthIn = validatePositiveNumber(
      value.roomLengthIn,
      'spacePlan.roomLengthIn'
    );
  }

  if (value.items !== undefined) {
    if (!Array.isArray(value.items) || value.items.length > 200) {
      throw new ValidationError(
        'spacePlan.items must be an array of at most 200 items.',
        'spacePlan.items'
      );
    }

    out.items = value.items.map((item, i) => {
      if (typeof item !== 'object' || item === null) {
        throw new ValidationError(
          `spacePlan.items[${i}] must be an object.`,
          'spacePlan.items'
        );
      }

      const cleaned = {};

      if (item.productId !== undefined) {
        cleaned.productId = requireNonEmptyString(
          String(item.productId),
          `spacePlan.items[${i}].productId`,
          100
        );
      }

      if (item.widthIn !== undefined) {
        cleaned.widthIn = validatePositiveNumber(
          item.widthIn,
          `spacePlan.items[${i}].widthIn`
        );
      }

      if (item.depthIn !== undefined) {
        cleaned.depthIn = validatePositiveNumber(
          item.depthIn,
          `spacePlan.items[${i}].depthIn`
        );
      }

      if (item.x !== undefined) {
        if (
          typeof item.x !== 'number' ||
          !Number.isFinite(item.x)
        ) {
          throw new ValidationError(
            `spacePlan.items[${i}].x must be a finite number.`,
            'spacePlan.items'
          );
        }

        cleaned.x = item.x;
      }

      if (item.y !== undefined) {
        if (
          typeof item.y !== 'number' ||
          !Number.isFinite(item.y)
        ) {
          throw new ValidationError(
            `spacePlan.items[${i}].y must be a finite number.`,
            'spacePlan.items'
          );
        }

        cleaned.y = item.y;
      }

      return cleaned;
    });
  }

  // Phase 5D extends spacePlan validation only enough to preserve the
  // fields the existing storefront Space Planner already creates and later
  // consumes (collection, roomLabel, length, width, bedSize, ownedItems,
  // savedAt) -- the same "extend, don't invent" approach already used for
  // moodBoard above. roomWidthIn/roomLengthIn/items (validated above) are
  // untouched and keep accepting exactly what they did before.

  if (value.collection !== undefined) {
    out.collection = validateSpacePlanCollection(value.collection);
  }

  if (value.roomLabel !== undefined) {
    out.roomLabel = requireNonEmptyString(
      value.roomLabel,
      'spacePlan.roomLabel',
      MAX_ROOM_LABEL_LENGTH
    );
  }

  if (value.length !== undefined) {
    out.length = validatePositiveNumber(
      value.length,
      'spacePlan.length',
      MAX_ROOM_DIMENSION_FEET
    );
  }

  if (value.width !== undefined) {
    out.width = validatePositiveNumber(
      value.width,
      'spacePlan.width',
      MAX_ROOM_DIMENSION_FEET
    );
  }

  if (value.bedSize !== undefined) {
    out.bedSize = validateBedSize(value.bedSize);
  }

  if (value.ownedItems !== undefined) {
    out.ownedItems = validateSpacePlanOwnedItems(value.ownedItems);
  }

  if (value.savedAt !== undefined) {
    out.savedAt = validateTimestamp(value.savedAt, 'spacePlan.savedAt');
  }

  return out;
}

/**
 * Validates and normalizes a create/update payload for a Project. Throws
 * ValidationError on anything invalid. Returns only the fields this layer
 * recognizes -- anything else on the input object is silently dropped, never
 * stored (this is what keeps clientLegacyId/customerId/id/version from ever
 * being settable through the general payload path).
 */
function validateProjectInput(input, { partial = false } = {}) {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input)
  ) {
    throw new ValidationError(
      'Request body must be a JSON object.',
      null
    );
  }

  const out = {};

  if (!partial || input.name !== undefined) {
    out.name = requireNonEmptyString(
      input.name,
      'name',
      MAX_NAME_LENGTH
    );
  }

  if (!partial || input.room !== undefined) {
    out.room = validateRoom(input.room);
  }

  if (input.roomLabel !== undefined) {
    out.roomLabel = validateOptionalString(
      input.roomLabel,
      'roomLabel',
      MAX_ROOM_LABEL_LENGTH
    );
  }

  if (input.moodBoard !== undefined) {
    out.moodBoard = validateMoodBoard(
      input.moodBoard
    );
  }

  if (input.spacePlan !== undefined) {
    out.spacePlan = validateSpacePlan(
      input.spacePlan
    );
  }

  return out;
}

function validateHomeInput(input, { partial = false } = {}) {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input)
  ) {
    throw new ValidationError(
      'Request body must be a JSON object.',
      null
    );
  }

  const out = {};

  if (!partial || input.name !== undefined) {
    out.name = requireNonEmptyString(
      input.name,
      'name',
      MAX_NAME_LENGTH
    );
  }

  return out;
}

module.exports = {
  ValidationError,
  ROOM_KEYS,
  validateProjectInput,
  validateHomeInput,
  requireNonEmptyString,
  validateOptionalString,
};
