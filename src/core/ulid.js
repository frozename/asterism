const ALPHABET = Object.freeze('0123456789ABCDEFGHJKMNPQRSTVWXYZ'.split(''));

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const TIME_CHARS = 10;
const RANDOM_BYTES = 10;

function encodeTime(ms) {
  let remaining = ms;
  const chars = new Array(TIME_CHARS);
  for (let index = TIME_CHARS - 1; index >= 0; index -= 1) {
    const mod = remaining % 32;
    chars[index] = ALPHABET[mod];
    remaining = (remaining - mod) / 32;
  }
  return chars.join('');
}

function encodeBytes(bytes) {
  let output = '';
  let bitBuffer = 0;
  let bitCount = 0;

  for (const byte of bytes) {
    bitBuffer = (bitBuffer << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      output += ALPHABET[(bitBuffer >> bitCount) & 0x1f];
    }
    bitBuffer &= (1 << bitCount) - 1;
  }

  if (bitCount > 0) {
    output += ALPHABET[(bitBuffer << (5 - bitCount)) & 0x1f];
  }

  return output;
}

// Increments the 80-bit big-endian random component by one, carrying across
// byte boundaries, so a clock regression still yields a strictly increasing
// id sourced at the previous timestamp.
function incrementRandom(bytes) {
  const next = Uint8Array.from(bytes);
  for (let index = next.length - 1; index >= 0; index -= 1) {
    if (next[index] === 0xff) {
      next[index] = 0;
    } else {
      next[index] += 1;
      return next;
    }
  }
  throw new Error('ulid: random component overflowed on a monotonic increment');
}

export function createUlidMinter({ now, random }) {
  if (typeof now !== 'function') throw new TypeError('createUlidMinter: "now" must be a function');
  if (typeof random !== 'function') throw new TypeError('createUlidMinter: "random" must be a function');

  let lastMs = null;
  let lastRandom = null;

  return function mint() {
    let ms = now();
    let randomBytes;

    if (lastMs !== null && ms <= lastMs) {
      ms = lastMs;
      randomBytes = incrementRandom(lastRandom);
    } else {
      randomBytes = random(RANDOM_BYTES);
    }

    lastMs = ms;
    lastRandom = randomBytes;

    return encodeTime(ms) + encodeBytes(randomBytes);
  };
}
