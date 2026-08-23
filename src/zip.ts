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
  /** State value (default: 0) */
  state?: number;
}

export interface ManifestEntry {
  State: number;
  /** Small window mode for the wide info panel slot (3_2) — required for
   *  the firmware to allocate the full panel width and link clock data */
  SmallViewMode?: number;
  ViewParam: Array<{
    Text?: string;
    Icon?: string;
  }>;
}

/**
 * Build the raw ZIP content (manifest + images) without the dummy pad.
 */
async function buildRawZip(
  buttons: Map<number, ButtonConfig>,
  buttonCols: number,
  padSize: number,
  useStored: boolean,
  smallWindowMode?: number,
): Promise<{ zipBuffer: Buffer; manifestJson: string }> {
  const zip = new JSZip();
  const manifest: Record<string, ManifestEntry> = {};

  // Pad file is ALWAYS stored as raw bytes (never compressed), so each
  // byte we add shifts the rest of the ZIP by exactly 1 byte. This makes
  // the boundary workaround deterministic regardless of image compression.
  if (padSize > 0) {
    zip.file('pad.txt', 'A'.repeat(padSize), { compression: 'STORE' });
  }

  const imageCompression = useStored ? 'STORE' : 'DEFLATE';
  const imageOptions = useStored
    ? { compression: 'STORE' as const }
    : { compression: 'DEFLATE' as const, compressionOptions: { level: 1 } };

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

    if (config.image) {
      const iconName = `btn_${index}_${zipSeq}.png`;
      zip.file(`icons/${iconName}`, config.image, imageOptions);
      entry.ViewParam[0].Icon = `icons/${iconName}`;
    }

    manifest[key] = entry;
  }

  // The info panel ("3_2" slot, button index 13 on a 5-col layout) must
  // carry SmallViewMode so the firmware allocates the full panel width
  // and links it to the small-window clock/stats subsystem.
  // Mirrors Ulanzi Studio captures (see redphx/strmdck).
  if (smallWindowMode != null) {
    const smallKey = '3_2';
    const smallIndex = 3 + 2 * buttonCols; // col 3, row 2 → 13 with 5 cols
    const config = buttons.get(smallIndex);
    const isBackground = smallWindowMode === 2 /* SmallWindowMode.BACKGROUND */;
    const entry: ManifestEntry = manifest[smallKey] ?? { State: 0, ViewParam: [{}] };
    entry.State = config?.state ?? 0;
    entry.SmallViewMode = smallWindowMode;
    const vp = entry.ViewParam[0] ?? {};
    vp.Text = '';
    if (isBackground && !vp.Icon) {
      // Background mode needs an image; nothing set → drop to plain entry
      entry.SmallViewMode = smallWindowMode;
    }
    if (!isBackground) {
      // Clock/stats render across the whole panel — no icon underneath
      delete vp.Icon;
    }
    entry.ViewParam = [vp];
    manifest[smallKey] = entry;
  }

  const manifestJson = JSON.stringify(manifest, null, 2);
  zip.file('manifest.json', manifestJson, imageOptions);

  const zipBuffer = Buffer.from(
    await zip.generateAsync({ type: 'nodebuffer' }),
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
  smallWindowMode?: number,
): Promise<Buffer> {
  // First try: no padding
  let { zipBuffer, manifestJson } = await buildRawZip(buttons, buttonCols, 0, useStored, smallWindowMode);
  let bad = getBadBoundaries(zipBuffer);

  if (bad.length === 0) {
    dbg('zip', `manifest: ${manifestJson}`);
    dbg('zip', `size=${zipBuffer.length} bytes, ${Math.ceil((zipBuffer.length - CHUNK_SIZE) / PACKET_SIZE) + 1} packets`);
    zipSeq++;
    return zipBuffer;
  }

  // The pad.txt is always STORED (raw bytes), so each byte added shifts
  // ALL subsequent content by exactly 1. Trying 1024 sizes covers every
  // possible alignment against the 1024-byte packet grid. Guaranteed.
  for (let padSize = 1; padSize <= PACKET_SIZE; padSize++) {
    ({ zipBuffer } = await buildRawZip(buttons, buttonCols, padSize, useStored, smallWindowMode));
    bad = getBadBoundaries(zipBuffer);

    if (bad.length === 0) {
      dbg('zip', `manifest: ${manifestJson}`);
      dbg('zip', `size=${zipBuffer.length} bytes, pad=${padSize}, ${Math.ceil((zipBuffer.length - CHUNK_SIZE) / PACKET_SIZE) + 1} packets`);
      if (padSize > 5) {
        dbg('zip', `boundary workaround: passed on attempt ${padSize}`);
      }
      zipSeq++;
      return zipBuffer;
    }
  }

  // Mathematically impossible to reach here with STORED pad — but just in case
  throw new Error(
    `Failed to generate valid ZIP after 1024 pad attempts. ` +
    `Remaining bad boundaries: ${bad.join(', ')}`,
  );
}
