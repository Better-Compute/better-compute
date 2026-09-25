// Renders the Better Compute mark (components/logo.tsx) into every favicon and app icon the docs site serves.
// Run it after changing the mark: `node apps/docs/scripts/generate-icons.mjs`. The outputs are committed.
//
//   favicon.ico            16, 32, 48 px ink tiles, for browsers and tools without SVG favicon support
//   icon.svg               the bare mark, ink on light tabs and white on dark ones (prefers-color-scheme)
//   apple-touch-icon.png   180 px, full bleed (iOS rounds the corners itself)
//   icon-192.png, icon-512.png, icon-maskable-512.png   web app manifest icons (app/manifest.ts)
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
// sharp ships with Next.js for image optimization; resolve it through next instead of adding a dependency.
const sharp = createRequire(createRequire(join(app, 'package.json')).resolve('next/package.json'))(
  'sharp',
);

/**
 * `logoMarkPath` from components/logo.tsx: a chip with three pins a side, its die window cut out and the die left
 * standing, on a 24 px grid, spanning 1.75 to 22.25 on both axes.
 */
const mark =
  'M7.25 5.25H7.75V1.75H9.25V5.25H11.25V1.75H12.75V5.25H14.75V1.75H16.25V5.25H16.75A2 2 0 0 1 18.75 7.25V7.75H22.25V9.25H18.75V11.25H22.25V12.75H18.75V14.75H22.25V16.25H18.75V16.75A2 2 0 0 1 16.75 18.75H16.25V22.25H14.75V18.75H12.75V22.25H11.25V18.75H9.25V22.25H7.75V18.75H7.25A2 2 0 0 1 5.25 16.75V16.25H1.75V14.75H5.25V12.75H1.75V11.25H5.25V9.25H1.75V7.75H5.25V7.25A2 2 0 0 1 7.25 5.25ZM9.25 8.25A1 1 0 0 0 8.25 9.25V14.75A1 1 0 0 0 9.25 15.75H14.75A1 1 0 0 0 15.75 14.75V9.25A1 1 0 0 0 14.75 8.25H9.25ZM10.75 10.25A.5 .5 0 0 0 10.25 10.75V13.25A.5 .5 0 0 0 10.75 13.75H13.25A.5 .5 0 0 0 13.75 13.25V10.75A.5 .5 0 0 0 13.25 10.25H10.75Z';
const markHeight = 20.5;
const ink = '#121212';
const paper = '#fafafa';

/** The mark centered on a square ink tile. `fill` is the mark's height as a share of the tile; `radius` rounds the corners. */
function tile(size, { fill, radius = 0 }) {
  const scale = (size * fill) / markHeight;
  const offset = size / 2 - 12 * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${size * radius}" fill="${ink}"/>
  <path transform="translate(${offset} ${offset}) scale(${scale})" fill="${paper}" fill-rule="evenodd" d="${mark}"/>
</svg>`;
}

const png = (svg) => sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();

/** An ICO container holding PNG images, which every browser since IE 11 and Windows Vista reads. */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, index) => {
    const entry = 6 + 16 * index;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

// The chip is square and reaches the edges of its box (the shield it replaced was narrower), so it fills a little
// less of each tile. Small sizes still get a larger mark so the die window survives at 16 px.
const favicon = ico(
  await Promise.all(
    [
      [16, 0.8],
      [32, 0.74],
      [48, 0.7],
    ].map(async ([size, fill]) => ({ size, data: await png(tile(size, { fill, radius: 0.22 })) })),
  ),
);

const adaptiveSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="1.5 1.5 21 21">
  <style>path{fill:${ink}}@media (prefers-color-scheme:dark){path{fill:${paper}}}</style>
  <path fill-rule="evenodd" d="${mark}"/>
</svg>
`;

const files = {
  'favicon.ico': favicon,
  'icon.svg': adaptiveSvg,
  'apple-touch-icon.png': await png(tile(180, { fill: 0.56 })),
  'icon-192.png': await png(tile(192, { fill: 0.58, radius: 0.22 })),
  'icon-512.png': await png(tile(512, { fill: 0.58, radius: 0.22 })),
  // Maskable icons are cropped to a circle as small as 80% of the width; the mark's corners stay inside it.
  'icon-maskable-512.png': await png(tile(512, { fill: 0.5 })),
};

// Only the docs site: the console (apps/console) draws its own icons.
const dir = join(app, 'public');
await mkdir(dir, { recursive: true });
for (const [name, data] of Object.entries(files)) await writeFile(join(dir, name), data);
console.log(`${dir}: ${Object.keys(files).join(', ')}`);
