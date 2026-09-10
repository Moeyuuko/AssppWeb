import { Machine } from './machine';
import type { AssetBundle } from './machine';

export type WorkerRequest =
  | { id: number; type: 'open'; device: string; assets: AssetBundle }
  | { id: number; type: 'exchange'; bytes: Uint8Array }
  | { id: number; type: 'sign'; bytes: Uint8Array };
export interface WorkerReply {
  id: number;
  bytes?: Uint8Array;
  state?: number;
  error?: string;
}

let machine: Machine | undefined;
let context: bigint | undefined;
let device = '';
let sequence = Promise.resolve();

async function handle(request: WorkerRequest): Promise<void> {
  try {
    let result: WorkerReply = { id: request.id };
    if (request.type === 'open') {
      if (machine) throw new Error('SAP worker already initialized');
      device = request.device;
      machine = await Machine.create(request.assets);
      context = machine.initialize(device);
    } else {
      if (!machine || !context)
        throw new Error('SAP worker is not initialized');
      if (request.bytes.length > 1 << 20)
        throw new Error('SAP input exceeds limit');
      try {
        result =
          request.type === 'sign'
            ? { id: request.id, bytes: machine.sign(context, request.bytes) }
            : {
                id: request.id,
                ...machine.exchange(device, context, request.bytes),
              };
      } finally {
        request.bytes.fill(0);
      }
    }
    self.postMessage(result);
  } catch {
    // Never serialize arbitrary emulator errors across the worker boundary:
    // it handles body bytes which include passwords, cookies, and 2FA codes.
    self.postMessage({
      id: request.id,
      error: 'The local Apple signing component failed',
    });
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  sequence = sequence.then(() => handle(event.data));
};
