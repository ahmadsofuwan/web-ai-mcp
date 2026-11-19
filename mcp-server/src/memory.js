import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const MEMORY_DIR = path.resolve(__dirname, '..', 'memory');
export const MEMORY_FILE = path.join(MEMORY_DIR, 'sessions.json');

function normWorkspaceKey(workspaceRoot) {
  const resolved = path.resolve(workspaceRoot || '.');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function loadStore() {
  try {
    if (!fs.existsSync(MEMORY_FILE)) {
      return { activeByWorkspace: {}, sessions: {} };
    }
    const raw = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    return {
      activeByWorkspace: raw.activeByWorkspace || {},
      sessions: raw.sessions || {},
    };
  } catch (err) {
    console.error('[memory] Gagal membaca sessions.json:', err.message);
    return { activeByWorkspace: {}, sessions: {} };
  }
}

function saveStore(store) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(store, null, 2) + '\n', 'utf8');
}

function createEmptySession(workspaceRoot, title = 'Session Utama') {
  const now = new Date().toISOString();
  const id = `sess_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
  return {
    id,
    title: title.trim() || 'Session Utama',
    workspaceRoot: path.resolve(workspaceRoot),
    workspaceKey: normWorkspaceKey(workspaceRoot),
    createdAt: now,
    updatedAt: now,
    goal: '',
    summary: '',
    completedTasks: [],
    nextSteps: [],
    notes: [],
    filesTouched: [], // [{ path, action, at, detail }]
    recentActions: [], // [{ tool, target, status, at }]
  };
}

export function getOrCreateActiveSession(workspaceRoot) {
  const store = loadStore();
  const wsKey = normWorkspaceKey(workspaceRoot);
  const activeId = store.activeByWorkspace[wsKey];

  if (activeId && store.sessions[activeId]) {
    return store.sessions[activeId];
  }

  // Cari session existing untuk workspace ini jika ada
  const existing = Object.values(store.sessions)
    .filter((s) => s.workspaceKey === wsKey)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

  if (existing.length > 0) {
    store.activeByWorkspace[wsKey] = existing[0].id;
    saveStore(store);
    return existing[0];
  }

  const created = createEmptySession(workspaceRoot, 'Session Utama');
  store.sessions[created.id] = created;
  store.activeByWorkspace[wsKey] = created.id;
  saveStore(store);
  return created;
}

export function listWorkspaceSessions(workspaceRoot) {
  const store = loadStore();
  const wsKey = normWorkspaceKey(workspaceRoot);
  const active = getOrCreateActiveSession(workspaceRoot);
  const sessions = Object.values(loadStore().sessions)
    .filter((s) => s.workspaceKey === wsKey)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

  return {
    activeSessionId: active.id,
    activeSession: active,
    sessions,
  };
}

export function createNewSession(workspaceRoot, { title = '', goal = '' } = {}) {
  const store = loadStore();
  const wsKey = normWorkspaceKey(workspaceRoot);
  const count = Object.values(store.sessions).filter((s) => s.workspaceKey === wsKey).length;
  const session = createEmptySession(workspaceRoot, title || `Session #${count + 1}`);
  if (goal && typeof goal === 'string') {
    session.goal = goal.trim();
  }
  store.sessions[session.id] = session;
  store.activeByWorkspace[wsKey] = session.id;
  saveStore(store);
  return session;
}

export function switchActiveSession(workspaceRoot, sessionId) {
  const store = loadStore();
  const wsKey = normWorkspaceKey(workspaceRoot);
  const target = store.sessions[sessionId];
  if (!target || target.workspaceKey !== wsKey) {
    throw new Error(`Session "${sessionId}" tidak ditemukan di workspace ini.`);
  }
  store.activeByWorkspace[wsKey] = sessionId;
  saveStore(store);
  return target;
}

export function deleteSession(workspaceRoot, sessionId) {
  const store = loadStore();
  const wsKey = normWorkspaceKey(workspaceRoot);
  const target = store.sessions[sessionId];
  if (!target || target.workspaceKey !== wsKey) {
    throw new Error(`Session "${sessionId}" tidak ditemukan.`);
  }
  delete store.sessions[sessionId];
  if (store.activeByWorkspace[wsKey] === sessionId) {
    delete store.activeByWorkspace[wsKey];
  }
  saveStore(store);
  return getOrCreateActiveSession(workspaceRoot);
}

export function resetActiveSession(workspaceRoot) {
  const active = getOrCreateActiveSession(workspaceRoot);
  const store = loadStore();
  const sess = store.sessions[active.id];
  if (!sess) return active;

  sess.goal = '';
  sess.summary = '';
  sess.completedTasks = [];
  sess.nextSteps = [];
  sess.notes = [];
  sess.filesTouched = [];
  sess.recentActions = [];
  sess.updatedAt = new Date().toISOString();
  saveStore(store);
  return sess;
}

export function updateSessionMemory(workspaceRoot, patch = {}) {
  const active = getOrCreateActiveSession(workspaceRoot);
  const store = loadStore();
  const sess = store.sessions[active.id];
  const now = new Date().toISOString();

  if (typeof patch.title === 'string' && patch.title.trim()) {
    sess.title = patch.title.trim();
  }
  if (typeof patch.goal === 'string') {
    sess.goal = patch.goal.trim();
  }
  if (typeof patch.summary === 'string') {
    sess.summary = patch.summary.trim();
  }

  // Replace full arrays (biasanya dari form edit Side Panel)
  if (Array.isArray(patch.completedTasks)) {
    sess.completedTasks = patch.completedTasks
      .map((item) =>
        typeof item === 'string'
          ? { text: item.trim(), at: now, aiSource: patch.aiSource || '' }
          : { text: String(item.text || '').trim(), at: item.at || now, aiSource: item.aiSource || '' }
      )
      .filter((i) => i.text);
  }

  // Append completed items (biasanya dari AI via tool update_session_memory)
  if (patch.addCompleted) {
    const items = Array.isArray(patch.addCompleted) ? patch.addCompleted : [patch.addCompleted];
    for (const raw of items) {
      const text = String(raw || '').trim();
      if (!text) continue;
      const exists = sess.completedTasks.some((c) => c.text.toLowerCase() === text.toLowerCase());
      if (!exists) {
        sess.completedTasks.push({
          text,
          at: now,
          aiSource: patch.aiSource || '',
        });
      }
    }
    sess.completedTasks = sess.completedTasks.slice(-40);
  }

  if (Array.isArray(patch.nextSteps)) {
    sess.nextSteps = patch.nextSteps.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 30);
  }
  if (Array.isArray(patch.setNextSteps)) {
    sess.nextSteps = patch.setNextSteps.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 30);
  }

  if (Array.isArray(patch.notes)) {
    sess.notes = patch.notes
      .map((n) => (typeof n === 'string' ? { text: n.trim(), at: now } : { text: String(n.text || '').trim(), at: n.at || now }))
      .filter((n) => n.text)
      .slice(-30);
  }
  if (patch.addNote) {
    const notesToAdd = Array.isArray(patch.addNote) ? patch.addNote : [patch.addNote];
    for (const raw of notesToAdd) {
      const text = String(raw || '').trim();
      if (!text) continue;
      const exists = sess.notes.some((n) => n.text.toLowerCase() === text.toLowerCase());
      if (!exists) {
        sess.notes.push({ text, at: now });
      }
    }
    sess.notes = sess.notes.slice(-30);
  }

  sess.updatedAt = now;
  saveStore(store);
  return sess;
}

/**
 * Otomatis mencatat aktivitas tool MCP (terutama write/edit/delete/create)
 * agar progres tetap terekam meskipun AI sebelumnya kena limit sebelum sempat memanggil update_session_memory.
 */
export function recordToolActivity(workspaceRoot, { tool, target = '', action = '', detail = '', isError = false }) {
  try {
    const active = getOrCreateActiveSession(workspaceRoot);
    const store = loadStore();
    const sess = store.sessions[active.id];
    if (!sess) return;

    const now = new Date().toISOString();

    sess.recentActions.unshift({
      tool,
      target: String(target || ''),
      status: isError ? 'ERROR' : 'OK',
      detail: String(detail || '').slice(0, 180),
      at: now,
    });
    sess.recentActions = sess.recentActions.slice(0, 30);

    if (!isError && target && ['created', 'updated', 'edited', 'deleted', 'mkdir'].includes(action)) {
      const idx = sess.filesTouched.findIndex((f) => f.path === target);
      const entry = {
        path: target,
        action,
        detail: String(detail || '').slice(0, 160),
        at: now,
      };
      if (idx !== -1) {
        sess.filesTouched.splice(idx, 1);
      }
      sess.filesTouched.unshift(entry);
      sess.filesTouched = sess.filesTouched.slice(0, 50);
    }

    sess.updatedAt = now;
    saveStore(store);
  } catch (err) {
    console.error('[memory] Gagal mencatat aktivitas:', err.message);
  }
}

export function hasMeaningfulMemory(sess) {
  if (!sess) return false;
  return Boolean(
    sess.goal ||
      sess.summary ||
      (sess.completedTasks && sess.completedTasks.length > 0) ||
      (sess.nextSteps && sess.nextSteps.length > 0) ||
      (sess.notes && sess.notes.length > 0) ||
      (sess.filesTouched && sess.filesTouched.length > 0)
  );
}

export function formatSessionHandoff(sess) {
  if (!sess) return '(Belum ada memori session.)';

  const lines = [];
  lines.push(`**Session Aktif:** ${sess.title} (\`${sess.id}\`)`);
  lines.push(`**Terakhir Diperbarui:** ${sess.updatedAt}`);

  if (sess.goal) {
    lines.push('');
    lines.push(`**Tujuan Utama (Goal):**\n${sess.goal}`);
  }

  if (sess.summary) {
    lines.push('');
    lines.push(`**Ringkasan Progres & Konteks:**\n${sess.summary}`);
  }

  if (sess.completedTasks?.length) {
    lines.push('');
    lines.push('**Yang Sudah Dikerjakan:**');
    for (const item of sess.completedTasks) {
      const src = item.aiSource ? ` _(${item.aiSource})_` : '';
      lines.push(`- [x] ${item.text}${src}`);
    }
  }

  if (sess.filesTouched?.length) {
    lines.push('');
    lines.push('**File yang Sudah Dibuat / Diubah (Auto-Tracked MCP):**');
    for (const f of sess.filesTouched.slice(0, 20)) {
      lines.push(`- \`${f.path}\` (${f.action})${f.detail ? ` — ${f.detail}` : ''}`);
    }
  }

  if (sess.nextSteps?.length) {
    lines.push('');
    lines.push('**Langkah Berikutnya (TODO / Lanjutkan Dari Sini):**');
    for (const step of sess.nextSteps) {
      lines.push(`- [ ] ${step}`);
    }
  }

  if (sess.notes?.length) {
    lines.push('');
    lines.push('**Catatan Teknis / Keputusan Penting:**');
    for (const n of sess.notes) {
      lines.push(`- ${n.text}`);
    }
  }

  if (sess.recentActions?.length && !sess.completedTasks?.length) {
    lines.push('');
    lines.push('**Aktivitas MCP Terakhir:**');
    for (const a of sess.recentActions.slice(0, 8)) {
      lines.push(`- \`${a.tool}\` ${a.target ? `(${a.target})` : ''} [${a.status}]`);
    }
  }

  return lines.join('\n');
}
