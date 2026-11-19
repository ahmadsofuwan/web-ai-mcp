import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getConfig } from './config.js';
import {
  resolveSafePath,
  isIgnoredDir,
  assertWritable,
  isProbablyBinary,
  toPosixRelative,
} from './sandbox.js';
import {
  getOrCreateActiveSession,
  listWorkspaceSessions,
  updateSessionMemory,
  recordToolActivity,
  formatSessionHandoff,
} from './memory.js';

function textResult(text) {
  return {
    content: [{ type: 'text', text: String(text) }],
  };
}

function errorResult(message) {
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${message}` }],
  };
}

export function buildDirectoryTree(dirPath, rootReal, config, { maxDepth = 2, maxEntries = 150 } = {}) {
  const lines = [];
  let count = 0;
  let truncated = false;

  function walk(currentDir, depth, prefix) {
    if (depth > maxDepth || truncated) return;
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const filtered = entries.filter((entry) => {
      if (entry.isDirectory() && isIgnoredDir(entry.name, config)) return false;
      const blocked = (config.blockedFileNames || []).map((n) => n.toLowerCase());
      if (blocked.includes(entry.name.toLowerCase())) return false;
      return true;
    });

    for (let i = 0; i < filtered.length; i++) {
      if (count >= maxEntries) {
        truncated = true;
        return;
      }
      const entry = filtered[i];
      const isLast = i === filtered.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const nextPrefix = prefix + (isLast ? '    ' : '│   ');
      const fullPath = path.join(currentDir, entry.name);

      count++;
      if (entry.isDirectory()) {
        lines.push(`${prefix}${connector}${entry.name}/`);
        if (depth < maxDepth) {
          walk(fullPath, depth + 1, nextPrefix);
        }
      } else {
        let sizeLabel = '';
        try {
          const st = fs.statSync(fullPath);
          sizeLabel = ` (${formatBytes(st.size)})`;
        } catch {
          // ignore
        }
        lines.push(`${prefix}${connector}${entry.name}${sizeLabel}`);
      }
    }
  }

  const rootLabel = toPosixRelative(rootReal, dirPath);
  lines.push(rootLabel === '.' ? `${path.basename(rootReal)}/` : `${rootLabel}/`);
  walk(dirPath, 1, '');
  if (truncated) {
    lines.push(`... (output dibatasi maksimal ${maxEntries} item; gunakan list_directory dengan subfolder)`);
  }
  return lines.join('\n');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function wildcardToRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(regexStr, 'i');
}

export function registerWorkspaceTools(server) {
  // 1. get_workspace_info
  server.registerTool(
    'get_workspace_info',
    {
      title: 'Workspace Info',
      description: 'Menampilkan informasi folder workspace aktif, mode akses, dan ringkasan struktur file.',
      inputSchema: {
        depth: z.number().int().min(1).max(4).optional().describe('Kedalaman pohon folder (default 2, maks 4)'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ depth = 2 } = {}) => {
      try {
        const config = getConfig();
        const { rootReal, absolutePath } = resolveSafePath('.', config);
        const tree = buildDirectoryTree(absolutePath, rootReal, config, { maxDepth: depth, maxEntries: 150 });
        return textResult(
          [
            `Workspace Root: ${config.workspaceRoot}`,
            `Mode: ${config.readOnly ? 'READ-ONLY' : 'READ-WRITE'}`,
            '',
            'Struktur Folder:',
            tree,
          ].join('\n')
        );
      } catch (err) {
        return errorResult(err.message);
      }
    }
  );

  // 2. list_directory
  server.registerTool(
    'list_directory',
    {
      title: 'List Directory',
      description: 'Menampilkan daftar file dan subfolder di dalam folder workspace.',
      inputSchema: {
        path: z.string().optional().describe('Path relatif terhadap workspace (default ".")'),
        depth: z.number().int().min(1).max(5).optional().describe('Kedalaman rekursif (default 2, maks 5)'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ path: dirPath = '.', depth = 2 } = {}) => {
      try {
        const config = getConfig();
        const { rootReal, absolutePath, relativePath } = resolveSafePath(dirPath, config);
        const stat = fs.statSync(absolutePath);
        if (!stat.isDirectory()) {
          return errorResult(`"${relativePath}" bukan folder.`);
        }
        const tree = buildDirectoryTree(absolutePath, rootReal, config, { maxDepth: depth, maxEntries: 200 });
        return textResult(tree);
      } catch (err) {
        return errorResult(err.message);
      }
    }
  );

  // 3. read_file
  server.registerTool(
    'read_file',
    {
      title: 'Read File',
      description: 'Membaca isi file teks dengan nomor baris. Gunakan startLine & endLine untuk file besar.',
      inputSchema: {
        path: z.string().describe('Path relatif file di dalam workspace, mis. "src/index.js"'),
        startLine: z.number().int().min(1).optional().describe('Baris awal (1-based, default 1)'),
        endLine: z.number().int().min(1).optional().describe('Baris akhir inklusif (default maks 400 baris dari startLine)'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ path: filePath, startLine = 1, endLine }) => {
      try {
        const config = getConfig();
        const { absolutePath, relativePath } = resolveSafePath(filePath, config);
        const stat = fs.statSync(absolutePath);
        if (!stat.isFile()) {
          return errorResult(`"${relativePath}" bukan file.`);
        }
        if (stat.size > config.maxFileSizeBytes) {
          return errorResult(
            `Ukuran file "${relativePath}" (${formatBytes(stat.size)}) melebihi batas ${formatBytes(config.maxFileSizeBytes)}.`
          );
        }
        const buf = fs.readFileSync(absolutePath);
        if (isProbablyBinary(buf)) {
          return errorResult(`File "${relativePath}" terdeteksi sebagai file biner dan tidak dapat dibaca sebagai teks.`);
        }

        const content = buf.toString('utf8');
        const allLines = content.split(/\r?\n/);
        const totalLines = allLines.length;
        const from = Math.max(1, Math.min(startLine, totalLines));
        const defaultEnd = Math.min(totalLines, from + 399);
        const to = endLine ? Math.min(totalLines, Math.max(from, endLine)) : defaultEnd;

        const numbered = [];
        for (let i = from; i <= to; i++) {
          numbered.push(`${String(i).padStart(4, ' ')} | ${allLines[i - 1]}`);
        }

        const header = `File: ${relativePath} (baris ${from}-${to} dari ${totalLines})`;
        const footer =
          to < totalLines
            ? `\n... (${totalLines - to} baris tersisa; panggil read_file dengan startLine=${to + 1} untuk melanjutkan)`
            : '';

        return textResult(`${header}\n${'-'.repeat(50)}\n${numbered.join('\n')}${footer}`);
      } catch (err) {
        return errorResult(err.message);
      }
    }
  );

  // 4. search_files
  server.registerTool(
    'search_files',
    {
      title: 'Search in Files',
      description: 'Mencari teks atau pola regex di dalam file-file workspace (mirip grep).',
      inputSchema: {
        query: z.string().min(1).describe('Teks atau pola regex yang dicari'),
        path: z.string().optional().describe('Subfolder pencarian (default ".")'),
        isRegex: z.boolean().optional().describe('Perlakukan query sebagai RegExp (default false)'),
        caseSensitive: z.boolean().optional().describe('Pencarian case-sensitive (default false)'),
        extension: z.string().optional().describe('Filter ekstensi file, mis. ".php" atau ".js"'),
        maxResults: z.number().int().min(1).max(200).optional().describe('Maksimal hasil (default 50)'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({
      query,
      path: searchDir = '.',
      isRegex = false,
      caseSensitive = false,
      extension,
      maxResults = 50,
    }) => {
      try {
        const config = getConfig();
        const { rootReal, absolutePath } = resolveSafePath(searchDir, config);
        const flags = caseSensitive ? 'g' : 'gi';
        const matcher = isRegex
          ? new RegExp(query, flags)
          : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);

        const extNorm = extension
          ? (extension.startsWith('.') ? extension : `.${extension}`).toLowerCase()
          : null;
        const blocked = (config.blockedFileNames || []).map((n) => n.toLowerCase());

        const matches = [];
        let scannedFiles = 0;

        function walk(dir) {
          if (matches.length >= maxResults) return;
          let entries;
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const entry of entries) {
            if (matches.length >= maxResults) return;
            if (entry.isDirectory()) {
              if (!isIgnoredDir(entry.name, config)) {
                walk(path.join(dir, entry.name));
              }
              continue;
            }
            if (blocked.includes(entry.name.toLowerCase())) continue;
            if (extNorm && !entry.name.toLowerCase().endsWith(extNorm)) continue;

            const full = path.join(dir, entry.name);
            let st;
            try {
              st = fs.statSync(full);
            } catch {
              continue;
            }
            if (!st.isFile() || st.size > config.maxFileSizeBytes) continue;

            let buf;
            try {
              buf = fs.readFileSync(full);
            } catch {
              continue;
            }
            if (isProbablyBinary(buf)) continue;

            scannedFiles++;
            const rel = toPosixRelative(rootReal, full);
            const lines = buf.toString('utf8').split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              matcher.lastIndex = 0;
              if (matcher.test(lines[i])) {
                const snippet = lines[i].trim().slice(0, 220);
                matches.push(`${rel}:${i + 1}: ${snippet}`);
                if (matches.length >= maxResults) return;
              }
            }
          }
        }

        const stRoot = fs.statSync(absolutePath);
        if (stRoot.isDirectory()) {
          walk(absolutePath);
        } else {
          const buf = fs.readFileSync(absolutePath);
          if (!isProbablyBinary(buf)) {
            scannedFiles = 1;
            const rel = toPosixRelative(rootReal, absolutePath);
            const lines = buf.toString('utf8').split(/\r?\n/);
            for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
              matcher.lastIndex = 0;
              if (matcher.test(lines[i])) {
                matches.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 220)}`);
              }
            }
          }
        }

        if (matches.length === 0) {
          return textResult(`Tidak ditemukan kecocokan untuk "${query}" (${scannedFiles} file dipindai).`);
        }

        return textResult(
          `Ditemukan ${matches.length} hasil (${scannedFiles} file dipindai)${
            matches.length >= maxResults ? ' [batas tercapai]' : ''
          }:\n\n${matches.join('\n')}`
        );
      } catch (err) {
        return errorResult(err.message);
      }
    }
  );

  // 5. find_files
  server.registerTool(
    'find_files',
    {
      title: 'Find Files',
      description: 'Mencari nama file di dalam workspace berdasarkan substring atau wildcard (mis. "*.php", "*controller*").',
      inputSchema: {
        pattern: z.string().min(1).describe('Pola nama file (mis. "*.php", "index", "*.blade.php")'),
        path: z.string().optional().describe('Subfolder awal (default ".")'),
        maxResults: z.number().int().min(1).max(200).optional().describe('Maksimal hasil (default 80)'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ pattern, path: startDir = '.', maxResults = 80 }) => {
      try {
        const config = getConfig();
        const { rootReal, absolutePath } = resolveSafePath(startDir, config);
        const regex = wildcardToRegex(pattern.includes('*') || pattern.includes('?') ? pattern : `*${pattern}*`);
        const blocked = (config.blockedFileNames || []).map((n) => n.toLowerCase());
        const found = [];

        function walk(dir) {
          if (found.length >= maxResults) return;
          let entries;
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const entry of entries) {
            if (found.length >= maxResults) return;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              if (!isIgnoredDir(entry.name, config)) {
                walk(full);
              }
            } else {
              if (blocked.includes(entry.name.toLowerCase())) continue;
              if (regex.test(entry.name)) {
                found.push(toPosixRelative(rootReal, full));
              }
            }
          }
        }

        walk(absolutePath);
        if (found.length === 0) {
          return textResult(`Tidak ada file yang cocok dengan pola "${pattern}".`);
        }
        return textResult(`Ditemukan ${found.length} file:\n${found.join('\n')}`);
      } catch (err) {
        return errorResult(err.message);
      }
    }
  );

  // 6. write_file
  server.registerTool(
    'write_file',
    {
      title: 'Write File',
      description: 'Membuat file baru atau menimpa seluruh isi file di dalam workspace. Parent folder akan dibuat otomatis.',
      inputSchema: {
        path: z.string().min(1).describe('Path relatif file tujuan'),
        content: z.string().describe('Isi lengkap file yang akan ditulis'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ path: filePath, content }) => {
      try {
        const config = getConfig();
        assertWritable(config);
        const { absolutePath, relativePath } = resolveSafePath(filePath, config, { allowNonExistent: true });

        const byteLen = Buffer.byteLength(content, 'utf8');
        if (byteLen > config.maxFileSizeBytes) {
          return errorResult(`Ukuran konten (${formatBytes(byteLen)}) melebihi batas ${formatBytes(config.maxFileSizeBytes)}.`);
        }

        const existed = fs.existsSync(absolutePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, content, 'utf8');

        const lineCount = content.split(/\r?\n/).length;
        const msg = `Berhasil ${existed ? 'memperbarui' : 'membuat'} file "${relativePath}" (${lineCount} baris, ${formatBytes(byteLen)}).`;
        recordToolActivity(config.workspaceRoot, {
          tool: 'write_file',
          target: relativePath,
          action: existed ? 'updated' : 'created',
          detail: `${lineCount} baris`,
        });
        return textResult(msg);
      } catch (err) {
        return errorResult(err.message);
      }
    }
  );

  // 7. edit_file
  server.registerTool(
    'edit_file',
    {
      title: 'Edit File (Search & Replace)',
      description: 'Mengubah bagian tertentu dari file yang sudah ada dengan exact search & replace (aman dan menjaga gaya baris CRLF/LF).',
      inputSchema: {
        path: z.string().min(1).describe('Path relatif file yang akan diedit'),
        oldText: z.string().min(1).describe('Teks persis yang akan diganti'),
        newText: z.string().describe('Teks pengganti'),
        replaceAll: z.boolean().optional().describe('Ganti semua kemunculan (default false; gagal jika lebih dari 1 kecocokan)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ path: filePath, oldText, newText, replaceAll = false }) => {
      try {
        const config = getConfig();
        assertWritable(config);
        const { absolutePath, relativePath } = resolveSafePath(filePath, config);

        const buf = fs.readFileSync(absolutePath);
        if (isProbablyBinary(buf)) {
          return errorResult(`File "${relativePath}" adalah file biner.`);
        }

        const original = buf.toString('utf8');
        const usesCRLF = original.includes('\r\n');
        const normOriginal = original.replace(/\r\n/g, '\n');
        const normOld = oldText.replace(/\r\n/g, '\n');
        const normNew = newText.replace(/\r\n/g, '\n');

        let count = 0;
        let idx = 0;
        while ((idx = normOriginal.indexOf(normOld, idx)) !== -1) {
          count++;
          idx += normOld.length;
        }

        if (count === 0) {
          return errorResult(
            `Teks target (oldText) tidak ditemukan di "${relativePath}". Baca file terlebih dahulu dengan read_file untuk memastikan spasi dan baris persis sama.`
          );
        }
        if (count > 1 && !replaceAll) {
          return errorResult(
            `Teks target ditemukan ${count} kali di "${relativePath}". Berikan konteks baris lebih spesifik atau set replaceAll=true.`
          );
        }

        const updatedNorm = replaceAll
          ? normOriginal.split(normOld).join(normNew)
          : normOriginal.replace(normOld, normNew);

        const finalContent = usesCRLF ? updatedNorm.replace(/\n/g, '\r\n') : updatedNorm;
        fs.writeFileSync(absolutePath, finalContent, 'utf8');

        const changedCount = replaceAll ? count : 1;
        recordToolActivity(config.workspaceRoot, {
          tool: 'edit_file',
          target: relativePath,
          action: 'edited',
          detail: `${changedCount} bagian diganti`,
        });
        return textResult(
          `Berhasil mengedit "${relativePath}" (${changedCount} bagian diganti).`
        );
      } catch (err) {
        return errorResult(err.message);
      }
    }
  );

  // 8. create_directory
  server.registerTool(
    'create_directory',
    {
      title: 'Create Directory',
      description: 'Membuat folder baru di dalam workspace.',
      inputSchema: {
        path: z.string().min(1).describe('Path relatif folder baru'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ path: dirPath }) => {
      try {
        const config = getConfig();
        assertWritable(config);
        const { absolutePath, relativePath } = resolveSafePath(dirPath, config, { allowNonExistent: true });
        fs.mkdirSync(absolutePath, { recursive: true });
        recordToolActivity(config.workspaceRoot, {
          tool: 'create_directory',
          target: relativePath,
          action: 'mkdir',
          detail: 'Folder dibuat',
        });
        return textResult(`Folder "${relativePath}" berhasil dibuat.`);
      } catch (err) {
        return errorResult(err.message);
      }
    }
  );

  // 9. delete_file
  server.registerTool(
    'delete_file',
    {
      title: 'Delete File / Folder',
      description: 'Menghapus file atau folder kosong di dalam workspace. Tidak pernah menghapus folder root workspace.',
      inputSchema: {
        path: z.string().min(1).describe('Path relatif file atau folder yang akan dihapus'),
        recursive: z.boolean().optional().describe('Hapus folder beserta isinya (default false)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ path: targetPath, recursive = false }) => {
      try {
        const config = getConfig();
        assertWritable(config);
        const { rootReal, absolutePath, relativePath } = resolveSafePath(targetPath, config);

        if (relativePath === '.' || path.resolve(absolutePath).toLowerCase() === path.resolve(rootReal).toLowerCase()) {
          return errorResult('Tidak diizinkan menghapus folder root workspace.');
        }

        const stat = fs.statSync(absolutePath);
        if (stat.isDirectory()) {
          fs.rmSync(absolutePath, { recursive, force: false });
          recordToolActivity(config.workspaceRoot, {
            tool: 'delete_file',
            target: relativePath,
            action: 'deleted',
            detail: 'Folder dihapus',
          });
          return textResult(`Folder "${relativePath}" berhasil dihapus.`);
        } else {
          fs.unlinkSync(absolutePath);
          recordToolActivity(config.workspaceRoot, {
            tool: 'delete_file',
            target: relativePath,
            action: 'deleted',
            detail: 'File dihapus',
          });
          return textResult(`File "${relativePath}" berhasil dihapus.`);
        }
      } catch (err) {
        return errorResult(err.message);
      }
    }
  );

  // 10. get_session_memory
  server.registerTool(
    'get_session_memory',
    {
      title: 'Get Session Memory',
      description: 'Membaca memori session aktif (tujuan, ringkasan progres, daftar tugas selesai, file yang sudah diubah, dan langkah berikutnya). Berguna saat baru pindah AI.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      try {
        const config = getConfig();
        const sess = getOrCreateActiveSession(config.workspaceRoot);
        return textResult(formatSessionHandoff(sess));
      } catch (err) {
        return errorResult(err.message);
      }
    }
  );

  // 11. update_session_memory
  server.registerTool(
    'update_session_memory',
    {
      title: 'Update Session Memory',
      description: 'Menyimpan/memperbarui memori session aktif (progres yang sudah dikerjakan, ringkasan, rencana berikutnya, catatan penting) agar tersimpan lintas AI.',
      inputSchema: {
        goal: z.string().optional().describe('Tujuan utama session ini'),
        summary: z.string().optional().describe('Ringkasan progres & kondisi proyek saat ini'),
        addCompleted: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe('Tugas yang baru selesai dikerjakan (string atau array string)'),
        setNextSteps: z
          .array(z.string())
          .optional()
          .describe('Daftar langkah berikutnya yang masih perlu dikerjakan'),
        addNote: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe('Catatan teknis penting (keputusan arsitektur, bug, konvensi)'),
        aiSource: z.string().optional().describe('Nama AI yang menyimpan progres (mis. ChatGPT, Claude, Gemini)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args = {}) => {
      try {
        const config = getConfig();
        const updated = updateSessionMemory(config.workspaceRoot, args);
        return textResult(
          `Memori session "${updated.title}" berhasil diperbarui.\n\n${formatSessionHandoff(updated)}`
        );
      } catch (err) {
        return errorResult(err.message);
      }
    }
  );

  // 12. list_sessions
  server.registerTool(
    'list_sessions',
    {
      title: 'List Memory Sessions',
      description: 'Menampilkan daftar session memori yang tersimpan untuk workspace aktif.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      try {
        const config = getConfig();
        const { activeSessionId, sessions } = listWorkspaceSessions(config.workspaceRoot);
        const lines = sessions.map((s) => {
          const mark = s.id === activeSessionId ? '[AKTIF]' : '       ';
          return `${mark} ${s.title} (${s.id}) — ${s.completedTasks?.length || 0} selesai, ${s.filesTouched?.length || 0} file diubah, update: ${s.updatedAt}`;
        });
        return textResult(`Daftar Session Memori:\n${lines.join('\n')}`);
      } catch (err) {
        return errorResult(err.message);
      }
    }
  );
}
