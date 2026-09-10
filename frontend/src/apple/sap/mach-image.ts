// Mach-O loader for the pinned Apple x86-64 images. Based on the protocol
// model in ipatool v2.4.0; dyld opcode names follow Apple's loader format.
import { align, integer } from './memory';
import type { GuestMemory } from './memory';

interface Segment {
  name: string;
  address: number;
  size: number;
  offset: number;
  fileSize: number;
}

class Cursor {
  constructor(
    readonly bytes: Uint8Array,
    public position = 0,
  ) {}

  byte(): number {
    if (this.position >= this.bytes.length)
      throw new Error('Truncated dyld stream');
    return this.bytes[this.position++];
  }

  leb(signed = false): bigint {
    let result = 0n;
    let shift = 0n;
    let byte: number;
    do {
      byte = this.byte();
      result |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
      if (shift > 70n) throw new Error('Invalid dyld integer');
    } while (byte & 0x80);
    return signed && byte & 0x40 ? result - (1n << shift) : result;
  }

  string(): string {
    const start = this.position;
    while (this.byte() !== 0) {
      /* NUL-terminated symbol name */
    }
    return new TextDecoder().decode(
      this.bytes.subarray(start, this.position - 1),
    );
  }
}

export function x86Slice(input: Uint8Array): Uint8Array {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const magic = view.getUint32(0);
  if (magic !== 0xcafebabe && magic !== 0xcafebabf) return input.slice();
  const wide = magic === 0xcafebabf;
  const count = view.getUint32(4);
  if (count > 64) throw new Error('Invalid universal image');
  for (let index = 0; index < count; index++) {
    const entry = 8 + index * (wide ? 32 : 20);
    if (view.getUint32(entry) !== 0x01000007) continue;
    const offset = wide
      ? integer(view.getBigUint64(entry + 8))
      : view.getUint32(entry + 8);
    const size = wide
      ? integer(view.getBigUint64(entry + 16))
      : view.getUint32(entry + 12);
    if (offset + size > input.length)
      throw new Error('Truncated universal image');
    return input.slice(offset, offset + size);
  }
  throw new Error('Missing x86-64 image');
}

export class MachImage {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private readonly segments: Segment[] = [];
  private readonly symbols = new Map<string, number>();
  private streams: number[] = [];
  private base = 0;

  constructor(input: Uint8Array) {
    this.bytes = x86Slice(input);
    this.view = new DataView(this.bytes.buffer);
    if (this.u32(0) !== 0xfeedfacf || this.u32(4) !== 0x01000007) {
      throw new Error('Expected little-endian x86-64 Mach-O');
    }
    const commands = this.u32(16);
    const commandsEnd = 32 + this.u32(20);
    this.range(32, commandsEnd - 32);
    let position = 32;
    for (let index = 0; index < commands; index++) {
      const command = this.u32(position);
      const size = this.u32(position + 4);
      if (size < 8 || position + size > commandsEnd)
        throw new Error('Invalid Mach-O command');
      if (command === 0x19) {
        if (size < 72) throw new Error('Truncated segment command');
        const segment: Segment = {
          name: new TextDecoder()
            .decode(this.bytes.subarray(position + 8, position + 24))
            .replace(/\0.*$/, ''),
          address: this.u64(position + 24),
          size: this.u64(position + 32),
          offset: this.u64(position + 40),
          fileSize: this.u64(position + 48),
        };
        this.range(segment.offset, segment.fileSize);
        if (segment.fileSize > segment.size)
          throw new Error('Segment exceeds memory reservation');
        this.segments.push(segment);
      } else if (command === 0x2) {
        if (size < 24) throw new Error('Truncated symbol command');
        const offset = this.u32(position + 8);
        const count = this.u32(position + 12);
        const strings = this.u32(position + 16);
        const stringSize = this.u32(position + 20);
        this.range(offset, count * 16);
        this.range(strings, stringSize);
        for (let symbol = 0; symbol < count; symbol++) {
          const item = offset + symbol * 16;
          const stringOffset = this.u32(item);
          if (!stringOffset || stringOffset >= stringSize) continue;
          const cursor = new Cursor(
            this.bytes.subarray(strings, strings + stringSize),
            stringOffset,
          );
          this.symbols.set(cursor.string(), this.u64(item + 8));
        }
      } else if (command === 0x80000022 || command === 0x22) {
        if (size < 48) throw new Error('Truncated dyld command');
        this.streams = Array.from({ length: 8 }, (_, i) =>
          this.u32(position + 8 + i * 4),
        );
      }
      position += size;
    }
    const text = this.segments.find((segment) => segment.name === '__TEXT');
    if (!text) throw new Error('Missing Mach-O text segment');
    this.base = text.address;
  }

  private range(offset: number, size: number): void {
    if (
      !Number.isSafeInteger(offset + size) ||
      offset < 0 ||
      size < 0 ||
      offset + size > this.bytes.length
    ) {
      throw new Error('Mach-O range exceeds file');
    }
  }

  private u32(offset: number): number {
    return this.view.getUint32(offset, true);
  }
  private u64(offset: number): number {
    return integer(this.view.getBigUint64(offset, true));
  }

  symbol(name: string, loadBase: number): number {
    const value = this.symbols.get(name);
    if (value === undefined || value < this.base)
      throw new Error(`Missing Apple entry point: ${name}`);
    return loadBase + value - this.base;
  }

  load(
    memory: GuestMemory,
    loadBase: number,
    resolve: (name: string) => number,
  ): void {
    let span = 0;
    for (const segment of this.segments) {
      if (segment.name === '__PAGEZERO') continue;
      if (segment.address < this.base)
        throw new Error('Segment precedes image');
      span = Math.max(span, segment.address - this.base + segment.size);
    }
    if (!span || span > 1 << 28) throw new Error('Invalid Apple image size');
    memory.map(loadBase, align(span, 4096));
    for (const segment of this.segments) {
      if (segment.name !== '__PAGEZERO' && segment.fileSize) {
        memory.write(
          loadBase + segment.address - this.base,
          this.bytes.subarray(
            segment.offset,
            segment.offset + segment.fileSize,
          ),
        );
      }
    }
    for (
      let streamIndex = 0;
      streamIndex < this.streams.length;
      streamIndex += 2
    ) {
      const offset = this.streams[streamIndex];
      const size = this.streams[streamIndex + 1];
      this.range(offset, size);
      this.fixups(
        new Cursor(this.bytes.subarray(offset, offset + size)),
        streamIndex === 0,
        streamIndex === 6,
        memory,
        loadBase,
        resolve,
      );
    }
  }

  private fixups(
    cursor: Cursor,
    rebase: boolean,
    lazy: boolean,
    memory: GuestMemory,
    loadBase: number,
    resolve: (name: string) => number,
  ): void {
    let segmentIndex = 0;
    let offset = 0n;
    let type = 1;
    let name = '';
    let addend = 0n;
    const advance = (delta: bigint) => {
      offset = BigInt.asUintN(64, offset + delta);
    };
    const fix = () => {
      const segment = this.segments[segmentIndex];
      const relative = integer(offset);
      if (!segment || relative + 8 > segment.size || type !== 1)
        throw new Error('Invalid dyld pointer fixup');
      // Some weak bindings describe BSS; map() already zeroed this region.
      if (relative + 8 <= segment.fileSize) {
        const value = rebase
          ? this.view.getBigUint64(segment.offset + relative, true) +
            BigInt(loadBase - this.base)
          : BigInt(resolve(name)) + addend;
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setBigUint64(
          0,
          BigInt.asUintN(64, value),
          true,
        );
        memory.write(loadBase + segment.address - this.base + relative, bytes);
      }
      advance(8n);
    };
    const repeat = (count: bigint, skip = 0n) => {
      if (count > 10000000n) throw new Error('Excessive dyld fixups');
      for (let i = 0n; i < count; i++) {
        fix();
        advance(skip);
      }
    };
    while (cursor.position < cursor.bytes.length) {
      const byte = cursor.byte();
      const opcode = byte & 0xf0;
      const immediate = byte & 0xf;
      if (opcode === 0) {
        if (!lazy) return;
        segmentIndex = 0;
        offset = 0n;
        name = '';
        addend = 0n;
        type = 1;
        continue;
      }
      if (rebase) {
        switch (opcode) {
          case 0x10:
            type = immediate;
            break;
          case 0x20:
            segmentIndex = immediate;
            offset = cursor.leb();
            break;
          case 0x30:
            advance(cursor.leb());
            break;
          case 0x40:
            advance(BigInt(immediate * 8));
            break;
          case 0x50:
            repeat(BigInt(immediate));
            break;
          case 0x60:
            repeat(cursor.leb());
            break;
          case 0x70:
            fix();
            advance(cursor.leb());
            break;
          case 0x80: {
            const count = cursor.leb();
            repeat(count, cursor.leb());
            break;
          }
          default:
            throw new Error(`Unsupported dyld rebase opcode ${opcode}`);
        }
      } else {
        switch (opcode) {
          case 0x10:
          case 0x30:
            break; // Library ordinal; all imports use the explicit resolver.
          case 0x20:
            cursor.leb();
            break;
          case 0x40:
            name = cursor.string();
            break;
          case 0x50:
            type = immediate;
            break;
          case 0x60:
            addend = cursor.leb(true);
            break;
          case 0x70:
            segmentIndex = immediate;
            offset = cursor.leb();
            break;
          case 0x80:
            advance(cursor.leb());
            break;
          case 0x90:
            fix();
            break;
          case 0xa0:
            fix();
            advance(cursor.leb());
            break;
          case 0xb0:
            fix();
            advance(BigInt(immediate * 8));
            break;
          case 0xc0: {
            const count = cursor.leb();
            repeat(count, cursor.leb());
            break;
          }
          default:
            throw new Error(`Unsupported dyld bind opcode ${opcode}`);
        }
      }
    }
  }
}
