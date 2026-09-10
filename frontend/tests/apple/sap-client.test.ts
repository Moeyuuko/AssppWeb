import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSigningSession, signAuthBody } from '../../src/apple/sap/client';
import { loadAssets } from '../../src/apple/sap/assets';
import {
  exchangeCertificate,
  fetchCertificate,
} from '../../src/apple/sap/protocol';

vi.mock('../../src/apple/sap/assets', () => ({ loadAssets: vi.fn() }));
vi.mock('../../src/apple/sap/protocol', () => ({
  exchangeCertificate: vi.fn(),
  fetchCertificate: vi.fn(),
}));
const endpoints = {
  version: 200 as const,
  certificateURL: 'https://s.mzstatic.com/sap/setupCert.plist',
  setupURL: 'https://fpinit.itunes.apple.com/v1/signSapSetup/legacy',
};

class TestWorker {
  static instances: TestWorker[] = [];
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  onmessageerror?: () => void;
  messages: { type: string; device?: string; bytes?: Uint8Array }[] = [];
  terminated = false;
  exchanges = 0;
  constructor() {
    TestWorker.instances.push(this);
  }
  postMessage(message: {
    id: number;
    type: string;
    device?: string;
    bytes?: Uint8Array;
  }) {
    this.messages.push(structuredClone(message));
    const reply =
      message.type === 'exchange'
        ? { state: ++this.exchanges === 1 ? 1 : 0, bytes: new Uint8Array([1]) }
        : { bytes: new Uint8Array([1, 2, 3]) };
    queueMicrotask(() =>
      this.onmessage?.({ data: { id: message.id, ...reply } }),
    );
  }
  terminate() {
    this.terminated = true;
  }
}

describe('browser signing session', () => {
  beforeEach(() => {
    TestWorker.instances = [];
    vi.stubGlobal('Worker', TestWorker);
    vi.mocked(loadAssets).mockResolvedValue(
      {} as Awaited<ReturnType<typeof loadAssets>>,
    );
    vi.mocked(fetchCertificate).mockResolvedValue(new Uint8Array([1]));
    vi.mocked(exchangeCertificate).mockResolvedValue(new Uint8Array([2]));
  });
  afterEach(() => {
    clearSigningSession();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reuses the handshake for 2FA but signs each body separately', async () => {
    expect(await signAuthBody('aabbccddeeff', endpoints, 'first')).toBe('AQID');
    expect(await signAuthBody('aabbccddeeff', endpoints, 'second')).toBe(
      'AQID',
    );
    expect(TestWorker.instances).toHaveLength(1);
    const messages = TestWorker.instances[0].messages;
    expect(
      messages.filter((message) => message.type === 'exchange'),
    ).toHaveLength(2);
    expect(
      messages
        .filter((message) => message.type === 'sign')
        .map((message) => new TextDecoder().decode(message.bytes)),
    ).toEqual(['first', 'second']);
  });

  it('serializes simultaneous account switches and destroys the old worker', async () => {
    await Promise.all([
      signAuthBody('aabbccddeeff', endpoints, 'a'),
      signAuthBody('112233445566', endpoints, 'b'),
    ]);
    expect(TestWorker.instances).toHaveLength(2);
    expect(TestWorker.instances[0].terminated).toBe(true);
    expect(
      TestWorker.instances.map((worker) => worker.messages[0].device),
    ).toEqual(['aabbccddeeff', '112233445566']);
  });

  it('discards failed setup so the next attempt can recover', async () => {
    vi.mocked(fetchCertificate).mockRejectedValueOnce(new Error('Offline'));
    await expect(signAuthBody('aabbccddeeff', endpoints, 'a')).rejects.toThrow(
      'Offline',
    );
    expect(TestWorker.instances[0].terminated).toBe(true);
    await expect(signAuthBody('aabbccddeeff', endpoints, 'b')).resolves.toBe(
      'AQID',
    );
  });

  it('terminates a worker that stops responding', async () => {
    vi.useFakeTimers();
    vi.spyOn(TestWorker.prototype, 'postMessage').mockImplementation(() => {});
    const result = expect(
      signAuthBody('aabbccddeeff', endpoints, 'a'),
    ).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(180001);
    await result;
    expect(TestWorker.instances[0].terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up a failed postMessage without leaving a deadline behind', async () => {
    vi.useFakeTimers();
    vi.spyOn(TestWorker.prototype, 'postMessage').mockImplementation(() => {
      throw new Error('Clone failed');
    });
    await expect(signAuthBody('aabbccddeeff', endpoints, 'a')).rejects.toThrow(
      'stopped',
    );
    expect(TestWorker.instances[0].terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
