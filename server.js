#!/usr/bin/env node
/**
 * Media Remote
 * A tiny local web server that lets your phone control media playback
 * (play/pause/skip/volume) and see what's currently playing on this
 * computer, over your home Wi-Fi.
 *
 * Run with:  node server.js
 * Then open the address it prints on your iPhone (same Wi-Fi network).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const PORT = process.env.PORT || 3000;
const PLATFORM = os.platform(); // 'win32' | 'darwin' | 'linux'
const PUBLIC_DIR = path.join(__dirname, 'public');

const VALID_ACTIONS = ['playPause', 'next', 'previous', 'volumeUp', 'volumeDown', 'seekForward', 'seekBackward', 'mute'];
const SEEK_SECONDS = 5;

/* ----------------------------------------------------------------------
 * Shared album-art cache. Whatever platform-specific status check last
 * found artwork for stashes the raw bytes here; the /artwork route just
 * serves whatever is cached. artworkKey changes whenever the track
 * (title+artist) the art belongs to changes, so the phone only re-fetches
 * the image when it actually needs to.
 * -------------------------------------------------------------------- */
let lastArtworkBuffer = null;
let lastArtworkMime = null;
let lastArtworkKey = null;

function setArtworkBuffer(buffer, mime, trackKey) {
  lastArtworkBuffer = buffer;
  lastArtworkMime = mime;
  lastArtworkKey = trackKey;
}

function clearArtwork() {
  lastArtworkBuffer = null;
  lastArtworkMime = null;
  lastArtworkKey = null;
}

function hasArtworkFor(trackKey) {
  return !!lastArtworkBuffer && lastArtworkKey === trackKey;
}

/* ----------------------------------------------------------------------
 * Windows — everything (media keys, volume/mute, seek, now-playing +
 * artwork, mouse, keyboard) is driven through ONE long-lived PowerShell
 * process instead of spawning a fresh one per action. Spawning
 * powershell.exe and reloading the WinRT/COM types from scratch takes
 * several hundred ms to over a second each time, which is exactly the
 * "significant delay" a fresh-process-per-action design produces. Here
 * we load every type once at startup and just pipe one-line commands
 * to the same process's stdin from then on, which drops each action
 * down to a normal IPC round trip (tens of ms).
 * -------------------------------------------------------------------- */
const WIN_BOOTSTRAP = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class MediaKeys {
    [DllImport("user32.dll")]
    public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioEndpointVolume {
    int NotImpl1();
    int NotImpl2();
    int GetChannelCount(out uint pnChannelCount);
    int SetMasterVolumeLevel(float fLevelDB, System.Guid pguidEventContext);
    int SetMasterVolumeLevelScalar(float fLevel, System.Guid pguidEventContext);
    int GetMasterVolumeLevel(out float pfLevelDB);
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int SetChannelVolumeLevel(uint nChannel, float fLevelDB, System.Guid pguidEventContext);
    int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, System.Guid pguidEventContext);
    int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
    int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, System.Guid pguidEventContext);
    int GetMute(out bool pbMute);
    int GetVolumeStepInfo(out uint pnStep, out uint pnStepCount);
    int VolumeStepUp(System.Guid pguidEventContext);
    int VolumeStepDown(System.Guid pguidEventContext);
    int QueryHardwareSupport(out uint pdwHardwareSupportMask);
    int GetVolumeRange(out float pflVolumeMindB, out float pflVolumeMaxdB, out float pflVolumeIncrementdB);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice {
    int Activate(ref System.Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev);
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator {
    int NotImpl1();
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumeratorComObject { }

public class Audio {
    static IAudioEndpointVolume Vol() {
        var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
        IMMDevice dev = null;
        Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out dev));
        IAudioEndpointVolume epv = null;
        var epvid = typeof(IAudioEndpointVolume).GUID;
        Marshal.ThrowExceptionForHR(dev.Activate(ref epvid, 23, 0, out epv));
        return epv;
    }
    public static float Volume {
        get { float v = -1; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out v)); return v; }
        set { Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(value, System.Guid.Empty)); }
    }
    public static bool Muted {
        get { bool m = false; Marshal.ThrowExceptionForHR(Vol().GetMute(out m)); return m; }
        set { Marshal.ThrowExceptionForHR(Vol().SetMute(value, System.Guid.Empty)); }
    }
}

public class InputSim {
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public int type; public InputUnion U; }

    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT {
        public int dx; public int dy; public uint mouseData;
        public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT {
        public ushort wVk; public ushort wScan; public uint dwFlags;
        public uint time; public IntPtr dwExtraInfo;
    }

    const int INPUT_MOUSE = 0;
    const int INPUT_KEYBOARD = 1;
    const uint MOUSEEVENTF_MOVE = 0x0001;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    const uint MOUSEEVENTF_WHEEL = 0x0800;
    const uint KEYEVENTF_UNICODE = 0x0004;
    const uint KEYEVENTF_KEYUP = 0x0002;

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    public static void MoveRelative(int dx, int dy) {
        var inputs = new INPUT[1];
        inputs[0].type = INPUT_MOUSE;
        inputs[0].U.mi = new MOUSEINPUT { dx = dx, dy = dy, dwFlags = MOUSEEVENTF_MOVE };
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void Click(string button) {
        uint down = button == "right" ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN;
        uint up = button == "right" ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP;
        var inputs = new INPUT[2];
        inputs[0].type = INPUT_MOUSE; inputs[0].U.mi = new MOUSEINPUT { dwFlags = down };
        inputs[1].type = INPUT_MOUSE; inputs[1].U.mi = new MOUSEINPUT { dwFlags = up };
        SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void Scroll(int delta) {
        var inputs = new INPUT[1];
        inputs[0].type = INPUT_MOUSE;
        inputs[0].U.mi = new MOUSEINPUT { mouseData = unchecked((uint)delta), dwFlags = MOUSEEVENTF_WHEEL };
        SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void TypeText(string text) {
        foreach (char c in text) {
            var inputs = new INPUT[2];
            inputs[0].type = INPUT_KEYBOARD;
            inputs[0].U.ki = new KEYBDINPUT { wVk = 0, wScan = c, dwFlags = KEYEVENTF_UNICODE };
            inputs[1].type = INPUT_KEYBOARD;
            inputs[1].U.ki = new KEYBDINPUT { wVk = 0, wScan = c, dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP };
            SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
        }
    }

    public static void SendVKey(int vk) {
        var inputs = new INPUT[2];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].U.ki = new KEYBDINPUT { wVk = (ushort)vk };
        inputs[1].type = INPUT_KEYBOARD;
        inputs[1].U.ki = new KEYBDINPUT { wVk = (ushort)vk, dwFlags = KEYEVENTF_KEYUP };
        SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
    }
}
'@ -ErrorAction SilentlyContinue

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}
function AwaitBool($WinRtTask) {
    $asTask = $asTaskGeneric.MakeGenericMethod([bool])
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null

$WIN_VK_MAP = @{ playPause=179; next=176; previous=177; volumeUp=175; volumeDown=174 }

function Invoke-MediaAction([string]$mediaAction) {
    if ($WIN_VK_MAP.ContainsKey($mediaAction)) {
        $vk = $WIN_VK_MAP[$mediaAction]
        [MediaKeys]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 30
        [MediaKeys]::keybd_event($vk, 0, 2, [UIntPtr]::Zero)
    }
    Write-Output 'OK'
}

function Set-VolumeLevel([double]$scalar) {
    [Audio]::Volume = $scalar
    Write-Output 'OK'
}

function Invoke-ToggleMute {
    [Audio]::Muted = -not [Audio]::Muted
    Write-Output 'OK'
}

function Get-CachedSessionManager {
    if (-not $script:sessionManager) {
        $script:sessionManager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    }
    return $script:sessionManager
}

function Get-NowPlayingStatus {
    $volume = [Audio]::Volume
    $muted = [Audio]::Muted
    $title = $null; $artist = $null; $isPlaying = $false; $artworkBase64 = $null
    try {
        $manager = Get-CachedSessionManager
        $session = $manager.GetCurrentSession()
        if ($session) {
            $info = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
            $playback = $session.GetPlaybackInfo()
            $title = $info.Title
            $artist = $info.Artist
            $isPlaying = ($playback.PlaybackStatus -eq 4)
            if ($info.Thumbnail) {
                try {
                    $stream = Await ($info.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
                    if ($stream.Size -gt 0) {
                        $reader = New-Object Windows.Storage.Streams.DataReader($stream)
                        Await ($reader.LoadAsync([uint32]$stream.Size)) ([uint32]) | Out-Null
                        $bytes = New-Object byte[] ([int]$stream.Size)
                        $reader.ReadBytes($bytes)
                        $artworkBase64 = [Convert]::ToBase64String($bytes)
                    }
                } catch {}
            }
        }
    } catch {}
    $result = @{ title = $title; artist = $artist; isPlaying = $isPlaying; volume = [math]::Round($volume * 100); muted = $muted; artwork = $artworkBase64 }
    $result | ConvertTo-Json -Compress
}

function Invoke-Seek([int]$deltaSeconds) {
    try {
        $manager = Get-CachedSessionManager
        $session = $manager.GetCurrentSession()
        if ($session) {
            $timeline = $session.GetTimelineProperties()
            $currentTicks = $timeline.Position.Ticks
            $deltaTicks = [int64]($deltaSeconds * 10000000)
            $newTicks = $currentTicks + $deltaTicks
            if ($newTicks -lt 0) { $newTicks = 0 }
            AwaitBool ($session.TryChangePlaybackPositionAsync($newTicks)) | Out-Null
        }
    } catch {}
    Write-Output 'OK'
}
`;

const WIN_VKEY_MAP = {
  Enter: 13, Backspace: 8, Tab: 9, Escape: 27, Space: 32,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46
};

const WIN_MARKER = '___WMR_END___';
let winProc = null;
let winProcBuffer = '';
let winProcQueue = [];
let winProcBusy = false;

function winProcessQueue() {
  if (winProcBusy || winProcQueue.length === 0) return;
  winProcBusy = true;
  const { command } = winProcQueue[0];
  winProc.stdin.write(command + `\r\nWrite-Output '${WIN_MARKER}'\r\n`);
}

function ensureWinProcess() {
  if (winProc && !winProc.killed) return winProc;
  const { spawn } = require('child_process');
  winProc = spawn('powershell.exe', ['-NoProfile', '-NoLogo'], { windowsHide: true });
  winProcBuffer = '';
  winProcQueue = [];
  winProcBusy = true; // stays busy until the bootstrap-flush marker comes back

  winProc.stdin.write(WIN_BOOTSTRAP.replace(/`/g, '\`') + '\r\n');
  winProc.stdin.write(`Write-Output '${WIN_MARKER}'\r\n`);

  winProc.stdout.on('data', (chunk) => {
    winProcBuffer += chunk.toString();
    let idx;
    while ((idx = winProcBuffer.indexOf(WIN_MARKER)) !== -1) {
      const response = winProcBuffer.slice(0, idx);
      winProcBuffer = winProcBuffer.slice(idx + WIN_MARKER.length);
      winProcBusy = false;
      const current = winProcQueue.shift();
      if (current) {
        clearTimeout(current.timer);
        current.resolve(response.trim());
      }
      winProcessQueue();
    }
  });
  winProc.stderr.on('data', (d) => console.error('Windows process error:', d.toString()));
  winProc.on('exit', () => {
    winProc = null;
    winProcQueue.forEach((q) => { clearTimeout(q.timer); q.reject(new Error('Windows control process exited')); });
    winProcQueue = [];
    winProcBusy = false;
  });
  winProc.on('error', (e) => {
    console.error('Windows control process error:', e.message);
    winProc = null;
  });
  return winProc;
}

function runWinCommand(command, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    ensureWinProcess();
    const entry = { command, resolve, reject, timer: null };
    entry.timer = setTimeout(() => {
      const idx = winProcQueue.indexOf(entry);
      if (idx !== -1) winProcQueue.splice(idx, 1);
      winProcBusy = false;
      winProcessQueue();
      reject(new Error('Windows command timed out'));
    }, timeoutMs);
    winProcQueue.push(entry);
    winProcessQueue();
  });
}

function winMediaAction(action) {
  const safeAction = action.replace(/'/g, "''");
  runWinCommand(`Invoke-MediaAction '${safeAction}'`).catch((e) => console.error('Windows media action error:', e.message));
}

function winSetVolume(level, callback) {
  const scalar = Math.max(0, Math.min(100, level)) / 100;
  runWinCommand(`Set-VolumeLevel ${scalar}`)
    .then(() => callback && callback())
    .catch((e) => callback && callback(e));
}

function winToggleMute(callback) {
  runWinCommand('Invoke-ToggleMute')
    .then(() => callback && callback())
    .catch((e) => callback && callback(e));
}

function winSeek(deltaSeconds, callback) {
  runWinCommand(`Invoke-Seek ${deltaSeconds}`)
    .then(() => callback && callback())
    .catch((e) => callback && callback(e));
}

function winGetStatus(callback) {
  runWinCommand('Get-NowPlayingStatus')
    .then((resultText) => {
      try {
        const parsed = JSON.parse(resultText.trim());
        if (parsed.artwork) {
          setArtworkBuffer(Buffer.from(parsed.artwork, 'base64'), 'image/jpeg', (parsed.title || '') + '|' + (parsed.artist || ''));
        }
        delete parsed.artwork;
        if (hasArtworkFor((parsed.title || '') + '|' + (parsed.artist || ''))) {
          parsed.artworkKey = lastArtworkKey;
        }
        callback(parsed);
      } catch (e) {
        callback({ title: null, artist: null, isPlaying: false, volume: null, muted: null });
      }
    })
    .catch(() => {
      callback({ title: null, artist: null, isPlaying: false, volume: null, muted: null });
    });
}

function winMouseMove(dx, dy) {
  runWinCommand(`[InputSim]::MoveRelative(${Math.round(dx)}, ${Math.round(dy)})`).catch(() => {});
}

function winMouseClick(button) {
  const safeButton = button === 'right' ? 'right' : 'left';
  runWinCommand(`[InputSim]::Click('${safeButton}')`).catch(() => {});
}

function winMouseScroll(delta) {
  runWinCommand(`[InputSim]::Scroll(${Math.round(delta)})`).catch(() => {});
}

function winTypeText(text) {
  const escaped = String(text).replace(/'/g, "''");
  runWinCommand(`[InputSim]::TypeText('${escaped}')`).catch(() => {});
}

function winSendKey(keyName) {
  const vk = WIN_VKEY_MAP[keyName];
  if (vk === undefined) return;
  runWinCommand(`[InputSim]::SendVKey(${vk})`).catch(() => {});
}


/* ----------------------------------------------------------------------
 * macOS — Spotify and Apple Music are both scriptable via AppleScript,
 * so we drive whichever one is currently running. System volume is
 * controlled directly (no app needs to be running for that part).
 * -------------------------------------------------------------------- */
function macMediaAction(action) {
  if (action === 'mute') return macToggleMute();

  const scripts = {
    playPause: [
      'if application "Spotify" is running then tell application "Spotify" to playpause',
      'if application "Music" is running then tell application "Music" to playpause'
    ],
    next: [
      'if application "Spotify" is running then tell application "Spotify" to next track',
      'if application "Music" is running then tell application "Music" to next track'
    ],
    previous: [
      'if application "Spotify" is running then tell application "Spotify" to previous track',
      'if application "Music" is running then tell application "Music" to previous track'
    ],
    volumeUp: [
      'set curVol to output volume of (get volume settings)',
      'set newVol to curVol + 10',
      'if newVol > 100 then set newVol to 100',
      'set volume output volume newVol'
    ],
    volumeDown: [
      'set curVol to output volume of (get volume settings)',
      'set newVol to curVol - 10',
      'if newVol < 0 then set newVol to 0',
      'set volume output volume newVol'
    ]
  };

  const lines = scripts[action];
  if (!lines) return;

  const args = [];
  lines.forEach((line) => args.push('-e', line));

  execFile('osascript', args, (err, _stdout, stderr) => {
    if (err) console.error('macOS media control error:', err.message, stderr || '');
  });
}

function macSeek(deltaSeconds, callback) {
  const script = `
if application "Spotify" is running then
  tell application "Spotify"
    set newPos to (player position) + (${deltaSeconds})
    if newPos < 0 then set newPos to 0
    set player position to newPos
  end tell
else if application "Music" is running then
  tell application "Music"
    set newPos to (player position) + (${deltaSeconds})
    if newPos < 0 then set newPos to 0
    set player position to newPos
  end tell
end if
`;
  execFile('osascript', ['-e', script], callback || (() => {}));
}

function macToggleMute(callback) {
  const script = `
set isMuted to output muted of (get volume settings)
if isMuted then
  set volume without output muted
else
  set volume with output muted
end if
`;
  execFile('osascript', ['-e', script], callback || (() => {}));
}

function macSetVolume(level, callback) {
  const clamped = Math.max(0, Math.min(100, Math.round(level)));
  execFile('osascript', ['-e', `set volume output volume ${clamped}`], callback || (() => {}));
}

const MAC_ART_TEMP_FILE = path.join(os.tmpdir(), 'media-remote-art.jpg');

function macGetStatus(callback) {
  const script = `
set trackName to ""
set trackArtist to ""
set playState to "stopped"
set artURL to ""
set gotArtFile to false
if application "Spotify" is running then
  tell application "Spotify"
    if player state is not stopped then
      set trackName to name of current track
      set trackArtist to artist of current track
      set playState to (player state as string)
      try
        set artURL to artwork url of current track
      end try
    end if
  end tell
else if application "Music" is running then
  tell application "Music"
    if player state is not stopped then
      set trackName to name of current track
      set trackArtist to artist of current track
      set playState to (player state as string)
      try
        set artData to data of artwork 1 of current track
        set fileRef to open for access (POSIX file "${MAC_ART_TEMP_FILE}") with write permission
        set eof fileRef to 0
        write artData to fileRef
        close access fileRef
        set gotArtFile to true
      on error
        try
          close access (POSIX file "${MAC_ART_TEMP_FILE}")
        end try
      end try
    end if
  end tell
end if
set curVol to output volume of (get volume settings)
set isMuted to output muted of (get volume settings)
return trackName & "|||" & trackArtist & "|||" & playState & "|||" & curVol & "|||" & isMuted & "|||" & artURL & "|||" & gotArtFile
`;

  execFile('osascript', ['-e', script], (err, stdout) => {
    if (err) {
      return callback({ title: null, artist: null, isPlaying: false, volume: null, muted: null });
    }
    const parts = stdout.trim().split('|||');
    const [title, artist, playState, vol, muted, artUrl, gotArtFile] = parts;
    const status = {
      title: title || null,
      artist: artist || null,
      isPlaying: playState === 'playing',
      volume: vol ? parseInt(vol, 10) : null,
      muted: muted === 'true'
    };

    const trackKey = `${status.title || ''}|${status.artist || ''}`;

    if (artUrl) {
      status.artworkUrl = artUrl;
      callback(status);
    } else if (gotArtFile === 'true') {
      fs.readFile(MAC_ART_TEMP_FILE, (readErr, buffer) => {
        if (!readErr && buffer && buffer.length) {
          setArtworkBuffer(buffer, 'image/jpeg', trackKey);
          status.artworkKey = trackKey;
        }
        callback(status);
      });
    } else {
      callback(status);
    }
  });
}

/* ----------------------------------------------------------------------
 * Linux — playerctl handles any MPRIS-compatible player (Spotify, VLC,
 * browsers, etc). pactl adjusts system volume (PulseAudio/PipeWire).
 * -------------------------------------------------------------------- */
function linuxMediaAction(action) {
  if (action === 'mute') {
    return execFile('pactl', ['set-sink-mute', '@DEFAULT_SINK@', 'toggle'], (err, _stdout, stderr) => {
      if (err) console.error('Linux mute error:', err.message, stderr || '');
    });
  }

  const cmds = {
    playPause: ['playerctl', ['play-pause']],
    next: ['playerctl', ['next']],
    previous: ['playerctl', ['previous']],
    volumeUp: ['pactl', ['set-sink-volume', '@DEFAULT_SINK@', '+5%']],
    volumeDown: ['pactl', ['set-sink-volume', '@DEFAULT_SINK@', '-5%']]
  };

  const cmd = cmds[action];
  if (!cmd) return;

  execFile(cmd[0], cmd[1], (err, _stdout, stderr) => {
    if (err) console.error('Linux media control error:', err.message, stderr || '');
  });
}

function linuxSeek(deltaSeconds, callback) {
  const arg = deltaSeconds >= 0 ? `${deltaSeconds}+` : `${Math.abs(deltaSeconds)}-`;
  execFile('playerctl', ['position', arg], callback || (() => {}));
}

function linuxSetVolume(level, callback) {
  const clamped = Math.max(0, Math.min(100, Math.round(level)));
  execFile('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${clamped}%`], callback || (() => {}));
}

function linuxGetStatus(callback) {
  execFile(
    'playerctl',
    ['metadata', '--format', '{{title}}|||{{artist}}|||{{status}}|||{{mpris:artUrl}}'],
    (err, stdout) => {
      let title = null;
      let artist = null;
      let isPlaying = false;
      let artUrl = null;
      if (!err && stdout) {
        const [t, a, status, art] = stdout.trim().split('|||');
        title = t || null;
        artist = a || null;
        isPlaying = status === 'Playing';
        artUrl = art || null;
      }

      execFile('pactl', ['get-sink-volume', '@DEFAULT_SINK@'], (verr, vstdout) => {
        let volume = null;
        if (!verr && vstdout) {
          const match = vstdout.match(/(\d+)%/);
          if (match) volume = parseInt(match[1], 10);
        }

        execFile('pactl', ['get-sink-mute', '@DEFAULT_SINK@'], (merr, mstdout) => {
          const muted = !merr && /yes/i.test(mstdout || '');
          const result = { title, artist, isPlaying, volume, muted };
          const trackKey = `${title || ''}|${artist || ''}`;

          if (artUrl && artUrl.startsWith('file://')) {
            const localPath = decodeURIComponent(artUrl.replace('file://', ''));
            fs.readFile(localPath, (readErr, buffer) => {
              if (!readErr && buffer && buffer.length) {
                const ext = path.extname(localPath).toLowerCase();
                const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
                setArtworkBuffer(buffer, mime, trackKey);
                result.artworkKey = trackKey;
              }
              callback(result);
            });
          } else if (artUrl && /^https?:\/\//.test(artUrl)) {
            result.artworkUrl = artUrl;
            callback(result);
          } else {
            callback(result);
          }
        });
      });
    }
  );
}

function seek(deltaSeconds) {
  if (PLATFORM === 'win32') return winSeek(deltaSeconds);
  if (PLATFORM === 'darwin') return macSeek(deltaSeconds);
  if (PLATFORM === 'linux') return linuxSeek(deltaSeconds);
  console.error('Unsupported platform:', PLATFORM);
}

function handleMediaAction(action) {
  if (action === 'seekForward') return seek(SEEK_SECONDS);
  if (action === 'seekBackward') return seek(-SEEK_SECONDS);
  if (action === 'mute' && PLATFORM === 'win32') return winToggleMute();
  if (PLATFORM === 'win32') return winMediaAction(action);
  if (PLATFORM === 'darwin') return macMediaAction(action);
  if (PLATFORM === 'linux') return linuxMediaAction(action);
  console.error('Unsupported platform:', PLATFORM);
}

function setVolume(level, callback) {
  if (PLATFORM === 'win32') return winSetVolume(level, callback);
  if (PLATFORM === 'darwin') return macSetVolume(level, callback);
  if (PLATFORM === 'linux') return linuxSetVolume(level, callback);
  callback(new Error('Unsupported platform'));
}

function getStatus(callback) {
  if (PLATFORM === 'win32') return winGetStatus(callback);
  if (PLATFORM === 'darwin') return macGetStatus(callback);
  if (PLATFORM === 'linux') return linuxGetStatus(callback);
  callback({ title: null, artist: null, isPlaying: false, volume: null, muted: null });
}

/* ----------------------------------------------------------------------
 * HTTP server — serves the phone UI and handles control requests.
 * No external dependencies: just Node's built-in http/fs modules.
 * -------------------------------------------------------------------- */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function readJsonBody(req, callback) {
  let data = '';
  req.on('data', (chunk) => {
    data += chunk;
    if (data.length > 1e5) req.destroy(); // safety cap
  });
  req.on('end', () => {
    if (!data) return callback(null, {});
    try {
      callback(null, JSON.parse(data));
    } catch (e) {
      callback(e);
    }
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'POST' && url.pathname.startsWith('/control/')) {
    const action = url.pathname.slice('/control/'.length);
    if (!VALID_ACTIONS.includes(action)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Unknown action' }));
      return;
    }
    handleMediaAction(action);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST' && url.pathname.startsWith('/volume/')) {
    const levelStr = url.pathname.slice('/volume/'.length);
    const level = parseInt(levelStr, 10);
    if (Number.isNaN(level) || level < 0 || level > 100) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Level must be 0-100' }));
      return;
    }
    setVolume(level, (err) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Failed to set volume' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, volume: level }));
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/status') {
    getStatus((status) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/artwork') {
    if (!lastArtworkBuffer) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('No artwork available');
      return;
    }
    res.writeHead(200, {
      'Content-Type': lastArtworkMime || 'image/jpeg',
      'Cache-Control': 'no-cache'
    });
    res.end(lastArtworkBuffer);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/mouse/move') {
    readJsonBody(req, (err, body) => {
      if (err || typeof body.dx !== 'number' || typeof body.dy !== 'number') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'dx/dy required' }));
        return;
      }
      if (PLATFORM !== 'win32') {
        res.writeHead(501, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Trackpad is currently Windows-only' }));
        return;
      }
      winMouseMove(body.dx, body.dy);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/mouse/click') {
    readJsonBody(req, (err, body) => {
      if (PLATFORM !== 'win32') {
        res.writeHead(501, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Trackpad is currently Windows-only' }));
        return;
      }
      winMouseClick(body && body.button === 'right' ? 'right' : 'left');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/mouse/scroll') {
    readJsonBody(req, (err, body) => {
      if (err || typeof body.delta !== 'number') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'delta required' }));
        return;
      }
      if (PLATFORM !== 'win32') {
        res.writeHead(501, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Trackpad is currently Windows-only' }));
        return;
      }
      winMouseScroll(body.delta);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/keyboard/type') {
    readJsonBody(req, (err, body) => {
      if (err || typeof body.text !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'text required' }));
        return;
      }
      if (PLATFORM !== 'win32') {
        res.writeHead(501, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Keyboard is currently Windows-only' }));
        return;
      }
      winTypeText(body.text);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/keyboard/key') {
    readJsonBody(req, (err, body) => {
      if (err || typeof body.key !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'key required' }));
        return;
      }
      if (PLATFORM !== 'win32') {
        res.writeHead(501, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Keyboard is currently Windows-only' }));
        return;
      }
      winSendKey(body.key);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end('Method not allowed');
    return;
  }

  const reqPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, reqPath));

  // Basic path-traversal guard
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

function getLocalIPs() {
  const addresses = [];
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach((name) => {
    nets[name].forEach((net) => {
      if (net.family === 'IPv4' && !net.internal) addresses.push(net.address);
    });
  });
  return addresses;
}

/* ----------------------------------------------------------------------
 * mDNS responder — advertises this PC as MDNS_HOSTNAME.local so the
 * phone can reach it at a stable address that survives IP changes
 * (DHCP renewals, reboots, switching networks). Same trick printers,
 * Raspberry Pis, etc. use. Once the phone's Home Screen bookmark points
 * at http://media-remote.local:PORT instead of a raw IP, it keeps
 * working after every restart with no re-scanning required.
 * -------------------------------------------------------------------- */
const MDNS_HOSTNAME = 'media-remote';
let mdnsInstance = null;

function startMdnsResponder(port) {
  const fqdn = `${MDNS_HOSTNAME}.local`;
  try {
    const mdns = require('multicast-dns')();
    mdnsInstance = mdns;

    mdns.on('query', (query) => {
      const wantsUs = query.questions.some(
        (q) => (q.type === 'A' || q.type === 'ANY') && q.name.toLowerCase() === fqdn
      );
      if (!wantsUs) return;
      const ips = getLocalIPs();
      if (!ips.length) return;
      mdns.respond({
        answers: ips.map((ip) => ({ name: fqdn, type: 'A', ttl: 120, data: ip }))
      });
    });

    mdns.on('error', (err) => {
      console.error(`mDNS responder error (http://${fqdn}:${port} may not resolve, but the IP address will still work):`, err.message);
    });

    return fqdn;
  } catch (e) {
    console.error(`Could not start the mDNS responder (http://${fqdn}:${port} will not be available, but the IP address will still work):`, e.message);
    return null;
  }
}

function start(port = PORT, quiet = false) {
  const fqdn = startMdnsResponder(port);
  server.listen(port, '0.0.0.0', () => {
    if (quiet) return;
    const addresses = getLocalIPs();
    console.log('\nMedia Remote is running (' + PLATFORM + ')');
    console.log('\nOpen this on your iPhone — make sure it is on the same Wi-Fi:\n');
    if (fqdn) {
      console.log(`  http://${fqdn}:${port}   <- use this one, it survives IP changes`);
    }
    if (addresses.length) {
      addresses.forEach((addr) => console.log(`  http://${addr}:${port}`));
    } else {
      console.log(`  Could not auto-detect your IP. Find it manually, then visit http://<that-ip>:${port}`);
    }
    console.log('\nPress Ctrl+C to stop.\n');
  });
  return server;
}

// Run directly with `node server.js` -> behaves exactly as before.
// Required as a module (e.g. by the Electron app) -> just exposes start().
if (require.main === module) {
  start(PORT);
}

module.exports = { start, getLocalIPs, PORT, MDNS_HOSTNAME };
