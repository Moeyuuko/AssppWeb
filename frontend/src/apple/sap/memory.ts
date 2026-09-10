/** Guest addresses fit in 48 bits, but register values can use all 64 bits. */
export interface GuestMemory {
  map(address: number, size: number): void;
  read(address: number, size: number): Uint8Array;
  write(address: number, bytes: Uint8Array): void;
}

export function integer(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error('Guest address or size exceeds the supported range');
  }
  return number;
}

export function uint64(value: bigint | number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(
    0,
    BigInt.asUintN(64, BigInt(value)),
    true,
  );
  return bytes;
}

export function read64(memory: GuestMemory, address: number): bigint {
  const bytes = memory.read(address, 8);
  return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true);
}

export function read32(memory: GuestMemory, address: number): number {
  const bytes = memory.read(address, 4);
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
}

export function align(value: number, boundary = 16): number {
  return Math.ceil(value / boundary) * boundary;
}
