/**
 * ZIP creation for Ulanzi D200 button data with the byte-boundary workaround.
 *
 * The device misinterprets data if bytes at positions 1016, 2040, 3064, ...
 * (every 1024 bytes starting at offset 1016) are 0x00 or 0x7C.
 * We add a dummy.txt with random content and retry until all boundary bytes are safe.
 */

import JSZip from 'jszip';
import { CHUNK_SIZE, PACKET_SIZE } from './protocol';
import { dbg, dbgVerbose, hexDump, isVerbose } from './debug';

const INVALID_BYTES = new Set([0x00, 0x7c]);
const MAX_RETRIES = 50;

function randomString(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function validateBoundaryBytes(data: Buffer): { valid: boolean; failures: string[] } {
  const failures: string[] = [];
  for (let i = CHUNK_SIZE; i < data.length; i += PACKET_SIZE) {
    if (INVALID_BYTES.has(data[i])) {
      failures.push(`offset ${i}: 0x${data[i].toString(16).padStart(2, '0')}`);
    }
  }
  return { valid: failures.length === 0, failures };
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
  ViewParam: Array<{
    Text?: string;
    Icon?: string;
  }>;
}

/**
 * Build a ZIP buffer containing the manifest and button images,
 * with the byte-boundary workaround applied.
 */
export async function buildButtonZip(
  buttons: Map<number, ButtonConfig>,
  buttonCols: number,
): Promise<Buffer> {
  let dummyContent = '';

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const zip = new JSZip();
    const manifest: Record<string, ManifestEntry> = {};

    // Add dummy.txt first (it needs to be at the start of the ZIP)
    if (dummyContent) {
      zip.file('dummy.txt', dummyContent);
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

      if (config.image) {
        const iconName = `btn_${index}.png`;
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
        compression: 'DEFLATE',
        compressionOptions: { level: 1 },
      }),
    );

    const { valid, failures } = validateBoundaryBytes(zipBuffer);

    if (attempt === 0) {
      dbg('zip', `manifest: ${manifestJson}`);
      dbg('zip', `size=${zipBuffer.length} bytes, ${Math.ceil((zipBuffer.length - CHUNK_SIZE) / PACKET_SIZE) + 1} packets`);
    }

    if (valid) {
      if (attempt > 0) {
        dbg('zip', `boundary workaround: passed on attempt ${attempt + 1} (dummy=${dummyContent.length} chars)`);
      }
      dbgVerbose('zip', `zip header: ${hexDump(zipBuffer, 32)}`);

      // Log all boundary bytes for verbose debugging
      if (isVerbose()) {
        for (let i = CHUNK_SIZE; i < zipBuffer.length; i += PACKET_SIZE) {
          const byte = zipBuffer[i];
          dbgVerbose('zip', `boundary @${i}: 0x${byte.toString(16).padStart(2, '0')}`);
        }
      }

      return zipBuffer;
    }

    dbg('zip', `boundary check FAILED attempt ${attempt + 1}: ${failures.join(', ')}`);
    dummyContent += randomString(8 * (attempt + 1));
  }

  throw new Error(
    `Failed to generate valid ZIP after ${MAX_RETRIES} attempts (byte boundary workaround)`,
  );
}
