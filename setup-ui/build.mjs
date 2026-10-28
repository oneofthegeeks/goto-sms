// Builds dist/index.html: src/index.html with app.ts (bundled by esbuild) and styles.css
// inlined, so the Node package can embed the page as one string with no asset routes.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { build, transform } from 'esbuild';

const src = (f) => new URL(`./src/${f}`, import.meta.url);

const js = await build({
  entryPoints: [src('app.ts').pathname],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  write: false,
  legalComments: 'none',
});
const css = await transform(readFileSync(src('styles.css'), 'utf8'), {
  loader: 'css',
  minify: true,
});

// A literal "</script" or "</style" inside the inlined code would end the element early.
const script = js.outputFiles[0].text.replaceAll('</script', '<\\/script');
const style = css.code.replaceAll('</style', '<\\/style');

const template = readFileSync(src('index.html'), 'utf8');
for (const marker of ['<!-- STYLE -->', '<!-- SCRIPT -->']) {
  if (!template.includes(marker)) throw new Error(`index.html is missing ${marker}`);
}
// Function replacements: a string replacement would expand `$&` etc. inside the code.
const html = template
  .replace('<!-- STYLE -->', () => `<style>${style}</style>`)
  .replace('<!-- SCRIPT -->', () => `<script>${script}</script>`);

mkdirSync(new URL('./dist/', import.meta.url), { recursive: true });
writeFileSync(new URL('./dist/index.html', import.meta.url), html);
