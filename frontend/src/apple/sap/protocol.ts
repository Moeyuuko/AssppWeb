import { buildPlist, parsePlist } from '../plist';

export interface SapEndpoints {
  certificateURL: string;
  setupURL: string;
  version: 200;
}

export class SapConfigurationError extends Error {}

function endpoint(value: unknown, host: string): string {
  if (typeof value !== 'string')
    throw new SapConfigurationError('Apple SAP endpoint is missing');
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== host ||
    (url.port && url.port !== '443') ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new SapConfigurationError('Unexpected Apple SAP endpoint');
  }
  return url.href;
}

export function sapEndpoints(
  bag: Record<string, unknown>,
): SapEndpoints | undefined {
  const keys = ['sign-sap-version', 'sign-sap-setup', 'sign-sap-setup-cert'];
  if (!keys.some((key) => key in bag)) return undefined;
  if (Number(bag['sign-sap-version']) !== 200)
    throw new SapConfigurationError('Unsupported Apple SAP protocol version');
  try {
    return {
      version: 200,
      certificateURL: endpoint(bag['sign-sap-setup-cert'], 's.mzstatic.com'),
      setupURL: endpoint(bag['sign-sap-setup'], 'fpinit.itunes.apple.com'),
    };
  } catch (error) {
    throw error instanceof SapConfigurationError
      ? error
      : new SapConfigurationError('Invalid Apple SAP endpoint');
  }
}

async function requestBytes(
  urlString: string,
  key: string,
  input?: Uint8Array,
): Promise<Uint8Array> {
  // Bag parsing must not initialize libcurl/WASM as a side effect.
  const { appleRequest } = await import('../request');
  const url = new URL(urlString);
  const response = await appleRequest({
    host: url.hostname,
    path: url.pathname + url.search,
    method: input ? 'POST' : 'GET',
    headers: input ? { 'Content-Type': 'application/x-plist' } : undefined,
    body: input ? buildPlist({ [key]: input }) : undefined,
  });
  if (response.status !== 200 || response.body.length > 1 << 20)
    throw new Error('Apple SAP handshake request failed');
  const bytes = parsePlist(response.body)[key];
  if (!(bytes instanceof Uint8Array) || !bytes.length)
    throw new Error('Apple SAP handshake returned invalid data');
  return bytes;
}

export const fetchCertificate = (endpoints: SapEndpoints) =>
  requestBytes(endpoints.certificateURL, 'sign-sap-setup-cert');
export const exchangeCertificate = (
  endpoints: SapEndpoints,
  bytes: Uint8Array,
) => requestBytes(endpoints.setupURL, 'sign-sap-setup-buffer', bytes);
