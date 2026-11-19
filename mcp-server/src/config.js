import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const CONFIG_PATH = path.resolve(__dirname, '..', 'config.json');

const DEFAULT_CONFIG = {
  host: '127.0.0.1',
  port: 3847,
  authToken: 'auto',
  readOnly: false,
  workspaceRoot: path.resolve(__dirname, '..', '..'),
  recentWorkspaces: [],
  maxFileSizeBytes: 1024 * 1024,
  ignoredDirs: [
    '.git',
    'node_modules',
    'vendor',
    '.next',
    'dist',
    'build',
    '__pycache__',
    '.venv',
    '.idea',
    '.vscode',
  ],
  blockedFileNames: [
    '.env',
    '.env.local',
    '.env.production',
    'id_rsa',
    'id_ed25519',
  ],
};

let currentConfig = null;

export function loadConfig() {
  let raw = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      console.error('[config] Gagal membaca config.json, menggunakan default:', err.message);
    }
  }

  const merged = {
    ...DEFAULT_CONFIG,
    ...raw,
  };

  let dirty = !fs.existsSync(CONFIG_PATH);

  if (!merged.authToken || merged.authToken === 'auto') {
    merged.authToken = crypto.randomBytes(16).toString('hex');
    dirty = true;
  }

  if (!merged.workspaceRoot || !fs.existsSync(merged.workspaceRoot)) {
    merged.workspaceRoot = DEFAULT_CONFIG.workspaceRoot;
    dirty = true;
  } else {
    merged.workspaceRoot = path.resolve(merged.workspaceRoot);
  }

  if (!Array.isArray(merged.recentWorkspaces)) {
    merged.recentWorkspaces = [];
  }
  if (!merged.recentWorkspaces.includes(merged.workspaceRoot)) {
    merged.recentWorkspaces.unshift(merged.workspaceRoot);
    merged.recentWorkspaces = merged.recentWorkspaces.slice(0, 12);
    dirty = true;
  }

  currentConfig = merged;
  if (dirty) {
    saveConfig(currentConfig);
  }
  return currentConfig;
}

export function getConfig() {
  if (!currentConfig) {
    return loadConfig();
  }
  return currentConfig;
}

export function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

export function updateWorkspaceConfig({ workspaceRoot, readOnly }) {
  const cfg = getConfig();

  if (typeof workspaceRoot === 'string' && workspaceRoot.trim()) {
    const resolved = path.resolve(workspaceRoot.trim());
    if (!fs.existsSync(resolved)) {
      throw new Error(`Folder tidak ditemukan: ${resolved}`);
    }
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`Path bukan folder: ${resolved}`);
    }
    cfg.workspaceRoot = resolved;
    cfg.recentWorkspaces = [
      resolved,
      ...cfg.recentWorkspaces.filter((p) => p.toLowerCase() !== resolved.toLowerCase()),
    ].slice(0, 12);
  }

  if (typeof readOnly === 'boolean') {
    cfg.readOnly = readOnly;
  }

  saveConfig(cfg);
  return cfg;
}
