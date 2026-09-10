import { Engine } from './engine';
import { MachImage } from './mach-image';
import { align, integer, read32, read64, uint64 } from './memory';
import { HEAP_BASE, HEAP_SIZE, Services } from './services';

export type AssetBundle = Record<
  'CommerceKit' | 'CommerceCore' | 'CoreFP' | 'CoreFP.icxs',
  Uint8Array
>;
const RETURN_ADDRESS = 0x100000000;
const SCRATCH_BASE = 0x300000000000;
const SCRATCH_SIZE = 32 << 20;
const STACK_BASE = 0x500000000000;
const STACK_SIZE = 8 << 20;
const ARGUMENTS = ['RDI', 'RSI', 'RDX', 'RCX', 'R8', 'R9'];

export class Machine {
  private cursor = 0;
  private readonly entry: Record<string, number> = {};

  private constructor(
    private readonly engine: Engine,
    assets: AssetBundle,
  ) {
    for (const [address, size] of [
      [RETURN_ADDRESS, 4096],
      [SCRATCH_BASE, SCRATCH_SIZE],
      [HEAP_BASE, HEAP_SIZE],
      [STACK_BASE, STACK_SIZE],
    ])
      engine.map(address, size);
    engine.write(RETURN_ADDRESS, new Uint8Array([0xf4]));
    // These unusual names are literal exported symbols in Apple's original
    // binaries, not obfuscation of our TypeScript. CommerceKit's ABI maps to:
    // _cp2g1b9ro = initialize, _Mib5yocT = exchange, _Fc3vhtJDvr = sign,
    // _IPaI1oem5iL = destroy context, _jEHf8Xzsv8K = dispose output.
    // The named public methods below keep the actual protocol flow readable.
    const images = [
      {
        image: new MachImage(assets.CoreFP),
        base: 0x100000000000,
        names: [
          '_WIn9UJ86JKdV4dM',
          '_X46O5IeS',
          '_YlCJ3lg',
          '_dku592fbFAj',
          '_fdjkDSAFjklaf2s',
          '_lxpgvVMLd0S7uRl',
        ],
      },
      {
        image: new MachImage(assets.CommerceCore),
        base: 0x100040000000,
        names: ['_get_mac_address'],
      },
      {
        image: new MachImage(assets.CommerceKit),
        base: 0x100080000000,
        names: [
          '_cp2g1b9ro',
          '_Mib5yocT',
          '_Fc3vhtJDvr',
          '_IPaI1oem5iL',
          '_jEHf8Xzsv8K',
        ],
      },
    ];
    const exports = new Map<string, number>();
    for (const { image, base, names } of images) {
      for (const name of names) exports.set(name, image.symbol(name, base));
    }
    const services = new Services(engine, exports, assets['CoreFP.icxs']);
    for (const { image, base } of images)
      image.load(
        engine,
        base,
        (name) => exports.get(name) ?? services.resolve(name),
      );
    this.entry = Object.fromEntries(exports);
  }

  static async create(
    assets: AssetBundle,
    moduleURL?: string,
    options?: Record<string, unknown>,
  ): Promise<Machine> {
    const engine = await Engine.create(moduleURL, options);
    try {
      return new Machine(engine, assets);
    } catch (error) {
      engine.close();
      throw error;
    }
  }

  private scratch(data: Uint8Array): number {
    const address = SCRATCH_BASE + this.cursor;
    this.cursor += align(Math.max(1, data.length));
    if (this.cursor > SCRATCH_SIZE)
      throw new Error('SAP scratch limit exceeded');
    this.engine.write(address, data);
    return address;
  }

  private clear(): void {
    this.engine.write(
      SCRATCH_BASE,
      new Uint8Array(Math.min(this.cursor, SCRATCH_SIZE)),
    );
    this.cursor = 0;
  }

  private hardware(device: string): number {
    if (!/^[a-fA-F0-9]{12}$/.test(device))
      throw new Error('SAP requires a 12-digit hexadecimal device identifier');
    const bytes = new TextEncoder().encode(device);
    const block = new Uint8Array(24);
    new DataView(block.buffer).setUint32(0, bytes.length, true);
    block.set(bytes, 4);
    return this.scratch(block);
  }

  private invoke(name: string, ...args: (number | bigint)[]): void {
    ARGUMENTS.forEach((register, index) =>
      this.engine.setRegister(register, args[index] ?? 0),
    );
    const extra = Math.max(args.length - ARGUMENTS.length, 0);
    let stack = STACK_BASE + STACK_SIZE - (extra + 1) * 8;
    if (stack % 16 !== 8) stack -= 8;
    this.engine.write(stack, uint64(RETURN_ADDRESS));
    for (let i = 0; i < extra; i++)
      this.engine.write(
        stack + (i + 1) * 8,
        uint64(args[i + ARGUMENTS.length]),
      );
    this.engine.setRegister('RSP', stack);
    this.engine.run(this.entry[name], RETURN_ADDRESS);
    const status = Number(BigInt.asIntN(32, this.engine.register('RAX')));
    if (status !== 0)
      throw new Error(`SAP operation ${name} returned ${status}`);
  }

  initialize(device: string): bigint {
    try {
      const context = this.scratch(new Uint8Array(8));
      this.invoke('_cp2g1b9ro', context, this.hardware(device));
      const value = read64(this.engine, context);
      if (!value) throw new Error('SAP returned an empty context');
      return value;
    } finally {
      this.clear();
    }
  }

  private output(pointerField: number, lengthField: number): Uint8Array {
    const pointer = integer(read64(this.engine, pointerField));
    const size = integer(read64(this.engine, lengthField));
    try {
      if (size > 16 << 20 || (size && !pointer))
        throw new Error('Invalid SAP output');
      return size ? this.engine.read(pointer, size) : new Uint8Array();
    } finally {
      if (pointer) this.invoke('_jEHf8Xzsv8K', pointer);
    }
  }

  exchange(
    device: string,
    context: bigint,
    input: Uint8Array,
  ): { state: number; bytes: Uint8Array } {
    try {
      const hardware = this.hardware(device);
      const data = this.scratch(input);
      const pointer = this.scratch(new Uint8Array(8));
      const length = this.scratch(new Uint8Array(8));
      const state = this.scratch(new Uint8Array(4));
      this.invoke(
        '_Mib5yocT',
        200,
        hardware,
        context,
        data,
        input.length,
        pointer,
        length,
        state,
      );
      return {
        state: read32(this.engine, state),
        bytes: this.output(pointer, length),
      };
    } finally {
      this.clear();
    }
  }

  sign(context: bigint, body: Uint8Array): Uint8Array {
    try {
      const data = this.scratch(body);
      const pointer = this.scratch(new Uint8Array(8));
      const length = this.scratch(new Uint8Array(8));
      this.invoke('_Fc3vhtJDvr', context, data, body.length, pointer, length);
      return this.output(pointer, length);
    } finally {
      this.clear();
    }
  }

  close(context?: bigint): void {
    try {
      if (context) this.invoke('_IPaI1oem5iL', context);
    } finally {
      this.clear();
      this.engine.close();
    }
  }
}
