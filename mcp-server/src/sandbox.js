import fs from 'node:fs';
import path from 'node:path';

/**
 * Memastikan path target benar-benar berada di dalam workspaceRoot.
 * Mencegah path traversal (../), perpindahan drive Windows, dan symlink escape.
 */
export function resolveSafePath(inputPath = '.', config, { allowNonExistent = false } = {}) {
  if (typeof inputPath !== 'string') {
    throw new Error('Path harus berupa string.');
  }
  if (inputPath.includes('\0')) {
    throw new Error('Path mengandung karakter null yang tidak valid.');
  }

  const cleaned = inputPath.trim() || '.';
  const rootReal = fs.realpathSync(path.resolve(config.workspaceRoot));

  // Jika user mengirim path absolut, tetap divalidasi harus di dalam rootReal.
  // Jika relatif (mis. "src/index.js" atau "."), gabungkan dengan rootReal.
  const candidate = path.isAbsolute(cleaned)
    ? path.resolve(cleaned)
    : path.resolve(rootReal, cleaned);

  // Cek containment secara leksikal terlebih dahulu
  assertInsideRoot(rootReal, candidate);

  // Cek symlink escape dengan realpath pada target atau parent terdekat yang sudah ada
  if (fs.existsSync(candidate)) {
    const targetReal = fs.realpathSync(candidate);
    assertInsideRoot(rootReal, targetReal);
  } else {
    if (!allowNonExistent) {
      throw new Error(`Path tidak ditemukan: ${toPosixRelative(rootReal, candidate)}`);
    }
    // Telusuri ke atas sampai menemukan parent folder yang sudah ada
    let ancestor = path.dirname(candidate);
    while (!fs.existsSync(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    if (fs.existsSync(ancestor)) {
      const ancestorReal = fs.realpathSync(ancestor);
      assertInsideRoot(rootReal, ancestorReal);
    }
  }

  // Cek file sensitif yang diblokir (mis. .env, private key)
  const baseName = path.basename(candidate).toLowerCase();
  const blocked = (config.blockedFileNames || []).map((n) => n.toLowerCase());
  if (blocked.includes(baseName)) {
    throw new Error(
      `Akses ke "${path.basename(candidate)}" diblokir oleh kebijakan keamanan (blockedFileNames di config.json).`
    );
  }

  return {
    rootReal,
    absolutePath: candidate,
    relativePath: toPosixRelative(rootReal, candidate),
  };
}

function assertInsideRoot(rootReal, targetPath) {
  const isWin = process.platform === 'win32';
  const normRoot = isWin ? rootReal.toLowerCase() : rootReal;
  const normTarget = isWin ? targetPath.toLowerCase() : targetPath;
  const rel = path.relative(normRoot, normTarget);

  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `Akses ditolak: path di luar folder workspace yang diizinkan (${rootReal}).`
    );
  }
}

export function toPosixRelative(rootReal, absolutePath) {
  const rel = path.relative(rootReal, absolutePath);
  if (!rel) return '.';
  return rel.split(path.sep).join('/');
}

export function isIgnoredDir(dirName, config) {
  const list = config.ignoredDirs || [];
  return list.includes(dirName);
}

export function assertWritable(config) {
  if (config.readOnly) {
    throw new Error('Server sedang dalam mode Read-Only. Nonaktifkan mode Read-Only di Extension atau config.json untuk mengedit file.');
  }
}

export function isProbablyBinary(buffer) {
  const len = Math.min(buffer.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}
