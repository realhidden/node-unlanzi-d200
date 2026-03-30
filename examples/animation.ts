/**
 * Animation demo — cycles rainbow colors on a button.
 *
 * Usage: npx ts-node examples/animation.ts
 *
 * Shows how to use animateButton() to display animated content.
 * For GIF support, extract frames with sharp and pass them in.
 */

import { UlanziD200 } from '../src';
import sharp from 'sharp';
import * as fs from 'fs';
import * as path from 'path';

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

  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

async function generateRainbowFrames(count: number): Promise<Buffer[]> {
  const size = UlanziD200.ICON_SIZE;
  const frames: Buffer[] = [];

  for (let i = 0; i < count; i++) {
    const hue = (i / count) * 360;
    const [r, g, b] = hslToRgb(hue, 1, 0.5);
    const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;

    const svg = `
      <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${size}" height="${size}" fill="${hex}" rx="20"/>
        <text x="${size/2}" y="${size/2}" text-anchor="middle" dominant-baseline="central"
              font-family="sans-serif" font-size="20" fill="white" font-weight="bold">
          ${Math.round(hue)}°
        </text>
      </svg>
    `;

    frames.push(await sharp(Buffer.from(svg)).resize(size, size).png().toBuffer());
  }

  return frames;
}

/**
 * Extract frames from an animated GIF file.
 */
async function extractGifFrames(gifPath: string): Promise<Buffer[]> {
  const input = sharp(gifPath, { animated: true });
  const metadata = await input.metadata();

  if (!metadata.pages || metadata.pages <= 1) {
    // Static image, return as single frame
    return [await sharp(gifPath).resize(UlanziD200.ICON_SIZE, UlanziD200.ICON_SIZE).png().toBuffer()];
  }

  const frames: Buffer[] = [];
  for (let i = 0; i < metadata.pages; i++) {
    const frame = await sharp(gifPath, { page: i })
      .resize(UlanziD200.ICON_SIZE, UlanziD200.ICON_SIZE, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 1 },
      })
      .png()
      .toBuffer();
    frames.push(frame);
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

  // Lower post-transfer delay for animation — small ZIPs (1-2 buttons)
  // process much faster than full 13-button ZIPs
  deck.postTransferDelayMs = 20;

  // Rainbow animation on button 0
  console.log('Generating 24 rainbow frames...');
  const rainbowFrames = await generateRainbowFrames(24);
  console.log('Starting rainbow animation on button 0 at 8 FPS...');
  await deck.animateButton(0, rainbowFrames, 8);

  // If a GIF file is provided as CLI argument, animate it on button 1
  const gifArg = process.argv[2];
  if (gifArg) {
    const gifPath = path.resolve(gifArg);
    if (fs.existsSync(gifPath)) {
      console.log(`Loading GIF: ${gifPath}`);
      const gifFrames = await extractGifFrames(gifPath);
      console.log(`Extracted ${gifFrames.length} frames. Animating on button 1...`);
      await deck.animateButton(1, gifFrames, 10);
    } else {
      console.error(`GIF file not found: ${gifPath}`);
    }
  } else {
    console.log('Tip: pass a GIF path as argument to animate it on button 1');
    console.log('  npx ts-node examples/animation.ts my-animation.gif');
  }

  // Listen for presses
  deck.startPolling();
  deck.on('press', (index) => {
    console.log(`Button ${index} pressed`);
    if (index === 0) {
      console.log('Stopping rainbow animation');
      deck.stopAnimation(0);
    }
  });

  console.log('Press button 0 to stop rainbow. Ctrl+C to exit.\n');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
