import { describe, expect, it, vi } from 'vitest';
import { MachImage, x86Slice } from '../../src/apple/sap/mach-image';

function image(): Uint8Array {
  const bytes = new Uint8Array(256);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0xfeedfacf, true);
  view.setUint32(4, 0x01000007, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, 72, true);
  view.setUint32(32, 0x19, true);
  view.setUint32(36, 72, true);
  bytes.set(new TextEncoder().encode('__TEXT'), 40);
  view.setBigUint64(56, 0x1000n, true);
  view.setBigUint64(64, 4096n, true);
  view.setBigUint64(80, 256n, true);
  return bytes;
}

describe('SAP Mach-O loader bounds', () => {
  it('maps a valid image at the requested guest address', () => {
    const bytes = image();
    const memory = { map: vi.fn(), write: vi.fn(), read: vi.fn() };
    new MachImage(bytes).load(memory, 0x2000, () => 0);
    expect(memory.map).toHaveBeenCalledWith(0x2000, 4096);
    expect(memory.write).toHaveBeenCalledWith(0x2000, bytes);
  });

  it('rejects a command crossing its declared load-command region', () => {
    const bytes = image();
    new DataView(bytes.buffer).setUint32(36, 80, true);
    expect(() => new MachImage(bytes)).toThrow('Invalid Mach-O command');
  });

  it('rejects a segment outside the file', () => {
    const bytes = image();
    new DataView(bytes.buffer).setBigUint64(80, 257n, true);
    expect(() => new MachImage(bytes)).toThrow('range exceeds file');
  });

  it('rejects excessive guest memory before mapping', () => {
    const bytes = image();
    new DataView(bytes.buffer).setBigUint64(64, 0x20000000n, true);
    const memory = { map: vi.fn(), write: vi.fn(), read: vi.fn() };
    expect(() => new MachImage(bytes).load(memory, 0x2000, () => 0)).toThrow(
      'image size',
    );
    expect(memory.map).not.toHaveBeenCalled();
  });

  it('rejects a universal slice extending beyond the input', () => {
    const bytes = new Uint8Array(28);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0xcafebabe);
    view.setUint32(4, 1);
    view.setUint32(8, 0x01000007);
    view.setUint32(16, 28);
    view.setUint32(20, 1);
    expect(() => x86Slice(bytes)).toThrow('Truncated universal image');
  });
});
