import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Prevent a green CI run on the historical UI-TARS fork or on a toolchain-only branch.
const required = [
  'docs/REQUIREMENTS.json',
  'src/core/model.ts',
  'native/Cargo.toml',
  'native/crates/host/src/lib.rs',
  'native/tools/economy/go.mod',
  'native/tools/economy/research.go',
  'assistant/src/live-events.js',
];
const missing = required.filter(path => !existsSync(join(process.cwd(), path)));
if (missing.length) {
  console.error(`Platform Studio source is incomplete. Missing:\n${missing.join('\n')}`);
  process.exit(2);
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (pkg.name !== 'platform-studio' || !pkg.version.startsWith('0.5.')) {
  console.error(`Unexpected project identity: ${pkg.name}@${pkg.version}`);
  process.exit(2);
}
console.log(`Verified ${pkg.name}@${pkg.version} source identity and ${required.length} required paths.`);
