/**
 * Minimal CBOR decoder for WebAuthn/passkeys.
 * Decodes ONLY the types strictly present in attestation objects and COSE keys:
 * - Unsigned and negative integers
 * - Byte strings
 * - Text strings
 * - Arrays
 * - Maps
 *
 * Enforces a strict recursion limit and input size limit.
 * Explicitly rejects floats, tags, indefinite lengths, and unknown types.
 */

export class CborError extends Error {
  constructor(message: string) {
    super(`CBOR Decode Error: ${message}`);
    this.name = 'CborError';
  }
}

export function decodeFirst(buffer: Buffer): { value: any; offset: number } {
  if (buffer.length > 4096) {
    throw new CborError('Input exceeds maximum allowed size (4096 bytes)');
  }
  let offset = 0;

  function decodeItem(depth: number): any {
    if (depth > 10) {
      throw new CborError('Maximum recursion depth exceeded');
    }
    if (offset >= buffer.length) {
      throw new CborError('Unexpected end of input');
    }

    const initialByte = buffer[offset++];
    const majorType = initialByte >> 5;
    const additionalInfo = initialByte & 0x1f;

    let length = 0;
    if (additionalInfo < 24) {
      length = additionalInfo;
    } else if (additionalInfo === 24) {
      if (offset + 1 > buffer.length) throw new CborError('Truncated 1-byte length');
      length = buffer.readUInt8(offset);
      offset += 1;
    } else if (additionalInfo === 25) {
      if (offset + 2 > buffer.length) throw new CborError('Truncated 2-byte length');
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (additionalInfo === 26) {
      if (offset + 4 > buffer.length) throw new CborError('Truncated 4-byte length');
      length = buffer.readUInt32BE(offset);
      offset += 4;
    } else if (additionalInfo === 27) {
      if (offset + 8 > buffer.length) throw new CborError('Truncated 8-byte length');
      // For simplicity, we only read up to 53-bit integers safe in JS
      const hi = buffer.readUInt32BE(offset);
      const lo = buffer.readUInt32BE(offset + 4);
      if (hi > 0x001fffff) throw new CborError('Value exceeds safe integer limit');
      length = hi * 0x100000000 + lo;
      offset += 8;
    } else if (additionalInfo === 31) {
      throw new CborError('Indefinite lengths are not supported');
    } else {
      throw new CborError(`Unsupported additional info: ${additionalInfo}`);
    }

    switch (majorType) {
      case 0: // Unsigned integer
        return length;

      case 1: // Negative integer
        return -1 - length;

      case 2: { // Byte string
        if (offset + length > buffer.length) throw new CborError('Truncated byte string');
        const buf = buffer.subarray(offset, offset + length);
        offset += length;
        return Buffer.from(buf); // Copy to ensure safety
      }

      case 3: { // Text string
        if (offset + length > buffer.length) throw new CborError('Truncated text string');
        const str = buffer.toString('utf8', offset, offset + length);
        offset += length;
        return str;
      }

      case 4: { // Array
        const arr = [];
        for (let i = 0; i < length; i++) {
          arr.push(decodeItem(depth + 1));
        }
        return arr;
      }

      case 5: { // Map
        const map = new Map<any, any>();
        for (let i = 0; i < length; i++) {
          const key = decodeItem(depth + 1);
          // Check for duplicate keys. Note: complex keys (buffers/arrays) might not equate properly in JS Map.
          // For WebAuthn, map keys are usually integers or strings.
          if (typeof key === 'string' || typeof key === 'number') {
            if (map.has(key)) throw new CborError('Duplicate map key detected');
          } else {
            // Very simple deep equality check for Map keys just to be safe.
            for (const existingKey of map.keys()) {
              if (Buffer.isBuffer(key) && Buffer.isBuffer(existingKey) && key.equals(existingKey)) {
                throw new CborError('Duplicate map key detected');
              }
            }
          }
          const value = decodeItem(depth + 1);
          map.set(key, value);
        }
        return map;
      }

      default:
        throw new CborError(`Unsupported major type: ${majorType} (Floats, tags, simple values, and unassigned types are rejected)`);
    }
  }

  const result = decodeItem(0);
  return { value: result, offset };
}
