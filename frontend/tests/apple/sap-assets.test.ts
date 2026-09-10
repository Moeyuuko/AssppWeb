import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyAsset } from '../../src/apple/sap/assets';

const abcHash = Uint8Array.from(
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'.match(/../g)!,
  (hex) => Number.parseInt(hex, 16),
);

describe('SAP asset integrity', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requires both the pinned size and SHA-256', async () => {
    const digest = vi.fn(async (_algorithm: string, input: ArrayBuffer) => {
      const text = new TextDecoder().decode(new Uint8Array(input));
      return (text === 'abc' ? abcHash : new Uint8Array(32)).buffer;
    });
    // jsdom owns its ArrayBuffer realm while node:crypto owns another. A small
    // browser-shaped mock keeps this unit test focused on our size/hash policy;
    // browser integration uses the platform's native Web Crypto implementation.
    vi.stubGlobal('crypto', { subtle: { digest } });
    const bytes = new TextEncoder().encode('abc');
    const spec = { size: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' };
    expect(await verifyAsset(bytes, spec)).toBe(true);
    expect(await verifyAsset(bytes, { ...spec, size: 4 })).toBe(false);
    bytes[0] ^= 1;
    expect(await verifyAsset(bytes, spec)).toBe(false);
    expect(digest).toHaveBeenCalledTimes(2);
  });
});
