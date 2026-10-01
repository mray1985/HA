/**
 * HA Tax Preparer — desktop main process.
 *
 * Starts the preparer's server inside the app, bound to 127.0.0.1 on a free
 * port, with the files the installer bundles: the built site, llama.cpp
 * `llama-server`, and the approved model files. Case data stays in the app's
 * encrypted browser storage; the server's own data (sign-in database, token
 * key, model verification) lives in the user's app-data folder. Nothing is
 * downloaded and no page leaves the computer.
 */

import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The preparer folder when running from the repository (desktop/dist → preparer). */
const PREPARER_ROOT = resolve(__dirname, '..', '..');

function bundledPaths(): { clientDist: string; modelsDir: string; llamaServer: string } {
  if (app.isPackaged) {
    const r = process.resourcesPath;
    return { clientDist: join(r, 'client'), modelsDir: join(r, 'models'), llamaServer: join(r, 'llama-cpp', 'llama-server.exe') };
  }
  return {
    clientDist: join(PREPARER_ROOT, 'client', 'dist'),
    modelsDir: join(PREPARER_ROOT, 'models'),
    llamaServer: join(PREPARER_ROOT, 'tools', 'llama-cpp', 'bin', 'llama-server.exe'),
  };
}

let stopRuntime: (() => void) | null = null;
let closeServer: (() => Promise<void>) | null = null;

async function launch(): Promise<void> {
  const paths = bundledPaths();
  if (!existsSync(join(paths.clientDist, 'index.html'))) {
    dialog.showErrorBox('HA Tax Preparer', `The application files are missing (${paths.clientDist}). Reinstall the application.`);
    app.quit();
    return;
  }

  // The server reads these when it loads.
  const dataDir = join(app.getPath('userData'), 'data');
  mkdirSync(dataDir, { recursive: true });
  process.env.HATAX_DB_PATH = join(dataDir, 'hatax.db');
  process.env.CLIENT_DIST = paths.clientDist;
  process.env.HATAX_MODELS_DIR = paths.modelsDir;
  process.env.HATAX_LLAMA_SERVER = paths.llamaServer;
  process.env.NODE_ENV = 'production';

  const { startServer } = await import('../../server/src/app.js');
  const { modelRuntime } = await import('../../server/src/modelRuntime.js');
  stopRuntime = () => modelRuntime.killNow();
  const server = await startServer({ port: 0, host: '127.0.0.1', clientDist: paths.clientDist });
  closeServer = server.close;
  const origin = `http://127.0.0.1:${server.port}`;

  // Verify the bundled model files in the background, so the first document is not delayed by it.
  void modelRuntime.status();

  Menu.setApplicationMenu(null);
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    title: 'HA Tax Preparer',
    backgroundColor: '#0f172a',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  // The app is its own origin; a web or mail link opens in the preparer's
  // browser. Anything else (a dropped file's file:// URL) is not opened.
  const openOutside = (url: string) => {
    if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url);
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(origin)) openOutside(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(origin)) {
      event.preventDefault();
      openOutside(url);
    }
  });
  win.once('ready-to-show', () => win.show());
  await win.loadURL(`${origin}/preparer`);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(launch).catch((err) => {
    dialog.showErrorBox('HA Tax Preparer', `The application could not start: ${err instanceof Error ? err.message : String(err)}`);
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    // Model processes would outlive the app on Windows.
    stopRuntime?.();
    void closeServer?.();
  });
}
