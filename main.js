const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
const path = require('path');
const QRCode = require('qrcode');
const { start, getLocalIPs, PORT, MDNS_HOSTNAME } = require('./server');

let tray = null;
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 380,
    height: 640,
    resizable: false,
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Clicking the window's close button hides it to the tray instead of
  // quitting the app - this is what makes it a background/tray app.
  win.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Show Remote Info',
      click: () => {
        win.show();
        win.focus();
      }
    },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (menuItem) => {
        app.setLoginItemSettings({ openAtLogin: menuItem.checked });
      }
    },
    { type: 'separator' },
    {
      label: 'Quit Media Remote',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.ico'));
  const trayIcon = icon.resize({ width: 16, height: 16 });
  tray = new Tray(trayIcon);
  tray.setToolTip('Media Remote — running in background');
  tray.setContextMenu(buildTrayMenu());

  tray.on('click', () => {
    if (win.isVisible()) {
      win.hide();
    } else {
      win.show();
      win.focus();
    }
  });
}

// Only one instance of the app should run at a time (it owns port 3000).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    start(PORT, true); // quiet: true - no console.log spam, this runs headless
    createWindow();
    createTray();
  });

  // Keep running in the background even if the window is closed -
  // the tray icon is the only way to fully quit.
  app.on('window-all-closed', (event) => {
    event.preventDefault();
  });

  ipcMain.handle('get-connection-info', async () => {
    const ips = getLocalIPs();
    const fqdn = `${MDNS_HOSTNAME}.local`;
    const stableUrl = `http://${fqdn}:${PORT}`;
    const ipUrl = ips.length ? `http://${ips[0]}:${PORT}` : null;
    // The .local address is what should be added to the Home Screen - it
    // keeps working after the PC's IP changes. The QR code and primary
    // display both point at it; the raw IP is shown as a fallback in case
    // mDNS doesn't resolve on a particular network.
    let qrDataUrl = null;
    try {
      qrDataUrl = await QRCode.toDataURL(stableUrl, { margin: 1, width: 220, color: { dark: '#121114', light: '#f0ece4' } });
    } catch (e) {
      qrDataUrl = null;
    }
    return { ips, port: PORT, stableUrl, ipUrl, qrDataUrl };
  });

  ipcMain.handle('get-autostart', () => app.getLoginItemSettings().openAtLogin);

  ipcMain.handle('set-autostart', (_event, enabled) => {
    app.setLoginItemSettings({ openAtLogin: !!enabled });
    tray.setContextMenu(buildTrayMenu());
    return app.getLoginItemSettings().openAtLogin;
  });
}
