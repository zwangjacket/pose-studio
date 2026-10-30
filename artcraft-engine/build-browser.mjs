import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { copyFile } from 'node:fs/promises';

const here = fileURLToPath(new URL('.', import.meta.url));
const assets = new URL('../assets/', import.meta.url);
await build({
  absWorkingDir: here,
  entryPoints: ['browser/app.js'],
  outfile: fileURLToPath(new URL('pose-app.js', assets)),
  bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
  minify: true, sourcemap: true, legalComments: 'eof',
});
await copyFile(new URL('upstream/LICENSE-MIT', import.meta.url), new URL('LICENSE-artcraft.txt', assets));
await copyFile(new URL('upstream/NOTICE', import.meta.url), new URL('NOTICE-artcraft.txt', assets));
await copyFile(new URL('node_modules/three/LICENSE', import.meta.url), new URL('LICENSE-three-171.txt', assets));
console.log('Built local pose viewer with Three.js 0.171.0 and pinned ArtCraft controls.');
