// CI policy: generated executables never become source inputs to our build.
import { execFileSync } from 'node:child_process';

const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0');
const forbidden = paths.filter(path =>
  path.startsWith('frontend/public/sap-engine/') ||
  path.startsWith('frontend/public/sap-assets/') ||
  (path.startsWith('frontend/src/apple/sap/') && /\.(wasm|mjs|bin)$/.test(path)),
);
if (forbidden.length) {
  throw new Error(`Generated SAP binaries must not be committed: ${forbidden.join(', ')}`);
}
console.log('SAP source-only policy passed');
