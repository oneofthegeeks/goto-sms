import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  entry: ['src/index.ts', 'src/testing.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  // import.meta.url in CJS output (express.ts loads express lazily via createRequire).
  shims: true,
  define: { __VERSION__: JSON.stringify(pkg.version) },
});
