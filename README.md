# ulanzi-d200

Node.js library for the **Ulanzi D200** USB LCD key controller.

## Features

- Set images (PNG/JPEG) and labels on all 13 LCD buttons
- Receive button press and release events
- Adjust display brightness (0–100%)
- Configure label style (font, color, alignment, size)
- Control the info window (clock, system stats, background mode)
- Animate buttons with frame sequences (GIF/video frames)
- Partial button updates for fast single-key changes
- Works on macOS and Linux (including Raspberry Pi)

## Hardware

- **13 programmable LCD buttons** (196×196 pixels each) in a 5×5×3 grid (last row has 3)
- **1 info window** (clock/stats) — the large panel on the right
- USB HID communication — VID `0x2207`, PID `0x0019`

## Installation

```bash
npm install ulanzi-d200
```

### Linux udev rules

On Linux, you need udev rules so non-root users can access the device. Create `/etc/udev/rules.d/99-ulanzi-d200.rules`:

```
SUBSYSTEM=="usb", ATTRS{idVendor}=="2207", ATTRS{idProduct}=="0019", MODE="0666"
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="2207", ATTRS{idProduct}=="0019", MODE="0666"
```

Then reload:

```bash
sudo udevadm control --reload-rules && sudo udevadm trigger
```

## Quick start

```typescript
import { UlanziD200 } from 'ulanzi-d200';
import sharp from 'sharp';

const deck = UlanziD200.open();

// Set brightness
deck.setBrightness(80);

// Set a button image from a PNG file
import fs from 'fs';
const icon = fs.readFileSync('my-icon.png');
await deck.setButton(0, { image: icon, label: 'Hello' });

// Listen for button presses
deck.startPolling();
deck.on('press', (index) => console.log(`Button ${index} pressed`));
deck.on('release', (index) => console.log(`Button ${index} released`));

// Clean up
process.on('SIGINT', () => deck.close());
```

## API

### `UlanziD200.open(): UlanziD200`

Opens the first available device. Throws if none found.

### `UlanziD200.listDevices(): HID.Device[]`

Returns all connected D200 devices.

### `deck.setBrightness(value: number): void`

Set display brightness (0–100).

### `deck.setButtons(buttons, partial?): Promise<void>`

Set images/labels on multiple buttons. Keys are button indices (0–12). Values can be:
- `ButtonConfig` object: `{ image?: Buffer, label?: string }`
- `Buffer` (image only)
- `string` (label only)

Set `partial = true` to only update specified buttons (faster).

### `deck.setButton(index, config): Promise<void>`

Shorthand for updating a single button with partial update.

### `deck.clearButtons(): Promise<void>`

Clear all buttons to blank.

### `deck.animateButton(index, frames, fps?): { stop() }`

Animate a button by cycling through image frames. Returns an object with a `stop()` method. Max practical FPS is ~15 due to USB bandwidth.

### `deck.stopAnimation(index): void`

Stop animation on a specific button.

### `deck.setLabelStyle(style): void`

Set the global label style:
```typescript
{
  align?: 'top' | 'bottom' | 'center';
  color?: string;      // hex without '#', e.g. 'FFFFFF'
  fontName?: string;
  showTitle?: boolean;
  size?: number;
  weight?: number;
}
```

### `deck.setSmallWindow(data): void`

Update the info window:
```typescript
{
  mode?: SmallWindowMode; // STATS=0, CLOCK=1, BACKGROUND=2
  cpu?: number;
  mem?: number;
  time?: string;  // HH:MM:SS
  gpu?: number;
}
```

### `deck.startPolling(intervalMs?): void`

Start polling for button events (default: 50ms interval).

### `deck.stopPolling(): void`

Stop polling.

### Events

```typescript
deck.on('press', (index: number) => {});
deck.on('release', (index: number) => {});
deck.on('button', (event: ButtonPressData) => {}); // raw event with state
deck.on('device-info', (info: string) => {});
deck.on('error', (err: Error) => {});
deck.on('close', () => {});
```

### `deck.close(): void`

Close the device, stop polling, stop all animations.

## Examples

```bash
# Full demo with colored buttons and press handling
npx ts-node examples/demo.ts

# Animation demo (rainbow + optional GIF)
npx ts-node examples/animation.ts [path-to.gif]
```

## Button layout

```
Index:  0   1   2   3   4
        5   6   7   8   9
       10  11  12       [info window]

Manifest key: {col}_{row}  (e.g. button 7 = "2_1")
```

## Protocol notes

Communication uses 1024-byte HID packets with a `0x7C7C` header. Button images are sent as ZIP files containing a `manifest.json` and PNG icons. A dummy file workaround avoids a device bug where bytes at certain offsets (1016, 2040, ...) cannot be `0x00` or `0x7C`.

## License

MIT
