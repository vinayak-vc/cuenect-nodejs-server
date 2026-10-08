# Release Notes - Cuenect Node.js Signaling Bridge Server

## [2.1.0] - 2026-09-23

### Added
- **Compact In-Place Live Dashboard**:
  - Re-architected console UI into a 20-line side-by-side layout: QR code on the left (35–39 cols) and live status/endpoints/sessions/feed on the right (35–39 cols).
  - Fits inside any standard 80x24 terminal window without line-wrapping or viewport scrolling.
  - Zero duplicate screen blocks in scrollback history: writes from ANSI cursor home (`\x1b[H`) without screen-erasing (`\x1b[2J`).
- **Targeted Micro-Updates**:
  - Uptime ticks once per second updating only the 8 characters of `uptime` directly in place (`\x1b[4;colH`).
  - Relay count and client metrics update in place without re-rendering the whole block.
- **Hologram Crystal Branding Assets**:
  - Added multi-resolution favicons and icons (`favicon.ico`, `favicon-32x32.png`, `icon-192.png`, `icon-512.png`, `favicon.svg`) served under `/favicon.ico` and `/favicon.png`.
  - Added styled root `/` landing page with glowing holographic emblem.
- **Dynamic Model Database Resolution**:
  - Auto-discovers `CuenectDatabase.json` across OneDrive known folder redirection paths and local profile paths.
  - Dynamically broadcasts real local `.glb` models from `StreamingAssets` and `LocalLow`.

### Changed
- **Windows Mouse Text Selection Enabled**:
  - Updated `windowsConsole.js` to preserve `ENABLE_QUICK_EDIT_MODE (0x0040)`, allowing users to freely highlight, select, and copy IPs, URLs, and errors with the mouse.
- **High-Frequency Event Throttling**:
  - Throttled `hologram-joystick-action` and `hologram-model-transform` activity feed logs to at most once per second, while continuing to increment the relayed packet counter on every frame.
  - Filtered internal/ping packets from flooding the feed.
