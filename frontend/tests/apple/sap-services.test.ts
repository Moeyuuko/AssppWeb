import { describe, expect, it } from 'vitest';
import { Services } from '../../src/apple/sap/services';
import type { Engine } from '../../src/apple/sap/engine';

describe('SAP guest services', () => {
  it('does not restart the device iterator while looking up a parent', () => {
    const registers = new Map<string, bigint>();
    let dispatch: (address: number) => void = () => {};
    const writes: { address: number; bytes: Uint8Array }[] = [];
    const engine = {
      map: () => {},
      write: (address: number, bytes: Uint8Array) =>
        writes.push({ address, bytes: bytes.slice() }),
      register: (name: string) => registers.get(name) ?? 0n,
      setRegister: (name: string, value: bigint | number) =>
        registers.set(name, BigInt(value)),
      hook: (_start: number, _end: number, callback: typeof dispatch) => {
        dispatch = callback;
      },
    } as unknown as Engine;
    const services = new Services(engine, new Map(), new Uint8Array());
    const call = (name: string) => {
      dispatch(services.resolve(name));
      return registers.get('RAX');
    };
    registers.set('RDX', 4096n);
    call('_IOServiceGetMatchingServices');
    expect(call('_IOIteratorNext')).toBe(1n);
    call('_IORegistryEntryGetParentEntry');
    expect(call('_IOIteratorNext')).toBe(0n);
    expect(writes.at(-1)).toEqual({
      address: 4096,
      bytes: new Uint8Array([255, 255, 255, 255]),
    });
    call('_IOServiceGetMatchingServices');
    expect(call('_IOIteratorNext')).toBe(1n);
    expect(() => call('_unknown_service')).toThrow('Unsupported guest import');
  });
});
