import manifest from './asset-manifest.json';
import type { AssetBundle } from './machine';

export async function verifyAsset(
  bytes: Uint8Array,
  spec: { size: number; sha256: string },
): Promise<boolean> {
  if (bytes.length !== spec.size) return false;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new Uint8Array(bytes).buffer,
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return hex === spec.sha256;
}

export async function loadAssets(
  progress: (percent: number) => void,
): Promise<AssetBundle> {
  let cache: Cache | undefined;
  try {
    cache = await caches.open('sap-apple-assets-v1');
  } catch {
    /* Private mode may disable storage. */
  }
  const assets = {} as AssetBundle;
  let complete = 0;
  for (const spec of manifest) {
    const url = `/sap-assets/${spec.name}`;
    let bytes: Uint8Array | undefined;
    try {
      const stored = await cache?.match(url);
      if (stored) {
        const candidate = new Uint8Array(await stored.arrayBuffer());
        if (await verifyAsset(candidate, spec)) bytes = candidate;
      }
    } catch {
      /* A broken cache must not prevent a fresh verified download. */
    }
    if (!bytes) {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(120000),
      });
      if (!response.ok || !response.body)
        throw new Error(
          'Signing components are unavailable; rebuild the Docker image',
        );
      const reader = response.body.getReader();
      bytes = new Uint8Array(spec.size);
      let offset = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (offset + value.length > spec.size)
            throw new Error('Signing component exceeds its expected size');
          bytes.set(value, offset);
          offset += value.length;
          progress(
            Math.round(
              ((complete + offset / spec.size) / manifest.length) * 100,
            ),
          );
        }
        if (offset !== spec.size || !(await verifyAsset(bytes, spec)))
          throw new Error('Signing component integrity verification failed');
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      try {
        await cache?.put(url, new Response(new Uint8Array(bytes).buffer));
      } catch {
        /* Caching is optional. */
      }
    }
    assets[spec.name as keyof AssetBundle] = bytes;
    progress(Math.round((++complete / manifest.length) * 100));
  }
  return assets;
}
