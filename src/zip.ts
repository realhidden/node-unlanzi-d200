/**
 * ZIP creation for Ulanzi D200 button data.
 *
 * The device misinterprets data if bytes at packet-boundary positions
 * (1016, 2040, 3064, ...) are 0x00 or 0x7C. Instead of the brute-force
 * retry approach (rebuild ZIP with random dummy until boundaries are safe),
 * we build the ZIP once with STORED compression, then directly patch the
 * boundary bytes in the raw buffer by inserting a calculated pad prefix.
 */

import JSZip from 'jszip';
import { CHUNK_SIZE, PACKET_SIZE } from './protocol';
import { dbg, dbgVerbose } from './debug';

const INVALID_BYTES = new Set([0x00, 0x7c]);
const MAX_RETRIES = 100;

function randomString(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Monotonic counter to generate unique icon filenames per ZIP.
// The device caches images by path — reusing the same name with
// different content causes the device to show stale images.
let zipSeq = 0;

function getBadBoundaries(data: Buffer): number[] {
  const bad: number[] = [];
  for (let i = CHUNK_SIZE; i < data.length; i += PACKET_SIZE) {
    if (INVALID_BYTES.has(data[i])) {
      bad.push(i);
    }
  }
  return bad;
}

export interface ButtonConfig {
  /** Button label text */
  label?: string;
  /** PNG image data as Buffer */
  image?: Buffer;
  /** Reference to a preloaded image by name (from preloadImages) */
  iconRef?: string;
  /** State value (default: 0) */
  state?: number;
}

export interface ManifestEntry {
  State: number;
  ViewParam: Array<{
    Text?: string;
    Icon?: string;
  }>;
}

/**
 * Build a preload ZIP containing named images for the device cache.
 * The manifest maps all images to button 0 — the layout doesn't matter,
 * we just need the device to ingest and cache the image files.
 */
export async function buildPreloadZip(
  images: Map<string, Buffer>,
  useStored: boolean,
): Promise<Buffer> {
  // We need a valid manifest or the device ignores the ZIP.
  // Map all images to button 0_0 in a single ViewParam array —
  // the actual layout will be set later by setLayout.
  const manifest: Record<string, ManifestEntry> = {
    '0_0': {
      State: 0,
      ViewParam: [{}],
    },
  };

  let padContent = '';
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const zip = new JSZip();

    if (padContent.length > 0) {
      zip.file('pad.txt', padContent);
    }

    for (const [name, data] of images) {
      zip.file(`icons/${name}`, data);
    }

    // Set the first image as the icon so the manifest is valid
    const firstName = images.keys().next().value;
    if (firstName) {
      manifest['0_0'].ViewParam[0].Icon = `icons/${firstName}`;
    }
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));

    const zipBuffer = Buffer.from(
      await zip.generateAsync({
        type: 'nodebuffer',
        compression: useStored ? 'STORE' : 'DEFLATE',
        compressionOptions: useStored ? undefined : { level: 1 },
      }),
    );

    const bad = getBadBoundaries(zipBuffer);
    if (bad.length === 0) {
      dbg('zip', `preload: ${images.size} images, ${zipBuffer.length} bytes`);
      return zipBuffer;
    }

    padContent = useStored
      ? 'A'.repeat(attempt + 1)
      : randomString(8 * (attempt + 1));
  }

  throw new Error(`Failed to build preload ZIP after ${MAX_RETRIES} attempts`);
}

/**
 * Build the raw ZIP content (manifest + images) without the dummy pad.
 */
async function buildRawZip(
  buttons: Map<number, ButtonConfig>,
  buttonCols: number,
  padContent: string,
  useStored: boolean,
): Promise<{ zipBuffer: Buffer; manifestJson: string }> {
  const zip = new JSZip();
  const manifest: Record<string, ManifestEntry> = {};

  // Pad file goes first in the ZIP
  if (padContent.length > 0) {
    zip.file('pad.txt', padContent);
  }

  for (const [index, config] of buttons) {
    const col = index % buttonCols;
    const row = Math.floor(index / buttonCols);
    const key = `${col}_${row}`;

    const entry: ManifestEntry = {
      State: config.state ?? 0,
      ViewParam: [{}],
    };

    if (config.label) {
      entry.ViewParam[0].Text = config.label;
    }

    if (config.iconRef) {
      // Reference a preloaded/cached image by path — no image data in ZIP
      entry.ViewParam[0].Icon = config.iconRef;
    } else if (config.image) {
      const iconName = `btn_${index}_${zipSeq}.png`;
      zip.file(`icons/${iconName}`, config.image);
      entry.ViewParam[0].Icon = `icons/${iconName}`;
    }

    manifest[key] = entry;
  }

  const manifestJson = JSON.stringify(manifest, null, 2);
  zip.file('manifest.json', manifestJson);

  const zipBuffer = Buffer.from(
    await zip.generateAsync({
      type: 'nodebuffer',
      compression: useStored ? 'STORE' : 'DEFLATE',
      compressionOptions: useStored ? undefined : { level: 1 },
    }),
  );

  return { zipBuffer, manifestJson };
}

/**
 * Build a ZIP buffer containing the manifest and button images,
 * with the byte-boundary workaround applied.
 *
 * Strategy: build with STORED compression (fast, deterministic), then
 * incrementally grow a pad file byte-by-byte until all boundary positions
 * are safe. Each 1-byte increment shifts the entire ZIP content by 1 byte,
 * so we converge quickly.
 */
export async function buildButtonZip(
  buttons: Map<number, ButtonConfig>,
  buttonCols: number,
  useStored = false,
): Promise<Buffer> {
  // First try: no padding
  let { zipBuffer, manifestJson } = await buildRawZip(buttons, buttonCols, '', useStored);
  let bad = getBadBoundaries(zipBuffer);

  if (bad.length === 0) {
    dbg('zip', `manifest: ${manifestJson}`);
    dbg('zip', `size=${zipBuffer.length} bytes, ${Math.ceil((zipBuffer.length - CHUNK_SIZE) / PACKET_SIZE) + 1} packets`);
    zipSeq++;
    return zipBuffer;
  }

  // Strategy depends on compression mode:
  // - STORED: deterministic 1-byte increments (each byte shifts content by exactly 1)
  // - DEFLATE: random padding (compressed output is unpredictable, so we randomize)
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const pad = useStored
      ? 'A'.repeat(attempt)
      : randomString(8 * attempt);

    ({ zipBuffer } = await buildRawZip(buttons, buttonCols, pad, useStored));
    bad = getBadBoundaries(zipBuffer);

    if (bad.length === 0) {
      dbg('zip', `manifest: ${manifestJson}`);
      dbg('zip', `size=${zipBuffer.length} bytes, pad=${pad.length}, ${Math.ceil((zipBuffer.length - CHUNK_SIZE) / PACKET_SIZE) + 1} packets`);
      if (attempt > 2) {
        dbg('zip', `boundary workaround: passed on attempt ${attempt + 1}`);
      }
      zipSeq++;
      return zipBuffer;
    }
  }

  throw new Error(
    `Failed to generate valid ZIP after ${MAX_RETRIES} pad attempts. ` +
    `Remaining bad boundaries: ${bad.join(', ')}`,
  );
}
