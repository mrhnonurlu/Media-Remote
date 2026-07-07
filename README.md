# Media Remote

Control media playback, volume, and now your PC's mouse/keyboard from your iPhone over your home Wi-Fi — running as a background tray app on Windows.

## What's included

- **Media tab**: play/pause, previous/next, ±5s seek, volume slider with mute, now-playing title/artist + album art
- **Trackpad tab**: drag to move the mouse, tap to click, two-finger drag to scroll, dedicated left/right click buttons, and a keyboard (tap-to-type + arrow keys, Enter, Backspace, Esc, Tab)
- Runs quietly in the Windows system tray — no console window
- QR code + "Start with Windows" toggle in a small GUI window
- Installable on your iPhone home screen (PWA)

## Setup (development)

```
npm install
npm start
```

Click the tray icon to see the QR code / IP address, scan it with your iPhone camera.

## Building a standalone app (no Node.js required for end users)

```
npm run dist
```

Produces both a normal installer and a portable single-.exe in `dist/`, with Electron's own Node + Chromium bundled in — nothing else needs to be installed on the machine that runs it.

## Platform support

| Feature | Windows | macOS | Linux |
|---|---|---|---|
| Play/pause/skip/volume | ✅ | ✅ (Spotify/Music) | ✅ (needs `playerctl`, `pactl`) |
| Seek ±5s | ✅ | ✅ | ✅ |
| Mute | ✅ | ✅ | ✅ |
| Album art | ✅ | ✅ | ✅ (if the player provides one) |
| Trackpad (mouse) | ✅ | ❌ not yet | ❌ not yet |
| Keyboard | ✅ | ❌ not yet | ❌ not yet |

Trackpad/keyboard is Windows-only for now — it uses the Win32 `SendInput` API. On macOS/Linux those requests return a clear "not supported yet" message rather than failing silently.

## Notes

- No login or password — anyone on your Wi-Fi can use it. Fine for home use; don't expose this to the internet.
- Default port 3000 (set via `PORT` env var if you need to change it).
- First run may trigger a Windows Firewall prompt — allow it on private networks.

## Fixing the "IP changes on restart" problem

Your phone's Home Screen icon is bookmarked to whatever exact address you added it from. If that was a raw IP (`http://192.168.1.42:3000`), it breaks the next time your PC gets a different IP.

The app now also advertises itself as **`media-remote.local`** on your network (the same trick printers and Raspberry Pis use). To fix it for good:

1. Open the tray GUI — the QR code and address now point at `http://media-remote.local:3000` instead of the IP.
2. On your iPhone, open that address in Safari, then **Share → Add to Home Screen** — replacing your old bookmark if you had one.
3. From now on, that icon keeps working even after restarts, IP changes, or moving between networks, because `.local` resolves to whatever the current IP actually is at the moment you open it.

If `.local` doesn't resolve on your network (some routers block multicast), the tray window also shows the current IP address as a fallback.

## Performance note

Every Windows action (media keys, volume, seek, status polling, mouse/keyboard) now runs through a single long-lived PowerShell process instead of spawning a new one per action — this was the source of the noticeable delay in earlier versions. Actions should now feel close to instant.

