// SPDX-License-Identifier: Apache-2.0
// Renders the site's raster images from their SVG sources, for the places that
// will not take SVG: link previews in WhatsApp, iMessage, Slack, X and the like
// read og.png, and iOS and some chat apps use the PNG icons. Chromium draws each
// SVG with the site's own fonts, then sharp writes a palette PNG, so og.png stays
// well under WhatsApp's ~300 KB limit. Run after changing og.svg or favicon.svg:
//   node scripts/render-site-images.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const site = new URL('../site/', import.meta.url).pathname;
const pub = join(site, 'public');
const fonts = join(site, 'node_modules/@fontsource');
// sharp comes with Astro, a dependency of the site.
const sharp = createRequire(createRequire(join(site, 'package.json')).resolve('astro'))('sharp');

// Inlined: a page set with setContent cannot load file:// fonts.
const face = (family, pkg, weight) => {
  const woff2 = readFileSync(join(fonts, pkg, 'files', `${pkg}-latin-${weight}-normal.woff2`));
  return `@font-face{font-family:'${family}';font-weight:${weight};src:url(data:font/woff2;base64,${woff2.toString('base64')})}`;
};
const css = [
  face('Inter', 'inter', 400),
  face('Inter', 'inter', 600),
  face('JetBrains Mono', 'jetbrains-mono', 400),
  face('Pixelify Sans', 'pixelify-sans', 500),
].join('');

/** [source svg, output png, [width, height], full-bleed tile?] */
const jobs = [
  ['og.svg', 'og.png', [1200, 630]],
  ['favicon.svg', 'apple-touch-icon.png', [180, 180], true],
  ['favicon.svg', 'icon-512.png', [512, 512], true],
  ['favicon.svg', 'favicon-32.png', [32, 32]],
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [src, out, [width, height], fill] of jobs) {
  let svg = readFileSync(join(pub, src), 'utf8');
  // Platforms round home-screen icons themselves, so those fill the tile
  // edge to edge instead of leaving transparent corners.
  if (fill) svg = svg.replace(/ rx="[\d.]+"/, '');
  const bg = src === 'og.svg' || fill ? '#060608' : 'transparent';
  await page.setViewportSize({ width, height });
  await page.setContent(
    `<style>${css}html,body{margin:0;background:${bg}}svg{display:block;width:${width}px;height:${height}px}</style>${svg}`,
    { waitUntil: 'load' },
  );
  await page.evaluate(() => document.fonts.ready);
  const shot = await page.screenshot({ omitBackground: bg === 'transparent' });
  const png = await sharp(shot).png({ palette: true, quality: 95, effort: 10 }).toBuffer();
  await sharp(png).toFile(join(pub, out));
  console.log(`${out}: ${width}×${height}, ${(png.length / 1024).toFixed(1)} KB`);
}
await browser.close();
