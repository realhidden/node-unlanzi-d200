/**
 * Ulanzi D200 demo — showcases all library features.
 *
 * Usage: npx ts-node examples/demo.ts
 *
 * This demo:
 *   1. Connects to the device
 *   2. Sets brightness to 80%
 *   3. Configures label style
 *   4. Generates colored button images with labels
 *   5. Updates the clock/stats window
 *   6. Listens for button presses
 *   7. Demonstrates single-button partial updates on press
 */

import { UlanziD200, SmallWindowMode } from '../src';
import sharp from 'sharp';

// Generate a solid-color PNG with text overlay
async function createColorButton(
  color: string,
  label: string,
): Promise<Buffer> {
  const size = UlanziD200.ICON_SIZE;

  // Create an SVG with the label text on a colored background
  const svg = `
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${size}" height="${size}" fill="${color}" rx="16"/>
      <text
        x="${size / 2}" y="${size / 2}"
        text-anchor="middle" dominant-baseline="central"
        font-family="sans-serif" font-size="24" font-weight="bold" fill="white"
      >${escapeXml(label)}</text>
    </svg>
  `;

  return sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const BUTTON_COLORS = [
  '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#1abc9c',
  '#3498db', '#9b59b6', '#e91e63', '#00bcd4', '#8bc34a',
  '#ff5722', '#795548', '#607d8b',
];

const BUTTON_LABELS = [
  'Play', 'Stop', 'Rec', 'Mute', 'Vol+',
  'Scene1', 'Scene2', 'Scene3', 'Chat', 'Alert',
  'Cut', 'FX', 'Snap',
];

async function main() {
  console.log('Looking for Ulanzi D200...');

  const devices = UlanziD200.listDevices();
  if (devices.length === 0) {
    console.error('No Ulanzi D200 found. Is it plugged in?');
    console.error('On Linux, you may need udev rules. See README.md.');
    process.exit(1);
  }

  console.log(`Found ${devices.length} device(s). Connecting...`);
  const deck = UlanziD200.open();
  console.log('Connected!');

  // Handle cleanup on exit
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    deck.close();
    process.exit(0);
  });

  // 1. Set brightness
  console.log('Setting brightness to 80%...');
  deck.setBrightness(80);

  // 2. Configure label style
  console.log('Setting label style...');
  deck.setLabelStyle({
    align: 'bottom',
    color: 'FFFFFF',
    size: 12,
    showTitle: true,
  });

  // 3. Pre-generate all button images (normal + pressed states)
  console.log('Generating button images...');
  const normalImages: Buffer[] = [];
  const pressedImages: Buffer[] = [];
  for (let i = 0; i < 13; i++) {
    normalImages[i] = await createColorButton(BUTTON_COLORS[i], BUTTON_LABELS[i]);
    pressedImages[i] = await createColorButton('#ffffff', BUTTON_LABELS[i]);
  }

  // 4. Set all button images
  console.log('Setting button images...');
  const buttons: Record<number, { image: Buffer; label: string }> = {};
  for (let i = 0; i < 13; i++) {
    buttons[i] = { image: normalImages[i], label: BUTTON_LABELS[i] };
  }
  await deck.setButtons(buttons);
  console.log('All 13 buttons set.');

  // 5. Update the small window (clock mode)
  console.log('Setting clock display...');
  deck.setSmallWindow({ mode: SmallWindowMode.CLOCK });

  // Keep the clock updated every 5 seconds (not every 1s to avoid
  // competing with button updates for the write queue)
  setInterval(() => {
    deck.setSmallWindow({ mode: SmallWindowMode.CLOCK });
  }, 5000);

  // 6. Listen for button presses
  console.log('Listening for button presses (Ctrl+C to quit)...\n');
  deck.startPolling();

  deck.on('press', (index) => {
    console.log(`Button ${index} PRESSED (${BUTTON_LABELS[index] ?? '?'})`);

    // Flash the button white on press (uses pre-generated image)
    deck.setButton(index, { image: pressedImages[index], label: BUTTON_LABELS[index] });
  });

  deck.on('release', (index) => {
    console.log(`Button ${index} RELEASED`);

    // Restore original color on release (uses pre-generated image)
    deck.setButton(index, { image: normalImages[index], label: BUTTON_LABELS[index] });
  });

  deck.on('error', (err) => {
    console.error('Device error:', err.message);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
