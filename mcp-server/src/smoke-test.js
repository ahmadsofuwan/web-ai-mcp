import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(__dirname, '..');
const configPath = path.join(serverDir, 'config.json');

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function mcpRequest(baseUrl, token, method, params = {}, id = 1) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'X-MCP-Token': token,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return JSON.parse(text);
}

async function run() {
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d.toString()));
  child.stderr.on('data', (d) => (stderr += d.toString()));

  try {
    // Wait for server to come up
    let ready = false;
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const r = await fetch(`http://${cfg.host}:${cfg.port}/health`);
        if (r.ok) {
          ready = true;
          break;
        }
      } catch {
        // retry
      }
    }
    if (!ready) {
      throw new Error(`Server tidak siap.\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
    }

    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const baseUrl = `http://${cfg.host}:${cfg.port}`;
    const token = cfg.authToken;

    // 1. Unauthorized must fail with 401
    const unauth = await fetch(`${baseUrl}/api/workspace`);
    if (unauth.status !== 401) throw new Error(`Harusnya 401 tanpa token, dapat ${unauth.status}`);
    console.log('[PASS] Auth check (401 tanpa token)');

    // 2. MCP initialize
    const initRes = await mcpRequest(baseUrl, token, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '1.0.0' },
    }, 1);
    if (!initRes.result?.serverInfo?.name) {
      throw new Error(`Initialize gagal: ${JSON.stringify(initRes)}`);
    }
    console.log('[PASS] MCP initialize:', initRes.result.serverInfo.name);

    // 3. MCP tools/list
    const listRes = await mcpRequest(baseUrl, token, 'tools/list', {}, 2);
    const tools = listRes.result?.tools || [];
    if (tools.length < 8) {
      throw new Error(`Jumlah tools kurang: ${tools.length}`);
    }
    console.log(`[PASS] MCP tools/list (${tools.length} tools):`, tools.map((t) => t.name).join(', '));

    // 4. Call get_workspace_info
    const infoRes = await mcpRequest(baseUrl, token, 'tools/call', {
      name: 'get_workspace_info',
      arguments: { depth: 2 },
    }, 3);
    if (infoRes.result?.isError) throw new Error(JSON.stringify(infoRes));
    console.log('[PASS] tools/call get_workspace_info');

    // 5. Sandbox traversal test
    const escapeRes = await mcpRequest(baseUrl, token, 'tools/call', {
      name: 'read_file',
      arguments: { path: '../../Windows/win.ini' },
    }, 4);
    if (!escapeRes.result?.isError) {
      throw new Error(`Sandbox traversal lolos! ${JSON.stringify(escapeRes)}`);
    }
    console.log('[PASS] Sandbox blocked path traversal:', escapeRes.result.content[0].text);

    // 6. Write -> Edit -> Read -> Delete temp file
    const tempFile = '__smoke_test_tmp.txt';
    const wRes = await mcpRequest(baseUrl, token, 'tools/call', {
      name: 'write_file',
      arguments: { path: tempFile, content: 'baris 1\nbaris 2\nbaris 3\n' },
    }, 5);
    if (wRes.result?.isError) throw new Error(JSON.stringify(wRes));

    const eRes = await mcpRequest(baseUrl, token, 'tools/call', {
      name: 'edit_file',
      arguments: { path: tempFile, oldText: 'baris 2', newText: 'baris 2 edited' },
    }, 6);
    if (eRes.result?.isError) throw new Error(JSON.stringify(eRes));

    const rRes = await mcpRequest(baseUrl, token, 'tools/call', {
      name: 'read_file',
      arguments: { path: tempFile },
    }, 7);
    if (!rRes.result?.content?.[0]?.text?.includes('baris 2 edited')) {
      throw new Error(`Edit tidak tersimpan: ${JSON.stringify(rRes)}`);
    }

    const dRes = await mcpRequest(baseUrl, token, 'tools/call', {
      name: 'delete_file',
      arguments: { path: tempFile },
    }, 8);
    if (dRes.result?.isError) throw new Error(JSON.stringify(dRes));
    console.log('[PASS] write_file -> edit_file -> read_file -> delete_file');

    // 7. Session Memory tools & /api/memory
    const memUpdate = await mcpRequest(baseUrl, token, 'tools/call', {
      name: 'update_session_memory',
      arguments: {
        goal: 'Uji memori lintas AI',
        summary: 'Semua tool dasar sudah dites.',
        addCompleted: ['Membuat file smoke test'],
        setNextSteps: ['Lanjut ke fitur berikutnya'],
        aiSource: 'SmokeTest',
      },
    }, 9);
    if (memUpdate.result?.isError) throw new Error(JSON.stringify(memUpdate));

    const memGet = await mcpRequest(baseUrl, token, 'tools/call', {
      name: 'get_session_memory',
      arguments: {},
    }, 10);
    const memText = memGet.result?.content?.[0]?.text || '';
    if (!memText.includes('Uji memori lintas AI') || !memText.includes(tempFile)) {
      throw new Error(`Memori tidak tersimpan lengkap:\n${memText}`);
    }

    // Reset smoke test memory agar sesi awal user tetap bersih
    const resetRes = await fetch(`${baseUrl}/api/memory`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-MCP-Token': token,
      },
      body: JSON.stringify({ action: 'reset' }),
    });
    if (!resetRes.ok) throw new Error(`Reset memory gagal: ${resetRes.status}`);
    console.log('[PASS] Session Memory (auto-track file + update_session_memory + get_session_memory + /api/memory)');

    console.log('\nSEMUA SMOKE TEST MCP BERHASIL!');
  } finally {
    child.kill();
  }
}

run().catch((err) => {
  console.error('\n[FAIL]', err);
  process.exit(1);
});
