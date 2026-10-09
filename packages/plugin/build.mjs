import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });

await build({
  entryPoints: ['src/code.ts'],
  bundle: true,
  outfile: 'dist/code.js',
  format: 'iife',
  target: 'es2017',
  logLevel: 'warning',
});

const ui = await build({
  entryPoints: ['src/ui/main.ts'],
  bundle: true,
  write: false,
  format: 'iife',
  target: 'es2020',
  logLevel: 'warning',
});
const script = ui.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = (await readFile('src/ui/ui.html', 'utf8')).replace('<!-- SCRIPT -->', () => `<script>${script}</script>`);
await writeFile('dist/ui.html', html);
console.log('plugin built → dist/code.js, dist/ui.html');
