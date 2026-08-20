export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function hex(byte) {
  return byte.toString(16).padStart(2, '0');
}

export function createUuidMinter({ random }) {
  if (typeof random !== 'function') throw new TypeError('createUuidMinter: "random" must be a function');

  return function mint() {
    const bytes = Uint8Array.from(random(16));
    if (bytes.length !== 16) {
      throw new Error(`createUuidMinter: random must return 16 byte(s), got ${bytes.length}`);
    }

    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const parts = [
      bytes.slice(0, 4),
      bytes.slice(4, 6),
      bytes.slice(6, 8),
      bytes.slice(8, 10),
      bytes.slice(10, 16),
    ];
    return parts.map((part) => [...part].map(hex).join('')).join('-');
  };
}
