#!/usr/bin/env node
// launch.mjs — start a dedicated Chrome instance for GreedySearch
//
// This Chrome instance uses --disable-features=DevToolsPrivacyUI which suppresses
// the "Allow remote debugging?" dialog entirely. It runs on port 9222 so it doesn't
// conflict with your main Chrome session (which may use port 9223).
//
// search.mjs passes CDP_PROFILE_DIR so cdp.mjs targets this dedicated Chrome
// without ever touching the user's main Chrome DevToolsActivePort file.
//
// Usage:
//   node launch.mjs          — launch (or report if already running)
//   node launch.mjs --kill   — stop and restore original DevToolsActivePort
//   node launch.mjs --status — check if running

import { spawn } from 'child_process';
import { existsSync, writeFileSync, readFileSync, mkdirSync, unlinkSync } from 'fs';
import { tmpdir, platform } from 'os';
import { join } from 'path';
import http from 'http';

const PORT        = 9222;
const PROFILE_DIR = join(tmpdir(), 'greedysearch-chrome-profile');
const ACTIVE_PORT = join(PROFILE_DIR, 'DevToolsActivePort');
const PID_FILE    = join(tmpdir(), 'greedysearch-chrome.pid');

function findChrome() {
  const os = platform();
  const candidates = os === 'win32' ? [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ] : os === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ] : [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
  ];
  return candidates.find(existsSync) || null;
}

const CHROME_FLAGS = [
  `--remote-debugging-port=${PORT}`,
  '--disable-features=DevToolsPrivacyUI',      // suppresses "Allow remote debugging?" dialog
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-default-apps',
  `--user-data-dir=${PROFILE_DIR}`,
  '--profile-directory=Default',
  'about:blank',
];

// ---------------------------------------------------------------------------


function isRunning() {
  if (!existsSync(PID_FILE)) return false;
  const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim());
  if (!pid) return false;
  try { process.kill(pid, 0); return pid; } catch { return false; }
}

function httpGet(url, timeoutMs = 1000) {
  return new Promise(resolve => {
    const req = http.get(url, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ ok: res.statusCode === 200, body }));
    });
    req.on('error', () => resolve({ ok: false }));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve({ ok: false }); });
  });
}


async function writePortFile(timeoutMs = 15000) {
  // Chrome on Windows doesn't write DevToolsActivePort — we build it from the HTTP API.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { ok, body } = await httpGet(`http://localhost:${PORT}/json/version`, 1500);
    if (ok) {
      try {
        const { webSocketDebuggerUrl } = JSON.parse(body);
        // webSocketDebuggerUrl = "ws://localhost:9223/devtools/browser/..."
        const wsPath = new URL(webSocketDebuggerUrl).pathname;
        // Write in DevToolsActivePort format: port on line 1, path on line 2
        const content = `${PORT}\n${wsPath}`;
        writeFileSync(ACTIVE_PORT, content, 'utf8');
        return true;
      } catch { /* malformed response, retry */ }
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

// ---------------------------------------------------------------------------

async function main() {
  const arg = process.argv[2];

  if (arg === '--kill') {
    const pid = isRunning();
    if (pid) {
      try { process.kill(pid, 'SIGTERM'); console.log(`Stopped Chrome (pid ${pid}).`); }
      catch (e) { console.error(`Failed: ${e.message}`); }
    } else {
      console.log('GreedySearch Chrome is not running.');
    }
    return;
  }

  if (arg === '--status') {
    const pid = isRunning();
    if (pid) console.log(`Running — pid ${pid}, port ${PORT}, DevToolsActivePort redirected.`);
    else      console.log('Not running.');
    return;
  }

  // Already running?
  const existing = isRunning();
  if (existing) {
    const ready = await writePortFile(5000);
    if (ready) {
      console.log(`GreedySearch Chrome already running (pid ${existing}, port ${PORT}).`);
      console.log('Dedicated GreedySearch DevToolsActivePort is ready.');
      return;
    }
    // Stale PID — process alive but not Chrome on port 9223. Fall through to fresh launch.
    console.log(`Stale PID ${existing} detected (not Chrome on port ${PORT}) — launching fresh.`);
    try { unlinkSync(PID_FILE); } catch {}
  }

  const CHROME_EXE = process.env.CHROME_PATH || findChrome();
  if (!CHROME_EXE) {
    console.error('Chrome not found. Tried standard paths for your OS.');
    console.error('Set the CHROME_PATH environment variable to point to your Chrome binary.');
    process.exit(1);
  }

  mkdirSync(PROFILE_DIR, { recursive: true });

  console.log(`Launching GreedySearch Chrome on port ${PORT}...`);
  const proc = spawn(CHROME_EXE, CHROME_FLAGS, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  proc.unref();
  writeFileSync(PID_FILE, String(proc.pid));

  // Wait for Chrome HTTP endpoint and build the dedicated DevToolsActivePort file
  const portFileReady = await writePortFile();
  if (!portFileReady) {
    console.error('Chrome did not become ready within 15s.');
    process.exit(1);
  }

  console.log(`Ready. No more "Allow remote debugging?" dialogs.`);
  console.log('GreedySearch now uses its own isolated DevToolsActivePort file.');
}

main();
