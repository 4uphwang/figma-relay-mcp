import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/index.cjs',
  external: ['bufferutil', 'utf-8-validate'],
  define: { __BUILD__: String(Date.now()) }, // 허브가 옛 빌드면 클라이언트가 다시 띄운다
  logLevel: 'warning',
});
console.log('server built → dist/index.cjs');
