/**
 * Debug tool — traces all HID traffic to find the button ghost/corruption bug.
 *
 * Usage: npx ts-node examples/debug-buttons.ts
 *
 * This sends colored buttons to the device and logs every single
 * HID packet sent/received, including hex dumps, manifest contents,
 * and timing. Push buttons to see what's happening.
 *
 * All output is also written to debug.log in the current directory.
 */

import { UlanziD200, SmallWindowMode, setDebugLevel, setDebugLogFile } from '../src';
import sharp from 'sharp';
import * as fs from 'fs';

// Enable full debug output
setDebugLevel('verbose');
setDebugLogFile('debug.log');

async function createColorButton(color: string, label: string): Promise<Buffer> {
  const size = UlanziD200.ICON_SIZE;
  const svg = `
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${size}" height="${size}" fill="${color}" rx="16"/>
      <text x="${size / 2}" y="${size / 2}" text-anchor="middle" dominant-baseline="central"
            font-family="sans-serif" font-size="24" font-weight="bold" fill="white"
      >${label}</text>
    </svg>`;
  return sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
}

const COLORS = [
  '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#1abc9c',
  '#3498db', '#9b59b6', '#e91e63', '#00bcd4', '#8bc34a',
  '#ff5722', '#795548', '#607d8b',
];

async function main() {
  console.log('=== Ulanzi D200 Debug Tool ===');
  console.log('Logging to debug.log\n');

  // Show all HID devices matching our VID/PID
  const allDevices = UlanziD200.listDevices();
  console.log(`Found ${allDevices.length} D200 device(s):`);
  for (const d of allDevices) {
    console.log(`  path=${d.path}`);
    console.log(`  interface=${d.interface} usage=${d.usage} usagePage=${d.usagePage}`);
    console.log(`  release=${d.release}`);
    console.log();
  }

  const deck = UlanziD200.open();

  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    deck.close();
    process.exit(0);
  });

  // Step 1: Test write() return value with a simple brightness command
  console.log('\n--- Test 1: Brightness command ---');
  deck.setBrightness(80);
  await sleep(200);

  // Step 2: Set all buttons with FULL update (SET_BUTTONS, not partial)
  console.log('\n--- Test 2: Full button update (all 13) ---');
  const normalImages: Buffer[] = [];
  const pressedImages: Buffer[] = [];
  for (let i = 0; i < 13; i++) {
    normalImages[i] = await createColorButton(COLORS[i], String(i));
    pressedImages[i] = await createColorButton('#ffffff', String(i));
  }

  const allButtons: Record<number, { image: Buffer; label: string }> = {};
  for (let i = 0; i < 13; i++) {
    allButtons[i] = { image: normalImages[i], label: `Btn ${i}` };
  }
  await deck.setButtons(allButtons);
  console.log('Full update done.\n');
  await sleep(500);

  // Step 3: Test partial updates one at a time with delay
  console.log('--- Test 3: Sequential partial updates (one button at a time, 500ms gap) ---');
  for (let i = 0; i < 3; i++) {
    console.log(`  Updating button ${i} to white...`);
    await deck.setButton(i, { image: pressedImages[i], label: `Btn ${i}` });
    await sleep(500);
    console.log(`  Restoring button ${i}...`);
    await deck.setButton(i, { image: normalImages[i], label: `Btn ${i}` });
    await sleep(500);
  }
  console.log('Sequential partial updates done.\n');

  // Step 4: Rapid partial updates
  console.log('--- Test 4: Rapid partial updates (no extra delay) ---');
  for (let i = 0; i < 5; i++) {
    console.log(`  Rapid: button ${i} white`);
    await deck.setButton(i, { image: pressedImages[i], label: `Btn ${i}` });
  }
  await sleep(1000);
  // Restore all
  for (let i = 0; i < 5; i++) {
    await deck.setButton(i, { image: normalImages[i], label: `Btn ${i}` });
  }
  console.log('Rapid partial updates done.\n');

  // Step 5: Listen for button events and respond
  console.log('--- Test 5: Press buttons to test interactive updates ---');
  console.log('Press any button. Watch for wrong-button or corruption.\n');
  deck.startPolling();

  deck.on('press', (index) => {
    console.log(`>>> PRESS btn=${index} — sending white partial update`);
    deck.setButton(index, { image: pressedImages[index], label: `Btn ${index}` });
  });

  deck.on('release', (index) => {
    console.log(`>>> RELEASE btn=${index} — restoring color`);
    deck.setButton(index, { image: normalImages[index], label: `Btn ${index}` });
  });

  deck.on('error', (err) => {
    console.error('!!! ERROR:', err.message);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
