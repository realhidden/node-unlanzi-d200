/**
 * Ulanzi D200 USB HID protocol constants and packet handling.
 *
 * All communication uses 1024-byte HID packets:
 *   [0-1]    Header: 0x7C 0x7C
 *   [2-3]    Command (big-endian uint16)
 *   [4-7]    Length (little-endian uint32)
 *   [8-1023] Data payload (zero-padded)
 */

export const VENDOR_ID = 0x2207;
export const PRODUCT_ID = 0x0019;

export const PACKET_SIZE = 1024;
export const HEADER_SIZE = 8;
export const CHUNK_SIZE = PACKET_SIZE - HEADER_SIZE; // 1016
export const HEADER = Buffer.from([0x7c, 0x7c]);

/** Commands sent from host to device */
export enum OutCommand {
  SET_BUTTONS = 0x0001,
  SET_SMALL_WINDOW_DATA = 0x0006,
  SET_BRIGHTNESS = 0x000a,
  SET_LABEL_STYLE = 0x000b,
  PARTIALLY_UPDATE_BUTTONS = 0x000d,
}

export const OutCommandName: Record<number, string> = {
  [OutCommand.SET_BUTTONS]: 'SET_BUTTONS',
  [OutCommand.SET_SMALL_WINDOW_DATA]: 'SET_SMALL_WINDOW_DATA',
  [OutCommand.SET_BRIGHTNESS]: 'SET_BRIGHTNESS',
  [OutCommand.SET_LABEL_STYLE]: 'SET_LABEL_STYLE',
  [OutCommand.PARTIALLY_UPDATE_BUTTONS]: 'PARTIALLY_UPDATE_BUTTONS',
};

/** Commands received from device */
export enum InCommand {
  BUTTON = 0x0101,
  BUTTON_2 = 0x0102,
  DEVICE_INFO = 0x0303,
}

export const InCommandName: Record<number, string> = {
  [InCommand.BUTTON]: 'BUTTON',
  [InCommand.BUTTON_2]: 'BUTTON_2',
  [InCommand.DEVICE_INFO]: 'DEVICE_INFO',
};

export interface ButtonPressData {
  state: number;
  index: number;
  pressed: boolean;
}

/**
 * Build a 1024-byte HID packet.
 */
export function buildPacket(
  command: OutCommand,
  data: Buffer,
  length?: number,
): Buffer {
  const packet = Buffer.alloc(PACKET_SIZE);

  // Header
  HEADER.copy(packet, 0);

  // Command (big-endian uint16)
  packet.writeUInt16BE(command, 2);

  // Length (little-endian uint32)
  packet.writeUInt32LE(length ?? data.length, 4);

  // Data
  data.copy(packet, HEADER_SIZE, 0, Math.min(data.length, CHUNK_SIZE));

  return packet;
}

/**
 * Parse an incoming HID packet from the device.
 * Returns null if the packet is not recognized.
 */
export function parsePacket(
  raw: Buffer,
): { command: InCommand; data: Buffer } | null {
  if (raw.length < HEADER_SIZE) return null;
  if (raw[0] !== 0x7c || raw[1] !== 0x7c) return null;

  const command = raw.readUInt16BE(2) as InCommand;
  const length = raw.readUInt32LE(4);
  const data = raw.subarray(HEADER_SIZE, HEADER_SIZE + length);

  return { command, data };
}

/**
 * Parse button press data from the payload of a BUTTON command.
 */
export function parseButtonPress(data: Buffer): ButtonPressData | null {
  if (data.length < 4) return null;

  return {
    state: data[0],
    index: data[1],
    // data[2] is always 0x01
    pressed: data[3] === 0x01,
  };
}

/**
 * Parse device info string from the payload of a DEVICE_INFO command.
 */
export function parseDeviceInfo(data: Buffer): string {
  // ASCII C-string, find null terminator
  const nullIdx = data.indexOf(0);
  return data.subarray(0, nullIdx === -1 ? data.length : nullIdx).toString('ascii');
}

/**
 * Split a file (ZIP) into HID packets for transfer.
 * First packet has the 8-byte header + first 1016 bytes.
 * Subsequent packets are raw 1024-byte chunks (no header).
 */
export function buildFileTransferPackets(
  command: OutCommand,
  fileData: Buffer,
): Buffer[] {
  const packets: Buffer[] = [];

  // First packet: header + first chunk
  const firstChunk = Buffer.alloc(CHUNK_SIZE);
  fileData.copy(firstChunk, 0, 0, Math.min(fileData.length, CHUNK_SIZE));

  packets.push(buildPacket(command, firstChunk, fileData.length));

  // Remaining packets: raw 1024-byte chunks
  for (let offset = CHUNK_SIZE; offset < fileData.length; offset += PACKET_SIZE) {
    const chunk = Buffer.alloc(PACKET_SIZE);
    fileData.copy(chunk, 0, offset, Math.min(offset + PACKET_SIZE, fileData.length));
    packets.push(chunk);
  }

  return packets;
}
