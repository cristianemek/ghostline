// Build script. No flags: extension bundle (dev). --production: minified.
// --tests: bundles test/unit/*.test.ts into out/test. --scripts: bundles scripts/*.ts into out/scripts.
import { build, context } from 'esbuild';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const flags = new Set(process.argv.slice(2));
const production = flags.has('--production');

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  logLevel: 'info',
};

function entries(dir, suffix) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(suffix))
    .map((name) => join(dir, name));
}

if (flags.has('--tests')) {
  rmSync('out/test', { recursive: true, force: true });
  await build({ ...common, entryPoints: entries('test/unit', '.test.ts'), outdir: 'out/test', sourcemap: 'inline' });
} else if (flags.has('--scripts')) {
  await build({ ...common, entryPoints: entries('scripts', '.ts'), outdir: 'out/scripts' });
} else {
  const options = {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    minify: production,
    sourcemap: !production,
  };
  if (flags.has('--watch')) {
    const ctx = await context(options);
    await ctx.watch();
  } else {
    await build(options);
  }
}
