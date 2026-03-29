#!/usr/bin/env node
/**
 * Copies sql.js browser assets from node_modules into lib/ for the extension.
 * Run after: npm install  (or: npm run setup)
 */
const { copyFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const dist = join(root, 'node_modules', 'sql.js', 'dist');

const pairs = [
  ['sql-wasm.js', join(root, 'lib', 'sql-wasm.js')],
  ['sql-wasm.wasm', join(root, 'lib', 'sql-wasm.wasm')],
];

mkdirSync(join(root, 'lib'), { recursive: true });

for (const [name, dest] of pairs) {
  copyFileSync(join(dist, name), dest);
  console.log(`Copied ${name} -> lib/`);
}
