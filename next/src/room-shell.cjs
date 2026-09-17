'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const options = JSON.parse(process.env.NONAME_ROOM_HOST);
app.setName('Noname Agent Room');
app.setPath('userData', options.profile);
for (const name of ['logs', 'crashDumps']) {
  const dir = path.join(options.profile, name); fs.mkdirSync(dir, { recursive: true }); app.setPath(name, dir);
}
app.on('window-all-closed', () => app.quit());
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1280, height: 900, show: options.visible, title: '无名杀 · 本地联机',
    webPreferences: { preload: path.join(__dirname, 'room-preload.cjs'), nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  win.loadURL('about:blank');
});
