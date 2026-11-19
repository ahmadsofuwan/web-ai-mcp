import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_DIR = path.resolve(__dirname, '..');
const LOG_FILE = path.join(SERVER_DIR, 'server.log');
const PID_FILE = path.join(SERVER_DIR, 'server.pid');

function sendMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

function readOneMessage() {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let expectedLen = null;

    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      if (expectedLen === null && buffer.length >= 4) {
        expectedLen = buffer.readUInt32LE(0);
        buffer = buffer.subarray(4);
      }
      if (expectedLen !== null && buffer.length >= expectedLen) {
        cleanup();
        const raw = buffer.subarray(0, expectedLen).toString('utf8');
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(new Error(`Invalid JSON message: ${err.message}`));
        }
      }
    }

    function onEnd() {
      cleanup();
      resolve({ action: 'status' });
    }

    function onError(err) {
      cleanup();
      reject(err);
    }

    function cleanup() {
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.off('error', onError);
    }

    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function checkHealth(baseUrl) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 1200);
    const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return false;
    const data = await res.json().catch(() => ({}));
    return Boolean(data?.ok);
  } catch {
    return false;
  }
}

async function stopServer(cfg, baseUrl) {
  const running = await checkHealth(baseUrl);
  if (!running) {
    return { stopped: true, wasRunning: false };
  }

  // 1. Coba shutdown halus lewat API
  try {
    await fetch(`${baseUrl}/api/shutdown`, {
      method: 'POST',
      headers: { 'X-MCP-Token': cfg.authToken },
    });
  } catch {
    // fallback below
  }

  for (let i = 0; i < 12; i++) {
    await sleep(200);
    if (!(await checkHealth(baseUrl))) {
      return { stopped: true, wasRunning: true };
    }
  }

  // 2. Fallback: baca PID file jika ada
  if (fs.existsSync(PID_FILE)) {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // ignore
      }
    }
  }

  // 3. Fallback Windows: temukan PID yang listen di port config (jika server lama belum punya /api/shutdown)
  if (process.platform === 'win32' && (await checkHealth(baseUrl))) {
    try {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `$p = (Get-NetTCPConnection -LocalAddress '${cfg.host}' -LocalPort ${cfg.port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; if ($p) { $proc = Get-Process -Id $p -ErrorAction SilentlyContinue; if ($proc -and $proc.ProcessName -eq 'node') { Stop-Process -Id $p -Force; Write-Output $p } }`,
        ],
        { encoding: 'utf8', timeout: 5000, windowsHide: true }
      );
      if (out.trim()) {
        await sleep(400);
      }
    } catch {
      // ignore
    }
  }

  const stillUp = await checkHealth(baseUrl);
  return { stopped: !stillUp, wasRunning: true };
}

async function startServer(cfg, baseUrl) {
  if (await checkHealth(baseUrl)) {
    return { started: false, alreadyRunning: true, running: true };
  }

  const logFd = fs.openSync(LOG_FILE, 'a');
  fs.writeSync(
    logFd,
    `\n[${new Date().toISOString()}] Starting Web AI MCP Server via Native Host...\n`
  );

  const child = spawn(process.execPath, [path.join(SERVER_DIR, 'src', 'index.js')], {
    cwd: SERVER_DIR,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);

  for (let i = 0; i < 30; i++) {
    await sleep(200);
    if (await checkHealth(baseUrl)) {
      return { started: true, alreadyRunning: false, running: true, pid: child.pid };
    }
  }

  throw new Error(`MCP Server gagal merespons di ${baseUrl} dalam 6 detik. Cek ${LOG_FILE}.`);
}

async function main() {
  const msg = await readOneMessage();
  const cfg = loadConfig();
  const baseUrl = `http://${cfg.host}:${cfg.port}`;
  const action = msg?.action || 'start';

  if (action === 'status') {
    const running = await checkHealth(baseUrl);
    sendMessage({
      ok: true,
      running,
      serverUrl: baseUrl,
      authToken: cfg.authToken,
      workspaceRoot: cfg.workspaceRoot,
    });
    return;
  }

  if (action === 'start') {
    const res = await startServer(cfg, baseUrl);
    sendMessage({
      ok: true,
      ...res,
      serverUrl: baseUrl,
      authToken: cfg.authToken,
      workspaceRoot: cfg.workspaceRoot,
    });
    return;
  }

  if (action === 'stop') {
    const res = await stopServer(cfg, baseUrl);
    sendMessage({
      ok: true,
      ...res,
      running: !res.stopped,
      serverUrl: baseUrl,
    });
    return;
  }

  if (action === 'restart') {
    await stopServer(cfg, baseUrl);
    await sleep(300);
    const res = await startServer(cfg, baseUrl);
    sendMessage({
      ok: true,
      restarted: true,
      ...res,
      serverUrl: baseUrl,
      authToken: cfg.authToken,
      workspaceRoot: cfg.workspaceRoot,
    });
    return;
  }

  sendMessage({ ok: false, error: `Unknown action: ${action}` });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    sendMessage({ ok: false, error: err?.message || String(err) });
    process.exit(0);
  });
