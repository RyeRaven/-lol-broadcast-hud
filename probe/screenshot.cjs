'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const [url, out, width, height] = process.argv.slice(2);
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: Number(width) || 1920, height: Number(height) || 1080, show: false, webPreferences: { offscreen: true } });
  try {
    await win.loadURL(url);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const image = await win.webContents.capturePage();
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, image.toPNG());
    console.log('SAVED ' + out + ' ' + image.getSize().width + 'x' + image.getSize().height);
  } catch (error) {
    console.error('FAIL ' + (error && error.stack || error));
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
