const state = {
  connected: false,
  settings: {
    serverUrl: 'http://127.0.0.1:3847',
    authToken: '',
    autoRunReadOnly: true,
    autoRunWrite: true,
    autoSendResult: true,
  },
  tools: [],
  workspace: null,
  memory: null,
  currentDir: '.',
  previewFile: null,
  lastManualOutput: '',
};

const $ = (id) => document.getElementById(id);

function sendBg(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (res) => {
      resolve(res || { ok: false, error: 'Background tidak merespons.' });
    });
  });
}

let toastTimer = null;
function showToast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast ${isError ? 'error' : ''}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------- Tabs ----------------
function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.panel').forEach((p) => {
    p.classList.toggle('active', p.id === `tab-${tabName}`);
  });
  if (tabName === 'explorer' && state.connected) {
    loadExplorerDir(state.currentDir);
  }
  if (tabName === 'memory' && state.connected) {
    loadMemory();
  }
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// ---------------- Agent System Prompt Builder ----------------
function buildAgentSystemPrompt(initialTask = '') {
  const root = state.workspace?.workspaceRoot || '(belum diatur)';
  const readOnly = Boolean(state.workspace?.readOnly);
  const tree = state.workspace?.tree || '';
  const hasMemory = Boolean(state.memory?.hasMemory && state.memory?.handoffMarkdown);

  const toolLines = state.tools.map((t) => {
    const props = t.inputSchema?.properties || {};
    const required = new Set(t.inputSchema?.required || []);
    const params = Object.entries(props)
      .map(([k, v]) => `${k}${required.has(k) ? '*' : ''}: ${v.type || 'any'}`)
      .join(', ');
    const access = t.annotations?.readOnlyHint ? 'READ' : 'WRITE';
    return `- ${t.name}(${params}) [${access}]: ${t.description || ''}`;
  });

  let taskLine;
  if (initialTask.trim()) {
    taskLine = `### Tugas / Instruksi Saya:\n${initialTask.trim()}\n\nLangsung mulai kerjakan tugas di atas dengan memanggil tool MCP yang dibutuhkan (jangan menunggu konfirmasi dulu).`;
  } else if (hasMemory) {
    taskLine =
      'Saya baru saja melanjutkan session ini di AI kamu. Baca **Memori Session Aktif** di atas, pahami apa yang sudah dikerjakan, lalu balas ringkas status terakhir dan tanyakan / langsung usulkan langkah lanjutan (atau langsung lanjutkan TODO teratas jika sudah jelas).';
  } else {
    taskLine = 'Balas singkat "Siap! Workspace MCP otomatis terhubung." dan tunggu instruksi saya berikutnya.';
  }

  // Catatan: Contoh menggunakan placeholder "NAMA_TOOL" agar tidak memicu detektor blok otomatis pada pesan user
  return [
    'Kamu sekarang terhubung OTOMATIS ke Local Workspace saya melalui **Web AI MCP Agent** (Model Context Protocol).',
    `Folder Workspace Aktif: \`${root}\` (Mode: ${readOnly ? 'READ-ONLY' : 'READ-WRITE'}).`,
    'Extension browser saya akan **OTOMATIS** mengeksekusi blok `mcp-tool` yang kamu kirim dan **OTOMATIS** mengirimkan hasilnya kembali ke chat ini — jangan pernah menyuruh saya copy-paste atau menjalankan perintah manual jika bisa memakai tool MCP.',
    '',
    '### Daftar MCP Tools yang Tersedia:',
    ...(toolLines.length ? toolLines : ['- (hubungkan server untuk memuat daftar tool)']),
    '',
    '### Aturan Wajib Pemanggilan Tool MCP & Memori Session:',
    '1. Untuk memanggil tool, tulis blok kode fenced `mcp-tool` langsung di balasan chat biasa (JANGAN pakai Canvas/Artifact) berisi JSON valid:',
    '```mcp-tool',
    '{',
    '  "tool": "NAMA_TOOL",',
    '  "arguments": { "path": "contoh/file.js" }',
    '}',
    '```',
    '2. Kamu bisa memanggil 1 tool atau array JSON `[ { "tool": ..., "arguments": ... } ]` sekaligus.',
    '3. Setelah mengirim blok `mcp-tool`, **BERHENTI** dan tunggu balasan otomatis `[MCP_TOOL_RESULT]` sebelum melanjutkan.',
    '4. Selalu baca file (`read_file`) sebelum mengubahnya (`edit_file` / `write_file`). Gunakan `edit_file` untuk perubahan terarah.',
    '5. **PENTING (Memori Lintas AI):** Setiap kali menyelesaikan tahap penting atau selesai mengubah file, panggil `update_session_memory` (isi `goal`, `summary`, `addCompleted`, `setNextSteps`, `addNote`) agar progres tersimpan di MCP Server jika saya sewaktu-waktu pindah ke AI lain.',
    '',
    ...(hasMemory
      ? ['### Memori Session Aktif (Yang Sudah Dikerjakan Sebelumnya):', state.memory.handoffMarkdown, '']
      : []),
    ...(tree
      ? ['### Ringkasan Struktur Folder Saat Ini:', '```text', tree, '```', '']
      : []),
    taskLine,
  ].join('\n');
}

// ---------------- Renderers ----------------
function updateConnectionUI(connected, serverInfo) {
  state.connected = connected;
  const pill = $('status-pill');
  pill.textContent = connected ? 'Terhubung' : 'Terputus';
  pill.className = `status-pill ${connected ? 'online' : 'offline'}`;
  $('connect-banner').style.display = connected ? 'none' : 'block';
  if (serverInfo?.name) {
    $('server-version').textContent = `${serverInfo.name} v${serverInfo.version || '1.0.0'}`;
  }
}

function renderWorkspace(ws) {
  if (!ws) return;
  state.workspace = ws;
  $('workspace-root-display').textContent = ws.workspaceRoot || '-';
  $('input-workspace-path').value = ws.workspaceRoot || '';
  $('toggle-readonly').checked = Boolean(ws.readOnly);

  const sel = $('select-recent-workspaces');
  sel.innerHTML = '<option value="">-- Folder terakhir digunakan --</option>';
  for (const dir of ws.recentWorkspaces || []) {
    const opt = document.createElement('option');
    opt.value = dir;
    opt.textContent = dir;
    sel.appendChild(opt);
  }
}

function renderTools(tools) {
  state.tools = tools || [];
  $('tool-count-badge').textContent = `${state.tools.length} tools`;

  const sel = $('manual-tool-select');
  sel.innerHTML = '';
  const list = $('tools-list');
  list.innerHTML = '';

  if (state.tools.length === 0) {
    list.innerHTML = '<div class="muted">Belum ada tool dimuat.</div>';
    return;
  }

  for (const t of state.tools) {
    const opt = document.createElement('option');
    opt.value = t.name;
    opt.textContent = `${t.name} (${t.annotations?.readOnlyHint ? 'READ' : 'WRITE'})`;
    sel.appendChild(opt);

    const div = document.createElement('div');
    div.className = 'tool-item';
    const isRead = Boolean(t.annotations?.readOnlyHint);
    div.innerHTML = `
      <div class="tool-item-head">
        <span class="mono" style="font-weight:700">${escapeHtml(t.name)}</span>
        <span class="badge ${isRead ? 'read' : 'write'}">${isRead ? 'READ' : 'WRITE'}</span>
      </div>
      <div class="tool-item-desc">${escapeHtml(t.description || '')}</div>
    `;
    list.appendChild(div);
  }

  setDefaultManualArgs(sel.value);
}

function setDefaultManualArgs(toolName) {
  const defaults = {
    get_workspace_info: { depth: 2 },
    list_directory: { path: '.', depth: 2 },
    read_file: { path: 'README.md', startLine: 1, endLine: 100 },
    search_files: { query: 'TODO', path: '.' },
    find_files: { pattern: '*.js' },
    write_file: { path: 'catatan.txt', content: 'Halo dari MCP!' },
    edit_file: { path: 'catatan.txt', oldText: 'Halo', newText: 'Halo Dunia' },
    create_directory: { path: 'folder-baru' },
    delete_file: { path: 'catatan.txt' },
    get_session_memory: {},
    update_session_memory: {
      goal: 'Contoh tujuan session',
      summary: 'Ringkasan progres saat ini',
      addCompleted: ['Menyelesaikan setup awal'],
      setNextSteps: ['Lanjut implementasi fitur berikutnya'],
    },
    list_sessions: {},
  };
  $('manual-tool-args').value = JSON.stringify(defaults[toolName] || {}, null, 2);
}

function renderLog(log) {
  const list = $('log-list');
  list.innerHTML = '';
  if (!log || log.length === 0) {
    list.innerHTML = '<div class="muted">Belum ada aktivitas.</div>';
    return;
  }

  for (const item of log) {
    const div = document.createElement('div');
    div.className = 'log-item';
    const time = new Date(item.timestamp).toLocaleTimeString('id-ID');
    const badgeClass = item.isError ? 'err' : item.readOnly ? 'read' : 'write';
    const badgeText = item.isError ? 'ERR' : item.readOnly ? 'READ' : 'WRITE';
    div.innerHTML = `
      <div class="log-item-head">
        <span class="mono" style="font-weight:700">${escapeHtml(item.tool)}</span>
        <span>
          <span class="badge ${badgeClass}">${badgeText}</span>
          <span style="color:#64748b;font-size:10.5px;margin-left:4px">${time}</span>
        </span>
      </div>
      <div class="log-item-meta mono">${escapeHtml(JSON.stringify(item.arguments || {}))}</div>
    `;
    list.appendChild(div);
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------- Explorer ----------------
async function loadExplorerDir(dir = '.') {
  const res = await sendBg({ type: 'WORKSPACE_GET', dir, tree: false });
  if (!res.ok) {
    showToast(res.error || 'Gagal memuat folder.', true);
    return;
  }
  const data = res.data;
  state.currentDir = data.currentDir || '.';
  $('explorer-breadcrumb').textContent = state.currentDir === '.' ? '/' : `/${state.currentDir}`;

  const container = $('explorer-list');
  container.innerHTML = '';

  if (!data.items || data.items.length === 0) {
    container.innerHTML = '<div class="muted">(Folder kosong)</div>';
    return;
  }

  for (const item of data.items) {
    const row = document.createElement('div');
    row.className = 'file-item';
    row.innerHTML = `
      <div class="file-item-left">
        <span>${item.type === 'dir' ? '📁' : '📄'}</span>
        <span class="file-name mono">${escapeHtml(item.name)}</span>
      </div>
      <div class="row gap-4">
        <span class="file-size">${item.type === 'file' ? formatBytes(item.size) : ''}</span>
        ${item.type === 'file' ? '<button type="button" class="btn sm" data-insert="1" title="Sisipkan isi file ke chat AI">+</button>' : ''}
      </div>
    `;

    row.addEventListener('click', async (e) => {
      if (e.target.closest('[data-insert]')) {
        e.stopPropagation();
        await insertFileToChat(item.path);
        return;
      }
      if (item.type === 'dir') {
        loadExplorerDir(item.path);
      } else {
        openFilePreview(item.path);
      }
    });

    container.appendChild(row);
  }
}

async function openFilePreview(filePath) {
  const res = await sendBg({ type: 'FILE_PREVIEW', path: filePath });
  if (!res.ok) {
    showToast(res.error || 'Gagal membaca file.', true);
    return;
  }
  state.previewFile = res.data;
  $('preview-filename').textContent = res.data.path;
  $('preview-content').textContent = res.data.content.slice(0, 12000);
  $('file-preview-card').classList.remove('hidden');
}

async function insertFileToChat(filePath) {
  const res = await sendBg({ type: 'FILE_PREVIEW', path: filePath });
  if (!res.ok) {
    showToast(res.error || 'Gagal membaca file.', true);
    return;
  }
  const ext = (filePath.split('.').pop() || '').toLowerCase();
  const payload = [
    `File dari workspace: \`${res.data.path}\``,
    `\`\`\`${ext}`,
    res.data.content,
    '```',
  ].join('\n');

  const ins = await sendBg({ type: 'INSERT_INTO_CHAT', text: payload, autoSend: false });
  if (ins.ok) {
    showToast(`File "${res.data.path}" disisipkan ke chat AI!`);
  } else {
    await navigator.clipboard.writeText(payload);
    showToast('Tab AI tidak aktif — isi file disalin ke clipboard.');
  }
}

// ---------------- Memory Session UI ----------------
function renderMemory(mem) {
  if (!mem) return;
  state.memory = mem;
  const active = mem.activeSession;
  const sessions = mem.sessions || [];

  // Update badge di tab Agent
  const badge = $('agent-memory-badge');
  if (badge && active) {
    const doneCount = active.completedTasks?.length || 0;
    const fileCount = active.filesTouched?.length || 0;
    badge.textContent = mem.hasMemory
      ? `${active.title} (${doneCount} selesai · ${fileCount} file)`
      : `${active.title} (Baru)`;
  }

  // Session dropdown
  const sel = $('select-session');
  if (sel) {
    sel.innerHTML = '';
    for (const s of sessions) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.title} (${s.completedTasks?.length || 0} selesai, ${s.filesTouched?.length || 0} file)`;
      if (s.id === active?.id) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  if (!active) return;

  $('mem-goal').value = active.goal || '';
  $('mem-summary').value = active.summary || '';
  $('mem-completed').value = (active.completedTasks || [])
    .map((c) => (typeof c === 'string' ? c : c.text))
    .join('\n');
  $('mem-next').value = (active.nextSteps || []).join('\n');
  $('mem-notes').value = (active.notes || [])
    .map((n) => (typeof n === 'string' ? n : n.text))
    .join('\n');

  const files = active.filesTouched || [];
  $('mem-files-count').textContent = `${files.length} file`;
  const filesList = $('mem-files-list');
  filesList.innerHTML = '';
  if (files.length === 0) {
    filesList.innerHTML = '<div class="muted">Belum ada file yang diubah di session ini.</div>';
  } else {
    for (const f of files) {
      const div = document.createElement('div');
      div.className = 'tool-item';
      const time = f.at ? new Date(f.at).toLocaleTimeString('id-ID') : '';
      div.innerHTML = `
        <div class="tool-item-head">
          <span class="mono" style="font-weight:700">${escapeHtml(f.path)}</span>
          <span class="badge ${f.action === 'deleted' ? 'err' : 'write'}">${escapeHtml(f.action)}</span>
        </div>
        <div class="tool-item-desc">${escapeHtml(f.detail || '')}${time ? ` · ${time}` : ''}</div>
      `;
      filesList.appendChild(div);
    }
  }
}

async function loadMemory(silent = true) {
  const res = await sendBg({ type: 'MEMORY_GET' });
  if (!res.ok) {
    if (!silent) showToast(res.error || 'Gagal memuat memori session.', true);
    return null;
  }
  renderMemory(res.data);
  return res.data;
}

async function triggerInjectAndSend(initialTask = '') {
  if (!state.connected) {
    showToast('Hubungkan ke MCP Server terlebih dahulu.', true);
    return;
  }
  await connectServer(true);
  const prompt = buildAgentSystemPrompt(initialTask);

  await sendBg({
    type: 'SAVE_SETTINGS',
    settings: {
      autoRunReadOnly: $('toggle-autorun').checked,
      autoRunWrite: $('toggle-autorun-write').checked,
      autoSendResult: $('toggle-autosend').checked,
    },
  });

  const res = await sendBg({
    type: 'INSERT_INTO_CHAT',
    text: prompt,
    autoSend: true,
    resetStepCounter: true,
  });
  if (res.ok) {
    if ($('input-initial-task')) $('input-initial-task').value = '';
    showToast(
      state.memory?.hasMemory
        ? '🔄 Memori session & prompt MCP terkirim otomatis ke AI!'
        : '⚡ Prompt MCP Agent terkirim otomatis ke chat AI!'
    );
  } else {
    showToast(res.error || 'Gagal menyuntikkan ke tab aktif. Pastikan tab AI web sedang dibuka.', true);
  }
}

function applyConnectedResult(res) {
  updateConnectionUI(true, res.serverInfo);
  renderTools(res.tools);
  renderWorkspace(res.workspace);
  if (res.memory) {
    renderMemory(res.memory);
  }
  if (res.settings) {
    state.settings = res.settings;
    $('input-server-url').value = res.settings.serverUrl || 'http://127.0.0.1:3847';
    $('input-auth-token').value = res.settings.authToken || '';
    if ($('toggle-autostart')) $('toggle-autostart').checked = res.settings.autoStartServer !== false;
  }
  state.currentDir = '.';
}

// ---------------- Connect & Init ----------------
async function connectServer(silent = false) {
  const res = await sendBg({ type: 'MCP_CONNECT' });
  if (!res.ok) {
    updateConnectionUI(false);
    if (!silent) showToast(res.error || 'Gagal terhubung ke MCP Server.', true);
    return false;
  }
  applyConnectedResult(res);
  if (!silent) {
    showToast(res.autoStarted ? '🚀 MCP Server otomatis dinyalakan & terhubung!' : 'Terhubung ke Local MCP Server!');
  }
  return true;
}

async function handleNativeServerAction(type, loadingText, successText) {
  showToast(loadingText);
  const res = await sendBg({ type });
  if (!res.ok) {
    showToast(res.error || 'Operasi server gagal.', true);
    return;
  }
  if (type === 'NATIVE_STOP') {
    updateConnectionUI(false);
    showToast(successText);
    return;
  }
  applyConnectedResult(res);
  showToast(successText);
}

async function init() {
  const res = await sendBg({ type: 'GET_SETTINGS' });
  if (res.ok && res.settings) {
    state.settings = res.settings;
    $('input-server-url').value = res.settings.serverUrl || 'http://127.0.0.1:3847';
    $('input-auth-token').value = res.settings.authToken || '';
    if ($('toggle-autostart')) $('toggle-autostart').checked = res.settings.autoStartServer !== false;
    $('toggle-autorun').checked = res.settings.autoRunReadOnly !== false;
    $('toggle-autorun-write').checked = res.settings.autoRunWrite !== false;
    $('toggle-autosend').checked = res.settings.autoSendResult !== false;
    renderLog(res.executionLog || []);
  }
  await connectServer(true);
}

// ---------------- Event Handlers ----------------
$('btn-refresh').addEventListener('click', () => connectServer(false));
$('btn-goto-settings').addEventListener('click', () => switchTab('settings'));

$('btn-banner-start-server').addEventListener('click', () =>
  handleNativeServerAction('NATIVE_START', 'Menyalakan MCP Server di background...', '🚀 MCP Server aktif & terhubung!')
);
$('btn-server-start').addEventListener('click', () =>
  handleNativeServerAction('NATIVE_START', 'Menyalakan MCP Server...', '🚀 MCP Server aktif & terhubung!')
);
$('btn-server-restart').addEventListener('click', () =>
  handleNativeServerAction('NATIVE_RESTART', 'Merestart MCP Server...', '↻ MCP Server berhasil di-restart!')
);
$('btn-server-stop').addEventListener('click', () =>
  handleNativeServerAction('NATIVE_STOP', 'Menghentikan MCP Server...', '⏹ MCP Server dihentikan.')
);

$('toggle-autostart').addEventListener('change', async (e) => {
  await sendBg({
    type: 'SAVE_SETTINGS',
    settings: { autoStartServer: e.target.checked },
  });
  showToast(e.target.checked ? 'Auto-start server AKTIF' : 'Auto-start server NONAKTIF');
});

$('btn-toggle-token').addEventListener('click', () => {
  const input = $('input-auth-token');
  input.type = input.type === 'password' ? 'text' : 'password';
});

$('btn-save-connect').addEventListener('click', async () => {
  const serverUrl = $('input-server-url').value.trim();
  const authToken = $('input-auth-token').value.trim();
  await sendBg({
    type: 'SAVE_SETTINGS',
    settings: { serverUrl, authToken },
  });
  const ok = await connectServer(false);
  if (ok) switchTab('agent');
});

$('toggle-autorun').addEventListener('change', async (e) => {
  await sendBg({
    type: 'SAVE_SETTINGS',
    settings: { autoRunReadOnly: e.target.checked },
  });
  showToast(e.target.checked ? 'Auto-run Read-Only AKTIF' : 'Auto-run Read-Only NONAKTIF');
});

$('toggle-autorun-write').addEventListener('change', async (e) => {
  await sendBg({
    type: 'SAVE_SETTINGS',
    settings: { autoRunWrite: e.target.checked },
  });
  showToast(e.target.checked ? 'Auto-run Write/Edit AKTIF' : 'Auto-run Write/Edit NONAKTIF');
});

$('toggle-autosend').addEventListener('change', async (e) => {
  await sendBg({
    type: 'SAVE_SETTINGS',
    settings: { autoSendResult: e.target.checked },
  });
  showToast(e.target.checked ? 'Auto-send hasil AKTIF' : 'Auto-send hasil NONAKTIF');
});

$('toggle-readonly').addEventListener('change', async (e) => {
  const res = await sendBg({ type: 'WORKSPACE_SET', readOnly: e.target.checked });
  if (res.ok) {
    renderWorkspace({ ...state.workspace, ...res.data });
    showToast(e.target.checked ? 'Workspace diatur ke READ-ONLY' : 'Workspace diatur ke READ-WRITE');
  } else {
    e.target.checked = !e.target.checked;
    showToast(res.error || 'Gagal mengubah mode.', true);
  }
});

$('btn-pick-folder').addEventListener('click', async () => {
  showToast('Membuka dialog pilih folder Windows...');
  const res = await sendBg({ type: 'WORKSPACE_PICK' });
  if (!res.ok) {
    showToast(res.error || 'Gagal membuka dialog folder.', true);
    return;
  }
  if (res.data?.cancelled) {
    showToast('Pemilihan folder dibatalkan.');
    return;
  }
  await connectServer(true);
  showToast(`Workspace diganti ke: ${res.data.workspaceRoot}`);
});

$('btn-toggle-manual-path').addEventListener('click', () => {
  $('manual-path-box').classList.toggle('hidden');
});

$('select-recent-workspaces').addEventListener('change', (e) => {
  if (e.target.value) {
    $('input-workspace-path').value = e.target.value;
  }
});

$('btn-apply-path').addEventListener('click', async () => {
  const p = $('input-workspace-path').value.trim();
  if (!p) return;
  const res = await sendBg({ type: 'WORKSPACE_SET', workspaceRoot: p });
  if (!res.ok) {
    showToast(res.error || 'Gagal mengganti workspace.', true);
    return;
  }
  await connectServer(true);
  $('manual-path-box').classList.add('hidden');
  showToast(`Workspace aktif: ${res.data.workspaceRoot}`);
});

$('btn-inject-prompt').addEventListener('click', async () => {
  const initialTask = ($('input-initial-task')?.value || '').trim();
  await triggerInjectAndSend(initialTask);
});

$('btn-scan-run-latest').addEventListener('click', async () => {
  const res = await sendBg({ type: 'SCAN_AND_RUN_LATEST' });
  if (!res.ok) {
    showToast(res.error || 'Gagal memindai tab AI web aktif.', true);
    return;
  }
  if (res.triggered > 0) {
    showToast('⚡ Blok mcp-tool terakhir ditemukan & langsung dijalankan!');
  } else {
    showToast('Tidak ada blok mcp-tool baru yang belum dijalankan di tab ini.');
  }
});

$('btn-handoff-ai').addEventListener('click', async () => {
  await triggerInjectAndSend('');
});

$('btn-memory-refresh').addEventListener('click', async () => {
  const data = await loadMemory(false);
  if (data) showToast('Memori session diperbarui.');
});

$('select-session').addEventListener('change', async (e) => {
  const sessionId = e.target.value;
  if (!sessionId) return;
  const res = await sendBg({
    type: 'MEMORY_ACTION',
    payload: { action: 'switch', sessionId },
  });
  if (res.ok) {
    renderMemory(res.data);
    showToast(`Pindah ke session "${res.data.activeSession?.title}"`);
  } else {
    showToast(res.error || 'Gagal mengganti session.', true);
  }
});

$('btn-new-session').addEventListener('click', () => {
  $('new-session-box').classList.toggle('hidden');
  $('input-new-session-title').focus();
});

$('btn-create-session-confirm').addEventListener('click', async () => {
  const title = $('input-new-session-title').value.trim();
  const res = await sendBg({
    type: 'MEMORY_ACTION',
    payload: { action: 'create', title },
  });
  if (res.ok) {
    $('input-new-session-title').value = '';
    $('new-session-box').classList.add('hidden');
    renderMemory(res.data);
    showToast(`Session baru "${res.data.activeSession?.title}" dibuat!`);
  } else {
    showToast(res.error || 'Gagal membuat session.', true);
  }
});

$('btn-save-memory').addEventListener('click', async () => {
  const splitLines = (val) =>
    (val || '')
      .split(/\r?\n/)
      .map((s) => s.replace(/^[-*]\s*(\[[ xX]\]\s*)?/, '').trim())
      .filter(Boolean);

  const res = await sendBg({
    type: 'MEMORY_ACTION',
    payload: {
      action: 'update',
      patch: {
        goal: $('mem-goal').value.trim(),
        summary: $('mem-summary').value.trim(),
        completedTasks: splitLines($('mem-completed').value),
        nextSteps: splitLines($('mem-next').value),
        notes: splitLines($('mem-notes').value),
      },
    },
  });
  if (res.ok) {
    renderMemory(res.data);
    showToast('💾 Memori session tersimpan!');
  } else {
    showToast(res.error || 'Gagal menyimpan memori.', true);
  }
});

$('btn-reset-session').addEventListener('click', async () => {
  const res = await sendBg({
    type: 'MEMORY_ACTION',
    payload: { action: 'reset' },
  });
  if (res.ok) {
    renderMemory(res.data);
    showToast('Isi memori session aktif dibersihkan.');
  } else {
    showToast(res.error || 'Gagal mereset session.', true);
  }
});

$('btn-delete-session').addEventListener('click', async () => {
  const sessionId = state.memory?.activeSession?.id;
  if (!sessionId) return;
  const res = await sendBg({
    type: 'MEMORY_ACTION',
    payload: { action: 'delete', sessionId },
  });
  if (res.ok) {
    renderMemory(res.data);
    showToast('Session dihapus.');
  } else {
    showToast(res.error || 'Gagal menghapus session.', true);
  }
});

$('btn-copy-prompt').addEventListener('click', async () => {
  if (state.connected) await connectServer(true);
  const initialTask = ($('input-initial-task')?.value || '').trim();
  const prompt = buildAgentSystemPrompt(initialTask);
  await navigator.clipboard.writeText(prompt);
  showToast('Prompt MCP Agent disalin ke clipboard!');
});

$('manual-tool-select').addEventListener('change', (e) => {
  setDefaultManualArgs(e.target.value);
});

$('btn-run-manual-tool').addEventListener('click', async () => {
  const tool = $('manual-tool-select').value;
  if (!tool) return;
  let args = {};
  try {
    args = JSON.parse($('manual-tool-args').value || '{}');
  } catch {
    showToast('Argumen JSON tidak valid.', true);
    return;
  }

  const out = $('manual-tool-output');
  out.classList.remove('hidden');
  out.textContent = 'Menjalankan...';

  const res = await sendBg({ type: 'MCP_CALL_TOOL', tool, arguments: args });
  if (!res.ok) {
    out.textContent = `Error: ${res.error}`;
    showToast(res.error, true);
    return;
  }
  state.lastManualOutput = `[MCP_TOOL_RESULT tool="${tool}" status="${res.isError ? 'ERROR' : 'OK'}"]\n\`\`\`text\n${res.output}\n\`\`\``;
  out.textContent = res.output || '(kosong)';
  showToast(`Tool "${tool}" selesai.`);
});

$('btn-send-manual-output').addEventListener('click', async () => {
  if (!state.lastManualOutput) {
    showToast('Jalankan tool terlebih dahulu.', true);
    return;
  }
  const res = await sendBg({ type: 'INSERT_INTO_CHAT', text: state.lastManualOutput, autoSend: false });
  if (res.ok) {
    showToast('Hasil dikirim ke kolom chat AI!');
  } else {
    await navigator.clipboard.writeText(state.lastManualOutput);
    showToast('Disalin ke clipboard.');
  }
});

// Explorer buttons
$('btn-dir-refresh').addEventListener('click', () => loadExplorerDir(state.currentDir));
$('btn-dir-up').addEventListener('click', () => {
  if (!state.currentDir || state.currentDir === '.') return;
  const parts = state.currentDir.split('/').filter(Boolean);
  parts.pop();
  loadExplorerDir(parts.length ? parts.join('/') : '.');
});

$('btn-close-preview').addEventListener('click', () => {
  $('file-preview-card').classList.add('hidden');
});

$('btn-insert-preview').addEventListener('click', () => {
  if (state.previewFile?.path) {
    insertFileToChat(state.previewFile.path);
  }
});

$('btn-copy-preview').addEventListener('click', async () => {
  if (!state.previewFile) return;
  await navigator.clipboard.writeText(state.previewFile.content);
  showToast('Isi file disalin ke clipboard.');
});

$('btn-clear-log').addEventListener('click', async () => {
  await sendBg({ type: 'CLEAR_LOG' });
  renderLog([]);
  showToast('Log dibersihkan.');
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'LOG_UPDATED') {
    renderLog(msg.log || []);
  }
  if (msg.type === 'MEMORY_MAYBE_UPDATED' && state.connected) {
    loadMemory(true);
  }
});

init();
