// Minimal guest OS services required by Apple's pinned signing components.
// There is no host filesystem, network, environment, or credential access.
// Protocol behavior follows ipatool's MIT-licensed machine/shim_*.go.
import { align, integer, read32, read64, uint64 } from './memory';
import type { Engine } from './engine';

export const HEAP_BASE = 0x400000000000;
export const HEAP_SIZE = 64 << 20;
const SERVICE_BASE = 0x200000000000;
const SERVICE_SIZE = 1 << 20;
const MAX_TRANSFER = 64 << 20;
const ARGUMENTS = ['RDI', 'RSI', 'RDX', 'RCX', 'R8', 'R9'];
const MINUS_ONE = 0xffffffffffffffffn;

interface Allocation {
  address: number;
  size: number;
}

export class Services {
  private readonly symbols = new Map<string, number>();
  private readonly handlers = new Map<number, () => bigint | number>();
  private readonly allocations = new Map<number, number>();
  private freeBlocks: Allocation[] = [];
  private heapCursor = 0;
  private serviceCursor = 0;
  private iterator = 0;
  private fileOffset = 0;

  constructor(
    private readonly engine: Engine,
    private readonly exports: Map<string, number>,
    private readonly icxs: Uint8Array,
  ) {
    engine.map(SERVICE_BASE, SERVICE_SIZE);
    this.memoryServices();
    this.platformServices();
    engine.hook(SERVICE_BASE, SERVICE_BASE + SERVICE_SIZE - 1, (address) => {
      const handler = this.handlers.get(address);
      if (!handler) throw new Error('Unknown guest service');
      engine.setRegister('RAX', handler());
      // Every service stub contains RET; pthread_once can push an initializer
      // ahead of the normal return address, matching the native reference.
    });
  }

  resolve(name: string): number {
    if (!this.symbols.has(name)) {
      // Mach-O contains imports for unused code paths. Resolve to a trap;
      // invoking an unsupported service must fail, never silently succeed.
      this.add([name], () => {
        throw new Error(`Unsupported guest import: ${name}`);
      });
    }
    return this.symbols.get(name)!;
  }

  private add(names: string[], handler: () => bigint | number): void {
    const address = this.data(new Uint8Array([0xc3]));
    this.handlers.set(address, handler);
    for (const name of names) this.symbols.set(name, address);
  }

  private data(bytes: Uint8Array): number {
    const address = SERVICE_BASE + this.serviceCursor;
    this.serviceCursor += align(bytes.length);
    if (this.serviceCursor > SERVICE_SIZE)
      throw new Error('Guest service space exhausted');
    this.engine.write(address, bytes);
    return address;
  }

  private argument(index: number): number {
    return integer(BigInt.asUintN(64, this.engine.register(ARGUMENTS[index])));
  }
  private size(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TRANSFER)
      throw new Error('Guest transfer exceeds limit');
    return value;
  }

  private string(address: number, limit = 65536): string {
    const bytes: number[] = [];
    for (let offset = 0; offset < limit; ) {
      const chunk = this.engine.read(
        address + offset,
        Math.min(4096 - ((address + offset) % 4096), limit - offset),
      );
      for (const byte of chunk) {
        if (!byte) return new TextDecoder().decode(new Uint8Array(bytes));
        bytes.push(byte);
      }
      offset += chunk.length;
    }
    throw new Error('Unterminated guest string');
  }

  private allocate(size: number): number {
    const reserved = align(Math.max(this.size(size), 1));
    const blockIndex = this.freeBlocks.findIndex(
      (block) => block.size >= reserved,
    );
    let address: number;
    if (blockIndex >= 0) {
      const block = this.freeBlocks[blockIndex];
      address = block.address;
      block.address += reserved;
      block.size -= reserved;
      if (!block.size) this.freeBlocks.splice(blockIndex, 1);
    } else {
      if (this.heapCursor + reserved > HEAP_SIZE)
        throw new Error('Guest heap exhausted');
      address = HEAP_BASE + this.heapCursor;
      this.heapCursor += reserved;
    }
    this.allocations.set(address, reserved);
    return address;
  }

  private release(address: number): number {
    if (!address) return 0;
    const size = this.allocations.get(address);
    if (size === undefined) throw new Error('Guest freed an unknown pointer');
    this.engine.write(address, new Uint8Array(size));
    this.allocations.delete(address);
    this.freeBlocks.push({ address, size });
    this.freeBlocks.sort((a, b) => a.address - b.address);
    const merged: Allocation[] = [];
    for (const block of this.freeBlocks) {
      const previous = merged[merged.length - 1];
      if (previous && previous.address + previous.size === block.address)
        previous.size += block.size;
      else merged.push(block);
    }
    this.freeBlocks = merged;
    return 0;
  }

  private memoryServices(): void {
    const a = (index: number) => this.argument(index);
    this.add(['_malloc'], () => this.allocate(a(0)));
    this.add(['_malloc_good_size'], () => align(Math.max(this.size(a(0)), 1)));
    this.add(['_malloc_size'], () => this.allocations.get(a(0)) ?? 0);
    this.add(['_free'], () => this.release(a(0)));
    this.add(['_calloc'], () => {
      const size = this.size(a(0) * a(1));
      const address = this.allocate(size);
      this.engine.write(address, new Uint8Array(size));
      return address;
    });
    this.add(['_realloc', '_reallocf'], () => {
      const old = a(0);
      const size = this.size(a(1));
      if (!old) return this.allocate(size);
      const previous = this.allocations.get(old);
      if (previous === undefined)
        throw new Error('Guest reallocated unknown pointer');
      if (size <= previous) return old;
      const address = this.allocate(size);
      this.engine.write(address, this.engine.read(old, previous));
      this.release(old);
      return address;
    });
    const copy = () => {
      this.engine.write(a(0), this.engine.read(a(1), this.size(a(2))));
      return a(0);
    };
    const fill = () => {
      this.engine.write(a(0), new Uint8Array(this.size(a(2))).fill(a(1) & 255));
      return a(0);
    };
    this.add(['_memcpy', '_memmove'], copy);
    this.add(['_memset'], fill);
    this.add(['___bzero'], () => {
      this.engine.write(a(0), new Uint8Array(this.size(a(1))));
      return 0;
    });
    this.add(['___memcpy_chk'], () => {
      if (a(2) > a(3)) throw new Error('Guest copy overflow');
      return copy();
    });
    this.add(['___memset_chk'], () => {
      if (a(2) > a(3)) throw new Error('Guest fill overflow');
      return fill();
    });
    this.add(
      ['_strlen'],
      () => new TextEncoder().encode(this.string(a(0))).length,
    );
    this.add(['_strcmp'], () => {
      const left = this.string(a(0));
      const right = this.string(a(1));
      return left < right ? -1 : left > right ? 1 : 0;
    });
    const compare = (strings: boolean) => {
      const length = this.size(a(2));
      for (let offset = 0; offset < length; ) {
        const count = Math.min(
          length - offset,
          4096 - ((a(0) + offset) % 4096),
          4096 - ((a(1) + offset) % 4096),
        );
        const left = this.engine.read(a(0) + offset, count);
        const right = this.engine.read(a(1) + offset, count);
        for (let i = 0; i < count; i++) {
          if (left[i] !== right[i]) return left[i] - right[i];
          if (strings && !left[i]) return 0;
        }
        offset += count;
      }
      return 0;
    };
    this.add(['_memcmp'], () => compare(false));
    this.add(['_strncmp'], () => compare(true));
  }

  private platformServices(): void {
    const a = (index: number) => this.argument(index);
    this.add(
      [
        '_CFBundleGetMainBundle',
        '_CFDataGetBytePtr',
        '_CFDataGetLength',
        '_CFStringGetLength',
        '_CFStringGetMaximumSizeForEncoding',
        '_CFUUIDCreateString',
        '_IORegistryEntryFromPath',
        '_IORegistryEntrySearchCFProperty',
        '_IOServiceMatching',
        '_getenv',
        '_pthread_self',
        '_CFRelease',
        '_IOObjectRelease',
        '_close',
        '_close$UNIX2003',
        '_pthread_mutex_lock',
        '_pthread_mutex_unlock',
        '_pthread_rwlock_init',
        '_pthread_rwlock_init$UNIX2003',
        '_pthread_rwlock_unlock',
        '_pthread_rwlock_unlock$UNIX2003',
        '_pthread_rwlock_wrlock',
        '_pthread_rwlock_wrlock$UNIX2003',
        '_CFStringCreateWithCStringNoCopy',
      ],
      () => 0,
    );
    this.add(
      [
        '_CFDictionaryGetValue',
        '_DADiskCopyDescription',
        '_DADiskCreateFromBSDName',
        '_DASessionCreate',
        '_IORegistryEntryCreateCFProperty',
      ],
      () => MINUS_ONE,
    );
    this.add(
      [
        '_fcntl',
        '_fcntl$UNIX2003',
        '_lstat$INODE64',
        '_statfs',
        '_statfs$INODE64',
        '_sysctl',
      ],
      () => MINUS_ONE,
    );
    this.add(['_IOServiceGetMatchingService'], () => 0xffffffff);
    this.add(['_CFStringCreateWithCString'], () =>
      ['IOPlatformSerialNumber', 'IOPlatformUUID', 'board-id'].includes(
        this.string(a(1)),
      )
        ? MINUS_ONE
        : 0,
    );
    this.add(['_CFStringGetCString'], () => {
      if (!a(1) || !a(2)) return 0;
      this.engine.write(a(1), new Uint8Array(1));
      return 1;
    });
    this.add(['_IOIteratorNext'], () => ++this.iterator % 2);
    this.add(['_IORegistryEntryGetParentEntry'], () => {
      this.engine.write(a(2), new Uint8Array([255, 255, 255, 255]));
      return 0;
    });
    this.add(['_IOServiceGetMatchingServices'], () => {
      this.engine.write(a(2), new Uint8Array([255, 255, 255, 255]));
      this.iterator = 0;
      return 0;
    });
    this.add(['_OSAtomicCompareAndSwap32Barrier'], () => {
      if (read32(this.engine, a(2)) !== a(0) >>> 0) return 0;
      this.engine.write(a(2), uint64(a(1)).subarray(0, 4));
      return 1;
    });
    const errno = this.data(new Uint8Array(8));
    this.add(['___error'], () => errno);
    this.symbols.set(
      '___stack_chk_guard',
      this.data(
        new Uint8Array([0xa5, 0x71, 0x3c, 0xd9, 0x86, 0x42, 0xef, 0x10]),
      ),
    );
    for (const name of [
      '_kCFAllocatorDefault',
      '_kCFAllocatorNull',
      '_kDADiskDescriptionVolumeUUIDKey',
      '_kIOMasterPortDefault',
    ]) {
      this.symbols.set(name, this.data(new Uint8Array(8)));
    }
    this.add(['_abort', '___stack_chk_fail', 'dyld_stub_binder'], () => {
      throw new Error('Apple signing component aborted');
    });
    this.add(
      ['_arc4random'],
      () => crypto.getRandomValues(new Uint32Array(1))[0],
    );
    this.add(['_dlopen'], () =>
      this.string(a(0)) ===
      '/System/Library/PrivateFrameworks/CoreFP.framework/CoreFP'
        ? MINUS_ONE
        : 0,
    );
    this.add(['_dlsym'], () => this.exports.get(`_${this.string(a(1))}`) ?? 0);
    this.add(['_gettimeofday'], () => {
      const now = Date.now();
      if (a(0)) {
        const bytes = new Uint8Array(16);
        const view = new DataView(bytes.buffer);
        view.setBigUint64(0, BigInt(Math.floor(now / 1000)), true);
        view.setUint32(8, (now % 1000) * 1000, true);
        this.engine.write(a(0), bytes);
      }
      if (a(1)) this.engine.write(a(1), new Uint8Array(8));
      return 0;
    });
    this.add(['_objc_msgSend'], () =>
      this.string(a(1)) === 'objectForKey:' ? MINUS_ONE : 0,
    );
    this.add(['_open', '_open$UNIX2003'], () => {
      if (this.string(a(0)) !== './../CoreFP.icxs') return MINUS_ONE;
      this.fileOffset = 0;
      return 3;
    });
    this.add(['_read', '_read$UNIX2003'], () => {
      if (a(0) !== 3) return MINUS_ONE;
      const size = Math.min(
        this.size(a(2)),
        this.icxs.length - this.fileOffset,
      );
      this.engine.write(
        a(1),
        this.icxs.subarray(this.fileOffset, this.fileOffset + size),
      );
      this.fileOffset += size;
      return size;
    });
    this.add(['_sysctlbyname'], () => {
      if (a(2)) this.engine.write(a(2), uint64(0));
      return 0;
    });
    this.add(['_pthread_once'], () => {
      if (read64(this.engine, a(0)) !== 0n) {
        this.engine.write(a(0), uint64(0));
        const stack = integer(this.engine.register('RSP')) - 8;
        this.engine.write(stack, uint64(a(1)));
        this.engine.setRegister('RSP', stack);
      }
      return 0;
    });
  }
}
