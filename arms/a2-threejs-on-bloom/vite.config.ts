import { defineConfig, type Plugin } from 'vite';
import { rmSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// The asset pack in ./assets is served (and copied into dist/) verbatim as the
// static root, so relative texture URIs inside the .glb files (../textures/*.png)
// resolve exactly as authored. base './' makes the build runnable from any folder.
// ./assets itself is never modified; only the copy in dist/ is pruned of files the
// game does not load at runtime (Blender previews, reports, Ogg duplicates of the WAVs).
function pruneDist(): Plugin {
  let outDir = 'dist';
  return {
    name: 'prune-unused-assets',
    apply: 'build',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      for (const d of ['previews', 'reports']) rmSync(join(outDir, d), { recursive: true, force: true });
      for (const f of ['manifest.schema.json']) rmSync(join(outDir, f), { force: true });
      for (const f of readdirSync(join(outDir, 'audio'))) if (f.endsWith('.ogg')) rmSync(join(outDir, 'audio', f));
    },
  };
}

export default defineConfig({
  base: './',
  publicDir: 'assets',
  build: {
    assetsDir: 'game',
    target: 'es2020',
    chunkSizeWarningLimit: 1200,
  },
  server: { host: true },
  plugins: [pruneDist()],
});
