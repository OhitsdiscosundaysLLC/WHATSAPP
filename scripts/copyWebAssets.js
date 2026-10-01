// Copies the dashboard's static HTML/CSS/JS into dist/ after `tsc` builds,
// since tsc only compiles .ts files. Not needed for `npm run dev` (tsx runs
// src/ directly, where these assets already live next to the route files).
const fs = require('fs');
const path = require('path');

const pairs = [
  ['src/web/public', 'dist/web/public'],
  ['src/web/views', 'dist/web/views'],
];

for (const [from, to] of pairs) {
  const src = path.join(__dirname, '..', from);
  const dest = path.join(__dirname, '..', to);
  fs.cpSync(src, dest, { recursive: true });
  console.log(`Copied ${from} -> ${to}`);
}
