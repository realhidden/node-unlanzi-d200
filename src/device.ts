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
  'disconnect': () => void;
  'reconnect': () => void;
}

export interface ReconnectOptions {
  /** Enable auto-reconnect when the device disconnects (default: false) */
  autoReconnect?: boolean;
  /** Delay in ms between reconnection attempts (default: 2000) */
  reconnectDelayMs?: number;
  /** Max reconnection attempts before giving up. 0 = infinite (default: 0) */
  maxAttempts?: number;
  /** Re-apply button state after reconnecting (default: true) */
  restoreState?: boolean;
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
  /**
   * Treat the info window (button 13) as a normal button.
   * When true, taps on the info window emit 'press'/'release' events
   * like any other button. When false (default), button 13 events are
   * filtered as periodic status updates and only emit 'info-window'.
   */
  infoWindowAsButton = false;

  private device: HID.HID;
  private _connected = true;
  private polling = false;
  private wasPolling = false;
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

  // Reconnection
  private reconnectOpts: Required<ReconnectOptions> = {
    autoReconnect: false,
    reconnectDelayMs: 2000,
    maxAttempts: 0,
    restoreState: true,
  };
  private reconnecting = false;
  private reconnectAbort: (() => void) | null = null;
  private lastBrightness: number | null = null;
  private lastLabelStyle: LabelStyle | null = null;

  /** True when the HID device is open and usable */
  get connected(): boolean {
    return this._connected;
  }

  constructor(device: HID.HID, reconnectOpts?: ReconnectOptions) {
    super();
    this.device = device;
    if (reconnectOpts) {
      Object.assign(this.reconnectOpts, reconnectOpts);
    }
  }

  /**
   * Open the first available Ulanzi D200 device.
   */
  static open(reconnectOpts?: ReconnectOptions): UlanziD200 {
    const hid = UlanziD200.openHID();
    return new UlanziD200(hid, reconnectOpts);
  }

  /**
   * Open the device with retries — useful when the device may still be
   * enumerating on USB (e.g. after a reboot or hot-plug).
   *
   * @param timeoutMs - Max time to wait for the device (default: 30000)
   * @param intervalMs - Time between attempts (default: 1000)
   */
  static async openWithRetry(
    options?: { timeoutMs?: number; intervalMs?: number } & ReconnectOptions,
  ): Promise<UlanziD200> {
    const timeoutMs = options?.timeoutMs ?? 30_000;
    const intervalMs = options?.intervalMs ?? 1_000;

    const deadline = Date.now() + timeoutMs;
    let lastError: Error | undefined;

    while (Date.now() < deadline) {
      try {
        const hid = UlanziD200.openHID();
        dbg('hid', 'openWithRetry: connected');
        return new UlanziD200(hid, options);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        dbg('hid', `openWithRetry: ${lastError.message}, retrying in ${intervalMs}ms`);
        await sleep(Math.min(intervalMs, deadline - Date.now()));
      }
    }

    throw lastError ?? new Error('Ulanzi D200 not found');
  }

  /**
   * Low-level: open and return the raw HID device handle.
   */
  private static openHID(): HID.HID {
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
        return hid;
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
    this.attachListeners();
  }

  private attachListeners(): void {
    this.device.on('data', (data: Buffer) => {
      this.handleData(data);
    });
    this.device.on('error', (err: Error) => {
      this.handleDeviceError(err);
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
            // Button 13 is the info window. It sends periodic status
            // updates (~8/sec) alongside real tap events.
            if (press.index === 13 && !this.infoWindowAsButton) {
              dbgVerbose('recv', `info-window mode=${press.state}`);
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
        // Device ack/status messages — safe to ignore
        case InCommand.ACK_0103:
        case InCommand.ACK_010B:
          dbgVerbose('recv', `${cmdName} (ack)`);
          break;
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
    this.lastBrightness = brightness;
    const data = Buffer.from(String(brightness), 'utf-8');
    this.enqueueWrite('SET_BRIGHTNESS', () => { this.writeRaw(buildPacket(OutCommand.SET_BRIGHTNESS, data)); });
  }

  /**
   * Set the label style for all buttons.
   */
  setLabelStyle(style: LabelStyle): void {
    this.lastLabelStyle = { ...style };
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
   * Set the info window (the large panel, button 13) display mode and data.
   *
   * Modes:
   * - STATS (0): Shows CPU%, MEM%, GPU% gauges
   * - CLOCK (1): Shows current time
   * - BACKGROUND (2): Shows Ulanzi logo / custom background
   *
   * The info window needs periodic updates to stay alive (especially
   * for CLOCK mode — send every 1-5 seconds to keep the time current).
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
   * Start a clock on the info window that auto-updates every second.
   * Returns a stop function.
   */
  async startClock(): Promise<{ stop: () => void }> {
    // Set a black background on button 13 to clear the Ulanzi logo
    const black = Buffer.from(
      '<svg width="196" height="196" xmlns="http://www.w3.org/2000/svg">' +
      '<rect width="196" height="196" fill="black"/></svg>',
    );
    await this.setButton(13, { image: black });

    this.setSmallWindow({ mode: SmallWindowMode.CLOCK });
    const timer = setInterval(() => {
      this.setSmallWindow({ mode: SmallWindowMode.CLOCK });
    }, 1000);
    return {
      stop: () => clearInterval(timer),
    };
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
      if (index < 0 || index > 13) continue;

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
    if (index < 0 || index > 13) return;

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

    // Pre-process all frames once — use JPEG for smaller sizes (3-4x smaller
    // than PNG), which means fewer HID packets per frame = smoother animation
    const prepared = await Promise.all(
      frames.map((f) => this.prepareImage(f, true)),
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

  /**
   * Configure auto-reconnect behavior.
   */
  setReconnectOptions(opts: ReconnectOptions): void {
    Object.assign(this.reconnectOpts, opts);
  }

  close(): void {
    // Cancel any pending reconnect
    this.reconnectAbort?.();
    this.reconnectAbort = null;
    this.reconnecting = false;

    this.stopPolling();
    this.stopAllAnimations();
    this.rendering = false;
    this._connected = false;
    try {
      this.device.close();
    } catch {
      // ignore
    }
    this.emit('close');
  }

  /**
   * Handle a device error — if it looks like a disconnect, trigger
   * the reconnect flow instead of just emitting 'error'.
   */
  private handleDeviceError(err: Error): void {
    // If already disconnected, ignore follow-up errors
    if (!this._connected) return;

    // HID read errors on a disconnected device are the primary signal.
    // node-hid throws "could not read from HID device" or similar.
    dbg('hid', `device error: ${err.message}`);
    this._connected = false;
    this.wasPolling = this.polling;

    // Stop writing to the dead handle
    this.stopPolling();
    // Reset the write queue so it doesn't block reconnect
    this.writeQueue = Promise.resolve();
    this.rendering = false;
    const waiters = this.renderWaiters;
    this.renderWaiters = [];
    for (const r of waiters) r();

    this.emit('disconnect');
    this.emit('error', err);

    if (this.reconnectOpts.autoReconnect) {
      this.startReconnect();
    }
  }

  /**
   * Begin the reconnection loop. Tries to re-open the HID device
   * and restore state. Emits 'reconnect' on success.
   */
  private startReconnect(): void {
    if (this.reconnecting) return;
    this.reconnecting = true;
    let cancelled = false;

    this.reconnectAbort = () => { cancelled = true; };

    const attempt = async () => {
      const { reconnectDelayMs, maxAttempts, restoreState } = this.reconnectOpts;
      let tries = 0;

      while (!cancelled) {
        tries++;
        dbg('reconnect', `attempt ${tries}${maxAttempts > 0 ? `/${maxAttempts}` : ''}`);

        try {
          const hid = UlanziD200.openHID();

          // Success — swap in the new handle
          try { this.device.close(); } catch { /* old handle is dead */ }
          this.device = hid;
          this._connected = true;
          this.reconnecting = false;
          this.reconnectAbort = null;

          dbg('reconnect', 'connected');

          // Re-attach polling if it was active before disconnect
          if (this.wasPolling) {
            this.polling = false; // reset so startPolling works
            this.startPolling();
          }

          // Restore state
          if (restoreState) {
            await this.restoreDeviceState();
          }

          this.emit('reconnect');
          return;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          dbg('reconnect', `failed: ${msg}`);
        }

        if (maxAttempts > 0 && tries >= maxAttempts) {
          dbg('reconnect', `gave up after ${tries} attempts`);
          this.reconnecting = false;
          this.reconnectAbort = null;
          return;
        }

        await sleep(reconnectDelayMs);
      }

      this.reconnecting = false;
      this.reconnectAbort = null;
    };

    attempt().catch((err) => {
      dbg('reconnect', `unexpected error: ${err}`);
      this.reconnecting = false;
      this.reconnectAbort = null;
    });
  }

  /**
   * Re-send brightness, label style, and button images after reconnect.
   */
  private async restoreDeviceState(): Promise<void> {
    dbg('reconnect', 'restoring device state');

    if (this.lastBrightness != null) {
      const data = Buffer.from(String(this.lastBrightness), 'utf-8');
      this.enqueueWrite('RESTORE_BRIGHTNESS', () => {
        this.writeRaw(buildPacket(OutCommand.SET_BRIGHTNESS, data));
      });
    }

    if (this.lastLabelStyle) {
      const payload = {
        Align: this.lastLabelStyle.align ?? 'bottom',
        Color: parseInt(this.lastLabelStyle.color ?? 'FFFFFF', 16),
        FontName: this.lastLabelStyle.fontName ?? 'Roboto',
        ShowTitle: this.lastLabelStyle.showTitle ?? true,
        Size: this.lastLabelStyle.size ?? 10,
        Weight: this.lastLabelStyle.weight ?? 80,
      };
      const data = Buffer.from(JSON.stringify(payload), 'utf-8');
      this.enqueueWrite('RESTORE_LABEL_STYLE', () => {
        this.writeRaw(buildPacket(OutCommand.SET_LABEL_STYLE, data));
      });
    }

    if (this.buttonState.size > 0) {
      await this.sendImmediate();
    }
  }

  // ── internal ──────────────────────────────────────────────

  private async prepareImage(image: Buffer, jpeg = false): Promise<Buffer> {
    let pipeline = sharp(image)
      .resize(UlanziD200.ICON_SIZE, UlanziD200.ICON_SIZE, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 1 },
      });
    // JPEG is much smaller (~5-8KB vs ~25KB PNG) — better for animation
    if (jpeg) {
      pipeline = pipeline.flatten({ background: { r: 0, g: 0, b: 0 } }).jpeg({ quality: 85 });
    } else {
      pipeline = pipeline.png();
    }
    return pipeline.toBuffer();
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
    if (!this._connected) {
      dbg('queue', `${label}: skipped (disconnected)`);
      return Promise.resolve();
    }
    const seq = ++this.writeSeq;
    const task = this.writeQueue.then(async () => {
      dbgVerbose('queue', `#${seq} ${label}: executing`);
      await fn();
      dbgVerbose('queue', `#${seq} ${label}: done`);
    }, async (prevErr) => {
      dbg('queue', `#${seq} ${label}: previous write errored (${prevErr}), continuing`);
      try {
        await fn();
      } catch (err) {
        // Write failure on a connected device likely means disconnect
        if (this._connected) {
          this.handleDeviceError(err instanceof Error ? err : new Error(String(err)));
        }
        throw err;
      }
    }).catch((err) => {
      // Catch write errors from the success path too
      if (this._connected) {
        this.handleDeviceError(err instanceof Error ? err : new Error(String(err)));
      }
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
   * Throws if the device is disconnected.
   */
  private writeRaw(packet: Buffer): number {
    if (!this._connected) {
      throw new Error('Device is disconnected');
    }
    return this.device.write([...packet]);
  }
}
