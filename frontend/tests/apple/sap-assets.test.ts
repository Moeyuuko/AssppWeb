import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyAsset } from '../../src/apple/sap/assets';

describe('SAP asset integrity', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requires both the pinned size and SHA-256', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const bytes = new TextEncoder().encode('abc');
    const spec = { size: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' };
    expect(await verifyAsset(bytes, spec)).toBe(true);
    expect(await verifyAsset(bytes, { ...spec, size: 4 })).toBe(false);
    bytes[0] ^= 1;
    expect(await verifyAsset(bytes, spec)).toBe(false);
  });
});
