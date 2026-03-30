/**
 * Animation demo — cycles rainbow colors on a button.
 *
 * Usage: npx ts-node examples/animation.ts [path-to.gif]
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

async function extractGifFrames(gifPath: string): Promise<Buffer[]> {
  const input = sharp(gifPath, { animated: true });
  const metadata = await input.metadata();

  console.log(`GIF metadata: pages=${metadata.pages} width=${metadata.width} height=${metadata.height} format=${metadata.format}`);

  if (!metadata.pages || metadata.pages <= 1) {
    console.log('GIF has <= 1 page, returning single frame');
    return [await sharp(gifPath).resize(UlanziD200.ICON_SIZE, UlanziD200.ICON_SIZE).png().toBuffer()];
  }

  console.log(`Extracting ${metadata.pages} frames...`);
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
    if (i % 10 === 0) console.log(`  frame ${i}/${metadata.pages} (${frame.length} bytes)`);
  }

  return frames;
}

async function main() {
  console.log('Connecting to Ulanzi D200...');
  const deck = UlanziD200.open();

  process.on('SIGINT', () => {
    console.log('\nStopping...');
    clock?.stop();
    deck.close();
    process.exit(0);
  });

  deck.setBrightness(80);
  deck.postTransferDelayMs = 30;
  deck.batchDelayMs = 5;
  deck.useStoredCompression = true;

  // Start a clock on the info window (button 13)
  const clock = deck.startClock();

  // Generate rainbow frames shared by all buttons
  const frameCount = 24;
  console.log(`Generating ${frameCount} rainbow frames...`);
  const rainbowFrames = await generateRainbowFrames(frameCount);
  console.log(`Rainbow: ${rainbowFrames.length} frames, first=${rainbowFrames[0].length} bytes`);

  // If a GIF is provided, use it instead of rainbow for all buttons
  let animFrames = rainbowFrames;
  const gifArg = process.argv[2];
  if (gifArg) {
    const gifPath = path.resolve(gifArg);
    if (fs.existsSync(gifPath)) {
      console.log(`Loading GIF: ${gifPath}`);
      animFrames = await extractGifFrames(gifPath);
      console.log(`GIF: ${animFrames.length} frames`);
    } else {
      console.error(`GIF file not found: ${gifPath}`);
    }
  }

  // Animate ALL 13 buttons with staggered start frames
  console.log('Starting animation on all 13 buttons (staggered)...');
  const stagger = Math.max(1, Math.floor(animFrames.length / 13));
  for (let i = 0; i < 13; i++) {
    // Offset the frames so each button starts at a different point
    const offset = (i * stagger) % animFrames.length;
    const shifted = [...animFrames.slice(offset), ...animFrames.slice(0, offset)];
    await deck.animateButton(i, shifted, 10);
  }
  console.log('All 13 buttons animating!');

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
