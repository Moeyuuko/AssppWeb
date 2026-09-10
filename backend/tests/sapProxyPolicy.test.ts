import { describe, expect, it } from 'vitest';
import { server as wisp } from '@mercuryworkshop/wisp-js/server';
import '../src/services/wsProxy.js';

describe('SAP Wisp hostname policy', () => {
  const allowed = (host: string) => wisp.options.hostname_whitelist.some(
    (entry: string | RegExp) => typeof entry === 'string' ? entry === host : entry.test(host),
  );

  it('allows only the two exact signing hosts added by this repair', () => {
    expect(allowed('s.mzstatic.com')).toBe(true);
    expect(allowed('fpinit.itunes.apple.com')).toBe(true);
    expect(allowed('other.mzstatic.com')).toBe(false);
    expect(allowed('s.mzstatic.com.example.org')).toBe(false);
    expect(allowed('fpinit.itunes.apple.com.example.org')).toBe(false);
    expect(allowed('127.0.0.1')).toBe(false);
    expect(wisp.options.port_whitelist).toEqual([443]);
    expect(wisp.options.allow_direct_ip).toBe(false);
    expect(wisp.options.allow_loopback_ips).toBe(false);
  });
});
