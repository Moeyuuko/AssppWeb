import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPlist } from '../../src/apple/plist';
import { appleRequest } from '../../src/apple/request';
import {
  exchangeCertificate,
  fetchCertificate,
  sapEndpoints,
} from '../../src/apple/sap/protocol';

vi.mock('../../src/apple/request', () => ({ appleRequest: vi.fn() }));
const settings = {
  'sign-sap-version': 200,
  'sign-sap-setup': 'https://fpinit.itunes.apple.com/v1/signSapSetup/legacy',
  'sign-sap-setup-cert': 'https://s.mzstatic.com/sap/setupCert.plist',
};

describe('SAP configuration and transport', () => {
  beforeEach(() => vi.resetAllMocks());

  it('accepts the advertised Apple protocol and distinguishes a legacy bag', () => {
    expect(sapEndpoints({})).toBeUndefined();
    expect(sapEndpoints(settings)).toEqual({
      version: 200,
      setupURL: settings['sign-sap-setup'],
      certificateURL: settings['sign-sap-setup-cert'],
    });
  });

  it.each([
    { ...settings, 'sign-sap-version': 201 },
    { ...settings, 'sign-sap-setup-cert': undefined },
    { ...settings, 'sign-sap-setup': 'http://fpinit.itunes.apple.com/setup' },
    {
      ...settings,
      'sign-sap-setup': 'https://fpinit.itunes.apple.com.evil.example/setup',
    },
    {
      ...settings,
      'sign-sap-setup': 'https://fpinit.itunes.apple.com:8443/setup',
    },
    {
      ...settings,
      'sign-sap-setup': 'https://user@fpinit.itunes.apple.com/setup',
    },
  ])(
    'rejects unsupported or malformed SAP settings without unsigned fallback',
    (bag) => {
      expect(() => sapEndpoints(bag)).toThrow();
    },
  );

  it('performs binary plist exchange only through browser Apple transport', async () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    vi.mocked(appleRequest).mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: {},
      rawHeaders: [],
      body: buildPlist({ 'sign-sap-setup-buffer': bytes }),
    });
    expect(await exchangeCertificate(sapEndpoints(settings)!, bytes)).toEqual(
      bytes,
    );
    const request = vi.mocked(appleRequest).mock.calls[0][0];
    expect(request.host).toBe('fpinit.itunes.apple.com');
    expect(request.body).toContain('<data>AAF/gP8=</data>');
    expect(request.cookies).toBeUndefined();
  });

  it('rejects failed certificate requests and missing binary values', async () => {
    const response = {
      status: 403,
      statusText: 'Forbidden',
      headers: {},
      rawHeaders: [],
      body: '',
    };
    vi.mocked(appleRequest).mockResolvedValue(response);
    await expect(fetchCertificate(sapEndpoints(settings)!)).rejects.toThrow();
    vi.mocked(appleRequest).mockResolvedValue({
      ...response,
      status: 200,
      body: buildPlist({ 'sign-sap-setup-cert': 'not binary' }),
    });
    await expect(fetchCertificate(sapEndpoints(settings)!)).rejects.toThrow();
  });
});
