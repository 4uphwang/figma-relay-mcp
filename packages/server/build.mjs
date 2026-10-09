import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/index.cjs',
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'warning',
});
console.log('server built → dist/index.cjs');
