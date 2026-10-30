import { build } from 'esbuild';
await build({
  entryPoints: ['upstream/engine/KinHelpers/FKHelper.ts', 'upstream/engine/KinHelpers/BoneJSONHelper.ts'],
  outdir: 'dist', bundle: true, platform: 'node', format: 'esm',
  packages: 'external', sourcemap: true,
});
