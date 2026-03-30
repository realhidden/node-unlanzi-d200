import { EventEmitter } from 'events';
import HID from 'node-hid';
import sharp from 'sharp';
import {
  VENDOR_ID,
  PRODUCT_ID,
  OutCommand,
  OutCommandName,
  InCommand,
  InCommandName,
  buildPacket,
  buildFileTransferPackets,
  parsePacket,
  parseButtonPress,
  parseDeviceInfo,
  ButtonPressData,
} from './protocol';
import { buildButtonZip, ButtonConfig } from './zip';
import { dbg, dbgVerbose, hexDump, setDebugLevel, setDebugLogFile, type DebugLevel } from './debug';

export { setDebugLevel, setDebugLogFile, DebugLevel };

export enum SmallWindowMode {
  STATS = 0,
  CLOCK = 1,
  BACKGROUND = 2,
}

export interface LabelStyle {
  align?: 'top' | 'bottom' | 'center';
  color?: string; // hex color without '#', e.g. 'FFFFFF'
  fontName?: string;
  showTitle?: boolean;
  size?: number;
  weight?: number;
}

export interface SmallWindowData {
  mode?: SmallWindowMode;
  cpu?: number;
  mem?: number;
  time?: string; // HH:MM:SS
  gpu?: number;
}

export interface InfoWindowEvent {
  mode: number; // 0=STATS, 1=CLOCK, 2=BACKGROUND
}

export interface UlanziD200Events {
  'button': (event: ButtonPressData) => void;
  'press': (index: number) => void;
  'release': (index: number) => void;
  'info-window': (event: InfoWindowEvent) => void;
  'device-info': (info: string) => void;
  'error': (error: Error) => void;
  'close': () => void;
}

export declare interface UlanziD200 {
  on<E extends keyof UlanziD200Events>(event: E, listener: UlanziD200Events[E]): this;
  once<E extends keyof UlanziD200Events>(event: E, listener: UlanziD200Events[E]): this;
  off<E extends keyof UlanziD200Events>(event: E, listener: UlanziD200Events[E]): this;
  emit<E extends keyof UlanziD200Events>(event: E, ...args: Parameters<UlanziD200Events[E]>): boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class UlanziD200 extends EventEmitter {
  static readonly VENDOR_ID = VENDOR_ID;
  static readonly PRODUCT_ID = PRODUCT_ID;
  static readonly BUTTON_COUNT = 13;
  static readonly BUTTON_COLS = 5;
  static readonly BUTTON_ROWS = 3;
  static readonly ICON_SIZE = 196;

  /** Delay in ms after completing a ZIP transfer to let the device process it */
  postTransferDelayMs = 100;
  /** How long to wait (ms) for more changes before flushing a batched update */
  batchDelayMs = 16;
  /** Use STORED compression (faster builds, larger ZIPs). Enable for animation. */
  useStoredCompression = false;

  private device: HID.HID;
  private polling = false;
  private animationTimers = new Map<number, { stop: () => void }>();

  // Write queue ensures only one HID transfer happens at a time
  private writeQueue: Promise<void> = Promise.resolve();
  private writeSeq = 0;

  // Internal button state. Render loop: only one render cycle runs at a
  // time. Changes arriving during a transfer are absorbed into the next cycle.
  private buttonState = new Map<number, ButtonConfig>();
  private dirty = false;
  private rendering = false;
  private renderWaiters: Array<() => void> = [];

  constructor(device: HID.HID) {
    super();
    this.device = device;
  }

  /**
   * Open the first available Ulanzi D200 device.
   */
  static open(): UlanziD200 {
    const allMatching = HID.devices().filter(
      (d) => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID,
    );

    if (allMatching.length === 0) {
      throw new Error(
        `Ulanzi D200 not found (VID: ${VENDOR_ID.toString(16)}, PID: ${PRODUCT_ID.toString(16)}). ` +
        'Is the device connected? On Linux, check udev rules.',
      );
    }

    for (const d of allMatching) {
      dbg('hid', `found interface=${d.interface} usage=${d.usage} usagePage=${d.usagePage} path=${d.path}`);
    }

    // The D200 exposes multiple HID interfaces. We need the consumer
    // control interface (interface 0), not the keyboard interface (1).
    // Try each matching device until one opens successfully.
    const sorted = [...allMatching].sort((a, b) => (a.interface ?? 99) - (b.interface ?? 99));

    for (const deviceInfo of sorted) {
      try {
        dbg('hid', `trying: interface=${deviceInfo.interface} usagePage=${deviceInfo.usagePage} path=${deviceInfo.path}`);
        const hid = new HID.HID(deviceInfo.path!);
        dbg('hid', `opened successfully`);
        return new UlanziD200(hid);
      } catch (err) {
        dbg('hid', `failed: ${err}`);
      }
    }

    throw new Error('Ulanzi D200 found but could not open any HID interface');
  }

  /**
   * List all connected Ulanzi D200 devices.
   */
  static listDevices(): HID.Device[] {
    return HID.devices().filter(
      (d) => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID,
    );
  }

  /**
   * Start listening for button events.
   * Uses node-hid's async read (internal thread) so the event loop
   * is never blocked — Ctrl+C and other signals work immediately.
   */
  startPolling(): void {
    if (this.polling) return;
    this.polling = true;

    this.device.on('data', (data: Buffer) => {
      this.handleData(data);
    });
    this.device.on('error', (err: Error) => {
      this.emit('error', err);
    });
  }

  /**
   * Stop listening for button events.
   */
  stopPolling(): void {
    this.polling = false;
    this.device.removeAllListeners('data');
    this.device.removeAllListeners('error');
    try {
      this.device.pause();
    } catch {
      // ignore — device may already be closed
    }
  }

  /**
   * Handle an incoming HID data packet.
   */
  private handleData(buf: Buffer): void {
    try {
      dbgVerbose('recv', `raw ${hexDump(buf, 16)}`);

      const parsed = parsePacket(buf);
      if (!parsed) {
        dbg('recv', `UNPARSEABLE packet: ${hexDump(buf, 32)}`);
        return;
      }

      const cmdName = InCommandName[parsed.command] ?? `0x${parsed.command.toString(16)}`;

      switch (parsed.command) {
        case InCommand.BUTTON:
        case InCommand.BUTTON_2: {
          const press = parseButtonPress(parsed.data);
          if (press) {
            // Button 13 is the info window — it sends continuous status
            // updates (~8/sec) with the display mode in the state field.
            // These are NOT real button presses.
            if (press.index === 13) {
              dbgVerbose('recv', `info-window mode=${press.state} raw=[${parsed.data.subarray(0, 4).toString('hex')}]`);
              this.emit('info-window', { mode: press.state });
              break;
            }

            dbg('recv', `${cmdName} btn=${press.index} pressed=${press.pressed} state=${press.state} raw=[${parsed.data.subarray(0, 4).toString('hex')}]`);
            this.emit('button', press);
            if (press.pressed) {
              this.emit('press', press.index);
            } else {
              this.emit('release', press.index);
            }
          } else {
            dbg('recv', `${cmdName} FAILED to parse button data: ${hexDump(parsed.data, 16)}`);
          }
          break;
        }
        case InCommand.DEVICE_INFO: {
          const info = parseDeviceInfo(parsed.data);
          dbg('recv', `DEVICE_INFO: "${info}"`);
          this.emit('device-info', info);
          break;
        }
        default:
          dbg('recv', `unknown cmd=${cmdName} len=${parsed.data.length}: ${hexDump(parsed.data, 32)}`);
      }
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Set display brightness (0-100).
   */
  setBrightness(brightness: number): void {
    brightness = Math.max(0, Math.min(100, Math.round(brightness)));
    const data = Buffer.from(String(brightness), 'utf-8');
    this.enqueueWrite('SET_BRIGHTNESS', () => { this.writeRaw(buildPacket(OutCommand.SET_BRIGHTNESS, data)); });
  }

  /**
   * Set the label style for all buttons.
   */
  setLabelStyle(style: LabelStyle): void {
    const payload = {
      Align: style.align ?? 'bottom',
      Color: parseInt(style.color ?? 'FFFFFF', 16),
      FontName: style.fontName ?? 'Roboto',
      ShowTitle: style.showTitle ?? true,
      Size: style.size ?? 10,
      Weight: style.weight ?? 80,
    };
    const data = Buffer.from(JSON.stringify(payload), 'utf-8');
    this.enqueueWrite('SET_LABEL_STYLE', () => { this.writeRaw(buildPacket(OutCommand.SET_LABEL_STYLE, data)); });
  }

  /**
   * Set the small window (clock/stats area) data.
   */
  setSmallWindow(data: SmallWindowData): void {
    const mode = data.mode ?? SmallWindowMode.CLOCK;
    const cpu = data.cpu ?? 0;
    const mem = data.mem ?? 0;
    const time = data.time ?? new Date().toLocaleTimeString('en-GB');
    const gpu = data.gpu ?? 0;

    const payload = Buffer.from(`${mode}|${cpu}|${mem}|${time}|${gpu}`, 'utf-8');
    this.enqueueWrite('SET_SMALL_WINDOW', () => { this.writeRaw(buildPacket(OutCommand.SET_SMALL_WINDOW_DATA, payload)); });
  }

  /**
   * Set images/labels on multiple buttons. This is the initial/bulk setter.
   * Always sends a full SET_BUTTONS with all provided buttons.
   *
   * @param buttons - Map of button index (0-12) to config.
   */
  async setButtons(
    buttons: Record<number, ButtonConfig | string | Buffer>,
  ): Promise<void> {
    for (const [indexStr, value] of Object.entries(buttons)) {
      const index = Number(indexStr);
      if (index < 0 || index > 12) continue;

      let config: ButtonConfig;
      if (Buffer.isBuffer(value)) {
        config = { image: await this.prepareImage(value) };
      } else if (typeof value === 'string') {
        config = { label: value };
      } else {
        config = { ...value };
        if (config.image) {
          config.image = await this.prepareImage(config.image);
        }
      }

      this.buttonState.set(index, config);
    }

    await this.sendImmediate();
  }

  /**
   * Update a single button. The change is batched — multiple rapid
   * setButton calls coalesce into a single SET_BUTTONS transfer.
   */
  async setButton(
    index: number,
    config: ButtonConfig | string | Buffer,
  ): Promise<void> {
    if (index < 0 || index > 12) return;

    let resolved: ButtonConfig;
    if (Buffer.isBuffer(config)) {
      resolved = { image: await this.prepareImage(config) };
    } else if (typeof config === 'string') {
      resolved = { label: config };
    } else {
      resolved = { ...config };
      if (resolved.image) {
        resolved.image = await this.prepareImage(resolved.image);
      }
    }

    this.buttonState.set(index, resolved);
    return this.requestRender();
  }

  /**
   * Clear all buttons (set to blank).
   */
  async clearButtons(): Promise<void> {
    this.buttonState.clear();
    for (let i = 0; i < UlanziD200.BUTTON_COUNT; i++) {
      this.buttonState.set(i, {});
    }
    await this.sendImmediate();
  }

  /**
   * Animate a button by cycling through frames.
   * Uses a sequential loop instead of setInterval to prevent overlap.
   *
   * @param index - Button index (0-12)
   * @param frames - Array of image Buffers (PNG/JPEG)
   * @param fps - Frames per second (default: 10, max ~15 due to USB bandwidth)
   * @returns A stop function to cancel the animation
   */
  async animateButton(
    index: number,
    frames: Buffer[],
    fps = 10,
  ): Promise<{ stop: () => void }> {
    if (frames.length === 0) throw new Error('No frames provided');

    this.stopAnimation(index);

    // Pre-process all frames once (resize to 196x196 PNG)
    const prepared = await Promise.all(
      frames.map((f) => this.prepareImage(f)),
    );

    let running = true;
    let frameIndex = 0;
    const intervalMs = Math.round(1000 / fps);

    const loop = async () => {
      while (running) {
        const frameStart = Date.now();
        try {
          // Write directly to state — frames are already prepared
          this.buttonState.set(index, { image: prepared[frameIndex] });
          frameIndex = (frameIndex + 1) % prepared.length;
          await this.requestRender();
        } catch {
          // device busy
        }
        // Only sleep the remaining time — render already consumed part of the interval
        const elapsed = Date.now() - frameStart;
        if (elapsed < intervalMs) {
          await sleep(intervalMs - elapsed);
        }
      }
    };
    loop();

    const stopFn = () => {
      running = false;
      this.animationTimers.delete(index);
    };

    this.animationTimers.set(index, { stop: stopFn });
    return { stop: stopFn };
  }

  stopAnimation(index: number): void {
    const handle = this.animationTimers.get(index);
    if (handle) {
      handle.stop();
      this.animationTimers.delete(index);
    }
  }

  stopAllAnimations(): void {
    for (const [index] of this.animationTimers) {
      this.stopAnimation(index);
    }
  }

  keepAlive(): void {
    this.setSmallWindow({});
  }

  close(): void {
    this.stopPolling();
    this.stopAllAnimations();
    this.rendering = false;
    try {
      this.device.close();
    } catch {
      // ignore
    }
    this.emit('close');
  }

  // ── internal ──────────────────────────────────────────────

  private async prepareImage(image: Buffer): Promise<Buffer> {
    return sharp(image)
      .resize(UlanziD200.ICON_SIZE, UlanziD200.ICON_SIZE, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 1 },
      })
      .png()
      .toBuffer();
  }

  /**
   * Send the current button state immediately (for initial/bulk updates).
   */
  private async sendImmediate(): Promise<void> {
    if (this.buttonState.size === 0) return;

    const indices = [...this.buttonState.keys()].sort((a, b) => a - b);
    dbg('render', `immediate SET_BUTTONS [${indices.join(',')}]`);

    // Snapshot state so async ZIP build isn't affected by concurrent changes
    const snapshot = new Map(this.buttonState);
    const zipData = await buildButtonZip(snapshot, UlanziD200.BUTTON_COLS, this.useStoredCompression);
    const packets = buildFileTransferPackets(OutCommand.SET_BUTTONS, zipData);
    await this.enqueueWrite('SET_BUTTONS', () => this.writeFileTransfer(packets, 'SET_BUTTONS'));
  }

  /**
   * Request a render. Only one render cycle runs at a time.
   * If a render is already in-flight, the change will be picked up
   * in the next cycle (the state is always read fresh at render time).
   */
  private requestRender(): Promise<void> {
    this.dirty = true;

    // If already rendering, just return a promise that resolves
    // when the next render completes (our changes will be included)
    if (this.rendering) {
      return new Promise<void>((resolve) => {
        this.renderWaiters.push(resolve);
      });
    }

    // Start the render loop
    return this.renderLoop();
  }

  /**
   * Render loop — keeps running as long as the state is dirty.
   * Always sends full SET_BUTTONS with all buttons.
   * (PARTIALLY_UPDATE_BUTTONS is unreliable in the device firmware.)
   */
  private async renderLoop(): Promise<void> {
    this.rendering = true;

    try {
      while (this.dirty) {
        this.dirty = false;

        // Small delay to batch changes from the same event cascade
        await sleep(this.batchDelayMs);
        this.dirty = false;

        if (this.buttonState.size === 0) {
          dbg('render', 'no buttons in state, skipping');
          continue;
        }

        const snapshot = new Map(this.buttonState);
        const indices = [...snapshot.keys()].sort((a, b) => a - b);
        dbg('render', `SET_BUTTONS [${indices.join(',')}] (${snapshot.size} buttons)`);

        const zipData = await buildButtonZip(snapshot, UlanziD200.BUTTON_COLS, this.useStoredCompression);
        const packets = buildFileTransferPackets(OutCommand.SET_BUTTONS, zipData);

        await this.enqueueWrite('SET_BUTTONS', () =>
          this.writeFileTransfer(packets, 'SET_BUTTONS'),
        );
      }
    } finally {
      this.rendering = false;
      const waiters = this.renderWaiters;
      this.renderWaiters = [];
      for (const r of waiters) r();
    }
  }

  /**
   * Enqueue a write operation. All device writes go through this to
   * ensure only one transfer is in-flight at a time.
   */
  private enqueueWrite(label: string, fn: () => Promise<void> | void): Promise<void> {
    const seq = ++this.writeSeq;
    const task = this.writeQueue.then(async () => {
      dbgVerbose('queue', `#${seq} ${label}: executing`);
      await fn();

      dbgVerbose('queue', `#${seq} ${label}: done`);
    }, async (err) => {
      dbg('queue', `#${seq} ${label}: previous write errored (${err}), continuing`);
      await fn();

    });
    this.writeQueue = task;
    return task;
  }

  /**
   * Write a multi-packet file transfer.
   * Packets are written synchronously in a tight loop (no event-loop yield
   * between packets) to match the behavior of working Python implementations.
   * Post-transfer delay gives the device time to decompress and render.
   */
  private async writeFileTransfer(packets: Buffer[], label: string): Promise<void> {
    dbg('send', `${label}: sending ${packets.length} packets`);
    dbgVerbose('send', `  pkt[0] header: ${hexDump(packets[0], 16)}`);

    // Tight synchronous write loop — no yielding between packets
    for (const pkt of packets) {
      this.writeRaw(pkt);
    }

    // Let the device decompress the ZIP and render before we send anything else
    if (this.postTransferDelayMs > 0) {
      await sleep(this.postTransferDelayMs);
    }
  }

  /**
   * Write a single raw packet to the HID device.
   */
  private writeRaw(packet: Buffer): number {
    return this.device.write([...packet]);
  }
}
