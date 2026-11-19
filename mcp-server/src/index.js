import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig, getConfig, updateWorkspaceConfig, CONFIG_PATH } from './config.js';
import { resolveSafePath, isIgnoredDir, isProbablyBinary, toPosixRelative } from './sandbox.js';
import { registerWorkspaceTools, buildDirectoryTree } from './tools.js';
import {
  listWorkspaceSessions,
  createNewSession,
  switchActiveSession,
  deleteSession,
  resetActiveSession,
  updateSessionMemory,
  formatSessionHandoff,
  hasMeaningfulMemory,
} from './memory.js';

const config = loadConfig();

function isAllowedOrigin(origin) {
  if (!origin) return true; // non-browser clients (curl, MCP Inspector, desktop clients)
  return (
    origin.startsWith('chrome-extension://') ||
    origin.startsWith('moz-extension://') ||
    origin.startsWith('http://localhost') ||
    origin.startsWith('http://127.0.0.1')
  );
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Accept, Authorization, X-MCP-Token, Mcp-Session-Id, MCP-Protocol-Version'
  );
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function checkAuth(req) {
  const cfg = getConfig();
  const headerToken = req.headers['x-mcp-token'];
  const authHeader = req.headers.authorization || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const supplied = typeof headerToken === 'string' ? headerToken.trim() : bearerToken;
  return Boolean(supplied && supplied === cfg.authToken);
}

function readJsonBody(req, maxBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Body terlalu besar.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('JSON body tidak valid.'));
      }
    });
    req.on('error', reject);
  });
}

function createMcpServerInstance() {
  const server = new McpServer(
    {
      name: 'web-ai-mcp-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );
  registerWorkspaceTools(server);
  return server;
}

function listImmediateEntries(dirRel, cfg) {
  const { rootReal, absolutePath, relativePath } = resolveSafePath(dirRel || '.', cfg);
  const stat = fs.statSync(absolutePath);
  if (!stat.isDirectory()) {
    throw new Error(`"${relativePath}" bukan folder.`);
  }
  const raw = fs.readdirSync(absolutePath, { withFileTypes: true });
  const blocked = (cfg.blockedFileNames || []).map((n) => n.toLowerCase());

  const items = [];
  for (const entry of raw) {
    if (entry.isDirectory() && isIgnoredDir(entry.name, cfg)) continue;
    if (blocked.includes(entry.name.toLowerCase())) continue;

    const full = path.join(absolutePath, entry.name);
    let size = 0;
    try {
      if (!entry.isDirectory()) size = fs.statSync(full).size;
    } catch {
      // ignore
    }
    items.push({
      name: entry.name,
      path: toPosixRelative(rootReal, full),
      type: entry.isDirectory() ? 'dir' : 'file',
      size,
    });
  }

  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { currentDir: relativePath, items };
}

function openWindowsFolderPicker(initialDir) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('Dialog folder native hanya tersedia di Windows.'));
      return;
    }
    const safeInitial = (initialDir || '').replace(/'/g, "''");
    const psScript = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$dlg.Description = "Pilih Folder Workspace untuk Web AI MCP"',
      '$dlg.UseDescriptionForTitle = $true',
      safeInitial ? `$dlg.SelectedPath = '${safeInitial}'` : '',
      '$top = New-Object System.Windows.Forms.Form',
      '$top.TopMost = $true',
      '$res = $dlg.ShowDialog($top)',
      '$top.Dispose()',
      'if ($res -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.SelectedPath }',
    ]
      .filter(Boolean)
      .join('; ');

    execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-Command', psScript],
      { timeout: 120000 },
      (err, stdout) => {
        if (err) {
          reject(new Error(`Gagal membuka dialog folder: ${err.message}`));
          return;
        }
        const selected = stdout.trim();
        resolve(selected || null);
      }
    );
  });
}

const server = http.createServer(async (req, res) => {
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin)) {
    sendJson(res, 403, { error: `Origin tidak diizinkan: ${origin}` });
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

  // 1. Public health check (tanpa membocorkan path atau token)
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      server: 'web-ai-mcp-server',
      version: '1.0.0',
      protocol: 'MCP Streamable HTTP',
    });
    return;
  }

  // Semua endpoint lainnya wajib autentikasi token
  if (!checkAuth(req)) {
    sendJson(res, 401, {
      error: 'Unauthorized: X-MCP-Token tidak valid atau tidak dikirim.',
    });
    return;
  }

  // 2. Endpoint Standar MCP Streamable HTTP: POST /mcp
  if (url.pathname === '/mcp') {
    if (req.method !== 'POST') {
      sendJson(res, 405, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed. Gunakan POST /mcp (stateless).' },
        id: null,
      });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, {
        jsonrpc: '2.0',
        error: { code: -32700, message: err.message },
        id: null,
      });
      return;
    }

    const mcpServer = createMcpServerInstance();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on('close', () => {
      transport.close().catch(() => {});
      mcpServer.close().catch(() => {});
    });

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error('[MCP Error]', err);
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: '2.0',
          error: { code: -32603, message: err.message || 'Internal MCP server error' },
          id: body?.id ?? null,
        });
      }
    }
    return;
  }

  // 3. Workspace API untuk Browser Extension Side Panel
  if (url.pathname === '/api/workspace' && req.method === 'GET') {
    try {
      const cfg = getConfig();
      const dir = url.searchParams.get('dir') || '.';
      const listing = listImmediateEntries(dir, cfg);
      const includeTree = url.searchParams.get('tree') === '1';
      let tree = undefined;
      if (includeTree) {
        const { rootReal, absolutePath } = resolveSafePath('.', cfg);
        tree = buildDirectoryTree(absolutePath, rootReal, cfg, { maxDepth: 2, maxEntries: 120 });
      }
      sendJson(res, 200, {
        workspaceRoot: cfg.workspaceRoot,
        recentWorkspaces: cfg.recentWorkspaces,
        readOnly: cfg.readOnly,
        currentDir: listing.currentDir,
        items: listing.items,
        tree,
      });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  if (url.pathname === '/api/workspace' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const updated = updateWorkspaceConfig({
        workspaceRoot: body.workspaceRoot,
        readOnly: typeof body.readOnly === 'boolean' ? body.readOnly : undefined,
      });
      sendJson(res, 200, {
        ok: true,
        workspaceRoot: updated.workspaceRoot,
        recentWorkspaces: updated.recentWorkspaces,
        readOnly: updated.readOnly,
      });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  if (url.pathname === '/api/pick-folder' && req.method === 'POST') {
    try {
      const cfg = getConfig();
      const selected = await openWindowsFolderPicker(cfg.workspaceRoot);
      if (!selected) {
        sendJson(res, 200, { cancelled: true, workspaceRoot: cfg.workspaceRoot });
        return;
      }
      const updated = updateWorkspaceConfig({ workspaceRoot: selected });
      sendJson(res, 200, {
        cancelled: false,
        workspaceRoot: updated.workspaceRoot,
        recentWorkspaces: updated.recentWorkspaces,
        readOnly: updated.readOnly,
      });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (url.pathname === '/api/file-preview' && req.method === 'GET') {
    try {
      const cfg = getConfig();
      const target = url.searchParams.get('path');
      if (!target) {
        sendJson(res, 400, { error: 'Parameter path wajib diisi.' });
        return;
      }
      const { absolutePath, relativePath } = resolveSafePath(target, cfg);
      const stat = fs.statSync(absolutePath);
      if (!stat.isFile()) {
        sendJson(res, 400, { error: `"${relativePath}" bukan file.` });
        return;
      }
      if (stat.size > cfg.maxFileSizeBytes) {
        sendJson(res, 400, { error: `File terlalu besar (${stat.size} bytes).` });
        return;
      }
      const buf = fs.readFileSync(absolutePath);
      if (isProbablyBinary(buf)) {
        sendJson(res, 400, { error: 'File biner tidak dapat ditampilkan.' });
        return;
      }
      sendJson(res, 200, {
        path: relativePath,
        size: stat.size,
        content: buf.toString('utf8'),
      });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  if (url.pathname === '/api/memory' && req.method === 'GET') {
    try {
      const cfg = getConfig();
      const data = listWorkspaceSessions(cfg.workspaceRoot);
      sendJson(res, 200, {
        ...data,
        hasMemory: hasMeaningfulMemory(data.activeSession),
        handoffMarkdown: formatSessionHandoff(data.activeSession),
      });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  if (url.pathname === '/api/memory' && req.method === 'POST') {
    try {
      const cfg = getConfig();
      const body = await readJsonBody(req);
      const action = body.action || 'update';

      if (action === 'create') {
        createNewSession(cfg.workspaceRoot, { title: body.title, goal: body.goal });
      } else if (action === 'switch') {
        switchActiveSession(cfg.workspaceRoot, body.sessionId);
      } else if (action === 'delete') {
        deleteSession(cfg.workspaceRoot, body.sessionId);
      } else if (action === 'reset') {
        resetActiveSession(cfg.workspaceRoot);
      } else {
        updateSessionMemory(cfg.workspaceRoot, body.patch || body);
      }

      const data = listWorkspaceSessions(cfg.workspaceRoot);
      sendJson(res, 200, {
        ok: true,
        ...data,
        hasMemory: hasMeaningfulMemory(data.activeSession),
        handoffMarkdown: formatSessionHandoff(data.activeSession),
      });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  if (url.pathname === '/api/shutdown' && req.method === 'POST') {
    sendJson(res, 200, { ok: true, stopping: true, pid: process.pid });
    setTimeout(() => {
      cleanupPidFile();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 500);
    }, 100);
    return;
  }

  sendJson(res, 404, { error: 'Endpoint tidak ditemukan.' });
});

const PID_FILE = path.resolve(path.dirname(CONFIG_PATH), 'server.pid');

function writePidFile() {
  try {
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
  } catch {
    // ignore
  }
}

function cleanupPidFile() {
  try {
    if (fs.existsSync(PID_FILE) && fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) {
      fs.unlinkSync(PID_FILE);
    }
  } catch {
    // ignore
  }
}

process.on('SIGINT', () => {
  cleanupPidFile();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanupPidFile();
  process.exit(0);
});
process.on('exit', cleanupPidFile);

server.listen(config.port, config.host, () => {
  writePidFile();
  console.log('===============================================================');
  console.log('  Web AI MCP Server (Sandboxed Local Filesystem)');
  console.log('===============================================================');
  console.log(`  MCP Endpoint   : http://${config.host}:${config.port}/mcp`);
  console.log(`  Health Check   : http://${config.host}:${config.port}/health`);
  console.log(`  Workspace Root : ${config.workspaceRoot}`);
  console.log(`  Mode Akses     : ${config.readOnly ? 'READ-ONLY' : 'READ-WRITE'}`);
  console.log(`  Auth Token     : ${config.authToken}`);
  console.log(`  PID            : ${process.pid}`);
  console.log(`  Config File    : ${CONFIG_PATH}`);
  console.log('---------------------------------------------------------------');
  console.log('  Extension akan otomatis terhubung (Native Host aktif).');
  console.log('===============================================================');
});
