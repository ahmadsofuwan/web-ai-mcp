const NATIVE_HOST_NAME = 'com.webaimcp.host';

const DEFAULT_SETTINGS = {
  serverUrl: 'http://127.0.0.1:3847',
  authToken: '',
  autoStartServer: true,
  autoRunReadOnly: true,
  autoRunWrite: true,
  autoSendResult: true,
  maxAutoSteps: 15,
};

let rpcCounter = 1;
let cachedTools = [];

const READ_ONLY_FALLBACK = new Set([
  'get_workspace_info',
  'list_directory',
  'read_file',
  'search_files',
  'find_files',
  'get_session_memory',
  'list_sessions',
]);

const MEMORY_WRITE_TOOLS = new Set([
  'update_session_memory',
]);

const DESTRUCTIVE_TOOLS = new Set([
  'delete_file',
]);

// Buka Side Panel otomatis saat icon extension diklik & migrasi default auto-loop v1.1
chrome.runtime.onInstalled.addListener(async () => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
  const stored = await chrome.storage.local.get(['migratedV11']);
  if (!stored.migratedV11) {
    await chrome.storage.local.set({
      autoStartServer: true,
      autoRunReadOnly: true,
      autoRunWrite: true,
      autoSendResult: true,
      maxAutoSteps: 15,
      migratedV11: true,
    });
  }
  // Coba auto-start & sinkronkan token otomatis dari Native Host saat terpasang/reload
  ensureServerViaNativeHost(false).catch(() => {});
  // Otomatis pasang content.js ke tab AI web yang sudah terbuka agar tidak perlu refresh manual
  injectIntoOpenAiTabs().catch(() => {});
});

chrome.runtime.onStartup.addListener(async () => {
  const s = await getSettings();
  if (s.autoStartServer) {
    ensureServerViaNativeHost(false).catch(() => {});
  }
});

if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

async function getSettings() {
  const data = await chrome.storage.local.get([
    'serverUrl',
    'authToken',
    'autoStartServer',
    'autoRunReadOnly',
    'autoRunWrite',
    'autoSendResult',
    'maxAutoSteps',
  ]);
  return {
    ...DEFAULT_SETTINGS,
    ...data,
    serverUrl: (data.serverUrl || DEFAULT_SETTINGS.serverUrl).replace(/\/+$/, ''),
  };
}

function callNativeHost(action) {
  return new Promise((resolve, reject) => {
    if (!chrome.runtime?.sendNativeMessage) {
      reject(new Error('Native Messaging API tidak tersedia di browser ini.'));
      return;
    }
    chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { action }, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(`Native Host gagal (${err.message}). Jalankan install-native-host.bat sekali.`));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || 'Native Host mengembalikan error.'));
        return;
      }
      resolve(response);
    });
  });
}

async function checkServerHealth(serverUrl) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 1200);
    const res = await fetch(`${serverUrl}/health`, { signal: controller.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureServerViaNativeHost(forceStart = true) {
  const settings = await getSettings();
  const isUp = await checkServerHealth(settings.serverUrl);

  if (isUp && settings.authToken) {
    return { alreadyRunning: true, settings };
  }

  if (!isUp && !forceStart && !settings.autoStartServer) {
    return { alreadyRunning: false, settings };
  }

  const action = isUp ? 'status' : 'start';
  const nativeRes = await callNativeHost(action);
  const updated = await saveSettings({
    serverUrl: nativeRes.serverUrl || settings.serverUrl,
    authToken: nativeRes.authToken || settings.authToken,
  });

  return {
    nativeHostUsed: true,
    started: Boolean(nativeRes.started),
    alreadyRunning: Boolean(nativeRes.alreadyRunning || isUp),
    settings: updated,
  };
}

async function saveSettings(partial) {
  const current = await getSettings();
  const next = {
    ...current,
    ...partial,
  };
  if (next.serverUrl) {
    next.serverUrl = next.serverUrl.trim().replace(/\/+$/, '');
  }
  await chrome.storage.local.set(next);
  return next;
}

async function appendLog(entry) {
  const { executionLog = [] } = await chrome.storage.local.get('executionLog');
  const next = [
    {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      ...entry,
    },
    ...executionLog,
  ].slice(0, 60);
  await chrome.storage.local.set({ executionLog: next });
  chrome.runtime.sendMessage({ type: 'LOG_UPDATED', log: next }).catch(() => {});
  return next;
}

async function mcpRpc(method, params = {}, allowRetry = true) {
  let { serverUrl, authToken } = await getSettings();

  if (!authToken && allowRetry) {
    try {
      const boot = await ensureServerViaNativeHost(true);
      serverUrl = boot.settings.serverUrl;
      authToken = boot.settings.authToken;
    } catch {
      // lanjut ke error di bawah jika gagal
    }
  }

  if (!authToken) {
    throw new Error('Auth Token belum diisi. Klik Start Server di tab Pengaturan.');
  }

  let res;
  try {
    res = await fetch(`${serverUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'X-MCP-Token': authToken,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: rpcCounter++,
        method,
        params,
      }),
    });
  } catch (netErr) {
    if (allowRetry) {
      await ensureServerViaNativeHost(true);
      return mcpRpc(method, params, false);
    }
    throw netErr;
  }

  if (res.status === 401 && allowRetry) {
    try {
      const st = await callNativeHost('status');
      if (st.authToken) {
        await saveSettings({ serverUrl: st.serverUrl, authToken: st.authToken });
        return mcpRpc(method, params, false);
      }
    } catch {
      // fall through
    }
  }

  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      const parsed = JSON.parse(text);
      msg = parsed.error?.message || parsed.error || text;
    } catch {
      // keep raw text
    }
    throw new Error(`HTTP ${res.status}: ${msg}`);
  }

  let json;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream')) {
    const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
    if (!dataLine) throw new Error('Respons SSE MCP tidak valid.');
    json = JSON.parse(dataLine.slice(6));
  } else {
    json = JSON.parse(text);
  }

  if (json.error) {
    throw new Error(json.error.message || 'MCP RPC Error');
  }
  return json.result;
}

async function apiFetch(path, options = {}) {
  const { serverUrl, authToken } = await getSettings();
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (authToken) {
    headers['X-MCP-Token'] = authToken;
  }

  const res = await fetch(`${serverUrl}${path}`, {
    ...options,
    headers,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

async function connectAndSync({ allowAutoStart = true } = {}) {
  const settings = await getSettings();
  let autoStarted = false;

  if (allowAutoStart && (settings.autoStartServer || !settings.authToken)) {
    try {
      const boot = await ensureServerViaNativeHost(settings.autoStartServer);
      autoStarted = Boolean(boot.started);
    } catch {
      // Tetap lanjut mencoba koneksi HTTP langsung (jika user menjalankan server manual)
    }
  }

  let initResult;
  try {
    initResult = await mcpRpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'web-ai-mcp-extension', version: '1.3.0' },
    });
  } catch (err) {
    // Jika 401 Unauthorized, coba ambil token terbaru dari Native Host lalu ulangi sekali
    if (String(err.message).includes('401')) {
      try {
        const st = await callNativeHost('status');
        if (st.authToken) {
          await saveSettings({ serverUrl: st.serverUrl, authToken: st.authToken });
          initResult = await mcpRpc('initialize', {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'web-ai-mcp-extension', version: '1.3.0' },
          });
        } else {
          throw err;
        }
      } catch {
        throw err;
      }
    } else {
      throw err;
    }
  }

  const toolsResult = await mcpRpc('tools/list', {});
  cachedTools = toolsResult?.tools || [];
  const workspace = await apiFetch('/api/workspace?dir=.&tree=1');
  const memory = await apiFetch('/api/memory').catch(() => null);
  const freshSettings = await getSettings();

  return {
    connected: true,
    autoStarted,
    serverInfo: initResult?.serverInfo || { name: 'web-ai-mcp-server', version: '1.0.0' },
    tools: cachedTools,
    workspace,
    memory,
    settings: freshSettings,
  };
}

function isToolReadOnly(toolName) {
  const found = cachedTools.find((t) => t.name === toolName);
  if (found && typeof found.annotations?.readOnlyHint === 'boolean') {
    return found.annotations.readOnlyHint;
  }
  return READ_ONLY_FALLBACK.has(toolName);
}

/**
 * Memastikan content script terpasang di tab aktif (sangat penting jika tab sudah terbuka
 * sebelum extension di-load atau di-reload, sehingga user TIDAK perlu refresh / copy-paste).
 */
async function ensureContentScriptOnTab(tabId) {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: 'CONTENT_PING' });
    if (ping?.ok) return true;
  } catch {
    // Belum terinjeksi di tab ini -> suntikkan secara dinamis
  }

  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ['content.css'],
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js'],
  });
  // Beri sedikit waktu agar listener content.js aktif
  await new Promise((r) => setTimeout(r, 120));
  return true;
}

const AI_TAB_HOSTS = [
  'chatgpt.com',
  'chat.openai.com',
  'claude.ai',
  'gemini.google.com',
  'aistudio.google.com',
  'chat.deepseek.com',
  'chat.qwen.ai',
  'chat.qwenlm.ai',
  'grok.com',
  'perplexity.ai',
  'poe.com',
  'chat.mistral.ai',
  'copilot.microsoft.com',
];

async function injectIntoOpenAiTabs() {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (!t.id || !t.url) continue;
    try {
      const u = new URL(t.url);
      if (AI_TAB_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) {
        await ensureContentScriptOnTab(t.id);
      }
    } catch {
      // ignore non-injectable tabs
    }
  }
}

async function sendToActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) {
    throw new Error('Tidak ada tab AI web aktif yang ditemukan.');
  }
  if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:'))) {
    throw new Error('Buka halaman AI web terlebih dahulu (ChatGPT, Claude, Gemini, DeepSeek, dll.).');
  }

  await ensureContentScriptOnTab(tab.id);
  return chrome.tabs.sendMessage(tab.id, message);
}

async function broadcastSettings(settings) {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (t.id) {
      chrome.tabs.sendMessage(t.id, { type: 'SETTINGS_UPDATED', settings }).catch(() => {});
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'GET_SETTINGS': {
          const settings = await getSettings();
          const { executionLog = [] } = await chrome.storage.local.get('executionLog');
          sendResponse({ ok: true, settings, tools: cachedTools, executionLog });
          break;
        }

        case 'SAVE_SETTINGS': {
          const settings = await saveSettings(msg.settings || {});
          await broadcastSettings(settings);
          sendResponse({ ok: true, settings });
          break;
        }

        case 'OPEN_SIDEPANEL': {
          const windowId = sender.tab?.windowId;
          if (chrome.sidePanel?.open && windowId) {
            await chrome.sidePanel.open({ windowId });
            sendResponse({ ok: true });
          } else {
            sendResponse({ ok: false, error: 'Side Panel API tidak tersedia.' });
          }
          break;
        }

        case 'MCP_CONNECT': {
          const info = await connectAndSync({ allowAutoStart: msg.allowAutoStart !== false });
          injectIntoOpenAiTabs().catch(() => {});
          sendResponse({ ok: true, ...info });
          break;
        }

        case 'SCAN_AND_RUN_LATEST': {
          const res = await sendToActiveTab({ type: 'CONTENT_SCAN_AND_RUN' });
          sendResponse(res || { ok: true, triggered: 0 });
          break;
        }

        case 'NATIVE_START': {
          const res = await callNativeHost('start');
          await saveSettings({
            serverUrl: res.serverUrl,
            authToken: res.authToken,
          });
          const info = await connectAndSync({ allowAutoStart: false });
          sendResponse({ ok: true, native: res, ...info });
          break;
        }

        case 'NATIVE_RESTART': {
          const res = await callNativeHost('restart');
          await saveSettings({
            serverUrl: res.serverUrl,
            authToken: res.authToken,
          });
          const info = await connectAndSync({ allowAutoStart: false });
          sendResponse({ ok: true, native: res, ...info });
          break;
        }

        case 'NATIVE_STOP': {
          const res = await callNativeHost('stop');
          sendResponse({ ok: true, native: res });
          break;
        }

        case 'MCP_HEALTH': {
          const { serverUrl } = await getSettings();
          const res = await fetch(`${serverUrl}/health`);
          const data = await res.json();
          sendResponse({ ok: res.ok, data });
          break;
        }

        case 'MCP_CALL_TOOL': {
          const toolName = msg.tool;
          const args = msg.arguments || {};
          const readOnly = isToolReadOnly(toolName);
          const isMemoryWrite = MEMORY_WRITE_TOOLS.has(toolName);
          const isDestructive = DESTRUCTIVE_TOOLS.has(toolName);
          const settings = await getSettings();

          // delete_file SELALU wajib klik manual demi keamanan
          if (msg.isAutoRun && isDestructive) {
            throw new Error(`Auto-run ditolak: "${toolName}" bersifat hapus permanen dan wajib persetujuan manual.`);
          }
          if (msg.isAutoRun && !readOnly && !isMemoryWrite && !settings.autoRunWrite) {
            throw new Error(`Auto-run untuk tool write "${toolName}" sedang dinonaktifkan.`);
          }

          const result = await mcpRpc('tools/call', {
            name: toolName,
            arguments: args,
          });

          const textOutput = (result?.content || [])
            .map((c) => (c.type === 'text' ? c.text : JSON.stringify(c)))
            .join('\n');

          await appendLog({
            tool: toolName,
            arguments: args,
            readOnly,
            isError: Boolean(result?.isError),
            outputPreview: textOutput.slice(0, 600),
          });

          chrome.runtime.sendMessage({ type: 'MEMORY_MAYBE_UPDATED' }).catch(() => {});

          sendResponse({
            ok: true,
            tool: toolName,
            readOnly,
            isError: Boolean(result?.isError),
            output: textOutput,
          });
          break;
        }

        case 'MEMORY_GET': {
          const data = await apiFetch('/api/memory');
          sendResponse({ ok: true, data });
          break;
        }

        case 'MEMORY_ACTION': {
          const data = await apiFetch('/api/memory', {
            method: 'POST',
            body: JSON.stringify(msg.payload || {}),
          });
          sendResponse({ ok: true, data });
          break;
        }

        case 'WORKSPACE_GET': {
          const dir = encodeURIComponent(msg.dir || '.');
          const treeFlag = msg.tree ? '&tree=1' : '';
          const data = await apiFetch(`/api/workspace?dir=${dir}${treeFlag}`);
          sendResponse({ ok: true, data });
          break;
        }

        case 'WORKSPACE_SET': {
          const data = await apiFetch('/api/workspace', {
            method: 'POST',
            body: JSON.stringify({
              workspaceRoot: msg.workspaceRoot,
              readOnly: msg.readOnly,
            }),
          });
          sendResponse({ ok: true, data });
          break;
        }

        case 'WORKSPACE_PICK': {
          const data = await apiFetch('/api/pick-folder', {
            method: 'POST',
            body: JSON.stringify({}),
          });
          sendResponse({ ok: true, data });
          break;
        }

        case 'FILE_PREVIEW': {
          const p = encodeURIComponent(msg.path || '');
          const data = await apiFetch(`/api/file-preview?path=${p}`);
          sendResponse({ ok: true, data });
          break;
        }

        case 'INSERT_INTO_CHAT': {
          const res = await sendToActiveTab({
            type: 'CONTENT_INSERT_TEXT',
            text: msg.text,
            autoSend: Boolean(msg.autoSend),
            resetStepCounter: Boolean(msg.resetStepCounter),
          });
          sendResponse(res || { ok: true });
          break;
        }

        case 'RESET_AUTO_STEPS': {
          const res = await sendToActiveTab({ type: 'CONTENT_RESET_STEPS' }).catch(() => ({ ok: true }));
          sendResponse(res);
          break;
        }

        case 'CLEAR_LOG': {
          await chrome.storage.local.set({ executionLog: [] });
          sendResponse({ ok: true });
          break;
        }

        case 'TOOL_CALL_DETECTED': {
          chrome.runtime.sendMessage({
            type: 'SIDEPANEL_TOOL_DETECTED',
            call: msg.call,
            tabId: sender.tab?.id,
          }).catch(() => {});
          sendResponse({ ok: true });
          break;
        }

        default:
          sendResponse({ ok: false, error: `Unknown message type: ${msg.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();

  return true;
});
