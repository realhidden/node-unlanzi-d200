/**
 * Cached animation demo — preloads all frames once, then animates
 * with tiny manifest-only ZIPs (~1 packet per frame).
 *
 * Usage: npx ts-node examples/cached-animation.ts [path-to.gif]
 */

import { UlanziD200, setDebugLevel } from '../src';
import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';

setDebugLevel('basic');

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

async function generateRainbowFrame(hue: number): Promise<Buffer> {
  const size = UlanziD200.ICON_SIZE;
  const [r, g, b] = hslToRgb(hue, 1, 0.5);
  const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  const svg = `
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${size}" height="${size}" fill="${hex}" rx="20"/>
      <text x="${size/2}" y="${size/2}" text-anchor="middle" dominant-baseline="central"
            font-family="sans-serif" font-size="20" fill="white" font-weight="bold">
        ${Math.round(hue)}°
      </text>
    </svg>`;
  return sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
}

async function extractGifFrames(gifPath: string): Promise<Buffer[]> {
  const input = sharp(gifPath, { animated: true });
  const metadata = await input.metadata();
  const pages = metadata.pages ?? 1;
  console.log(`GIF: ${pages} frames, ${metadata.width}x${metadata.height}`);

  const frames: Buffer[] = [];
  for (let i = 0; i < pages; i++) {
    frames.push(
      await sharp(gifPath, { page: i })
        .resize(UlanziD200.ICON_SIZE, UlanziD200.ICON_SIZE, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 1 },
        })
        .png()
        .toBuffer(),
    );
  }
  return frames;
}

async function main() {
  console.log('Connecting to Ulanzi D200...');
  const deck = UlanziD200.open();

  process.on('SIGINT', () => {
    console.log('\nStopping...');
    deck.close();
    process.exit(0);
  });

  deck.setBrightness(80);
  deck.postTransferDelayMs = 10;
  deck.batchDelayMs = 5;

  // ── Step 1: Generate all frames ──────────────────────────
  const frameCount = 24;
  const allImages: Record<string, Buffer> = {};

  // Load GIF or generate rainbow
  const gifArg = process.argv[2];
  let frameNames: string[];

  if (gifArg) {
    const gifPath = path.resolve(gifArg);
    console.log(`Loading GIF: ${gifPath}`);
    const gifFrames = await extractGifFrames(gifPath);
    frameNames = gifFrames.map((_, i) => `frame_${i}.png`);
    for (let i = 0; i < gifFrames.length; i++) {
      allImages[frameNames[i]] = gifFrames[i];
    }
  } else {
    console.log(`Generating ${frameCount} rainbow frames...`);
    frameNames = [];
    for (let i = 0; i < frameCount; i++) {
      const name = `rainbow_${i}.png`;
      frameNames.push(name);
      allImages[name] = await generateRainbowFrame((i / frameCount) * 360);
    }
  }

  console.log(`Generated ${frameNames.length} frames`);

  // ── Step 2: Preload all frames to device cache ───────────
  console.log('Preloading images to device cache...');
  const t0 = Date.now();
  await deck.preloadImages(allImages);
  console.log(`Preloaded in ${Date.now() - t0}ms`);

  // ── Step 3: Animate all 13 buttons using cached refs ─────
  console.log('Starting cached animation on all 13 buttons...');
  const stagger = Math.max(1, Math.floor(frameNames.length / 13));
  for (let i = 0; i < 13; i++) {
    const offset = (i * stagger) % frameNames.length;
    const shifted = [...frameNames.slice(offset), ...frameNames.slice(0, offset)];
    deck.animateCached(i, shifted, 15);
  }

  console.log('All 13 buttons animating with cached frames!');
  console.log('Each frame is now a ~200 byte manifest-only ZIP.\n');

  deck.startPolling();
  deck.on('press', (index) => {
    console.log(`Button ${index} pressed — stopping its animation`);
    deck.stopAnimation(index);
  });

  console.log('Press any button to stop its animation. Ctrl+C to exit.\n');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
