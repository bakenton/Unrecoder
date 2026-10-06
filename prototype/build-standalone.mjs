// Builds prototype/unrecoder-standalone.html: one file with CSS, code and content inlined,
// so it opens by double-click (no server, no file:// module restrictions).
// Usage: node build-standalone.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, p), 'utf8');

const engine = read('src/core/engine.js').replace(/^export /gm, '');
const main = read('src/main.js').replace(/^import[\s\S]*?from '\.\/core\/engine\.js';\n/, '');
const act = JSON.stringify(JSON.parse(read('../content/campaign/act1.json')));

const script = `window.__ACT__ = ${act};\n${engine}\n${main}`;

const html = read('index.html')
  .replace('<link rel="stylesheet" href="style.css">', () => `<style>\n${read('style.css')}\n</style>`)
  .replace('<script type="module" src="src/main.js"></script>', () => `<script type="module">\n${script}\n</script>`);

writeFileSync(resolve(here, 'unrecoder-standalone.html'), html);
console.log(`Wrote unrecoder-standalone.html (${Math.round(html.length / 1024)} KB)`);
