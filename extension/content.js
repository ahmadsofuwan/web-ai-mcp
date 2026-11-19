(() => {
  const INSTANCE_ID = `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  // Jika instance aktif dari extension YANG SAMA sudah berjalan, jangan duplikasi
  if (window.__WEB_AI_MCP_INSTANCE__ && window.__WEB_AI_MCP_RUNTIME_ID__ === chrome.runtime?.id) {
    return;
  }
  window.__WEB_AI_MCP_INSTANCE__ = INSTANCE_ID;
  window.__WEB_AI_MCP_RUNTIME_ID__ = chrome.runtime?.id || '';

  const KNOWN_TOOLS = new Set([
    'get_workspace_info',
    'list_directory',
    'read_file',
    'search_files',
    'find_files',
    'write_file',
    'edit_file',
    'create_directory',
    'delete_file',
    'get_session_memory',
    'update_session_memory',
    'list_sessions',
  ]);

  const READ_ONLY_TOOLS = new Set([
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

  function isExtensionAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function safeSendMessage(payload) {
    return new Promise((resolve) => {
      if (!isExtensionAlive()) {
        resolve({ ok: false, error: 'Extension direload. Refresh tab (F5) jika perlu.' });
        return;
      }
      try {
        chrome.runtime.sendMessage(payload, (response) => {
          const err = chrome.runtime.lastError;
          if (err) {
            resolve({ ok: false, error: err.message });
            return;
          }
          resolve(response || { ok: false, error: 'Tidak ada respons dari background.' });
        });
      } catch (err) {
        resolve({ ok: false, error: err?.message || String(err) });
      }
    });
  }

  function detectAiPlatformName() {
    const h = location.hostname.toLowerCase();
    if (h.includes('chatgpt') || h.includes('openai')) return 'ChatGPT';
    if (h.includes('claude')) return 'Claude';
    if (h.includes('gemini')) return 'Gemini';
    if (h.includes('aistudio')) return 'AI Studio';
    if (h.includes('deepseek')) return 'DeepSeek';
    if (h.includes('qwen')) return 'Qwen';
    if (h.includes('grok')) return 'Grok';
    if (h.includes('perplexity')) return 'Perplexity';
    if (h.includes('poe')) return 'Poe';
    if (h.includes('mistral')) return 'Mistral';
    if (h.includes('copilot')) return 'Copilot';
    return h || 'Web AI';
  }

  let settings = {
    autoRunReadOnly: true,
    autoRunWrite: true,
    autoSendResult: true,
    maxAutoSteps: 15,
  };

  let autoPaused = false;
  let autoStepsCount = 0;
  let serverOnline = false;
  let isProcessingQueue = false;
  let lastMutationAt = Date.now();

  // Pelacakan per elemen blok kode agar pemanggilan tool yang sama di balasan AI berikutnya TETAP auto-run!
  const blockStateMap = new WeakMap(); // blockEl -> { canonical, cardEl, timer, queued, executed }
  const initialCodeBlocks = new WeakSet();
  const autoQueue = [];
  let turnExecutedCanonicals = new Set();

  function resetTurnDedupe() {
    turnExecutedCanonicals = new Set();
  }

  // Bersihkan HUD / kartu sisa dari extension lama yang sudah di-remove/reload
  function cleanupStaleElements() {
    const oldHud = document.getElementById('web-ai-mcp-hud');
    if (oldHud && oldHud.dataset.mcpInstance !== INSTANCE_ID) {
      oldHud.remove();
    }
    const oldFab = document.getElementById('web-ai-mcp-fab');
    if (oldFab && !oldFab.closest('#web-ai-mcp-hud')) {
      oldFab.remove();
    }
    document.querySelectorAll('.web-ai-mcp-card').forEach((card) => {
      if (card.dataset.mcpInstance !== INSTANCE_ID) {
        card.remove();
      }
    });
  }

  // ---------------- HUD Floating Pill ----------------
  function mountFloatingHud() {
    cleanupStaleElements();
    if (document.getElementById('web-ai-mcp-hud')) return;

    const hud = document.createElement('div');
    hud.id = 'web-ai-mcp-hud';
    hud.dataset.mcpInstance = INSTANCE_ID;
    hud.innerHTML = `
      <button type="button" id="web-ai-mcp-fab" title="Buka Side Panel Web AI MCP Agent">
        <span class="mcp-dot" id="web-ai-mcp-dot"></span>
        <span id="web-ai-mcp-label">MCP Agent</span>
      </button>
      <button type="button" id="web-ai-mcp-pause" title="Klik untuk Jeda / Lanjutkan mode otomatis">AUTO ON</button>
    `;
    document.body.appendChild(hud);

    document.getElementById('web-ai-mcp-fab').addEventListener('click', () => {
      safeSendMessage({ type: 'OPEN_SIDEPANEL' });
    });

    document.getElementById('web-ai-mcp-pause').addEventListener('click', () => {
      autoPaused = !autoPaused;
      if (!autoPaused) {
        autoStepsCount = 0;
        scanCodeBlocks();
        processAutoQueue();
      }
      updateHud();
    });

    refreshFabStatus();
    updateHud();
  }

  function updateHud() {
    const dot = document.getElementById('web-ai-mcp-dot');
    const label = document.getElementById('web-ai-mcp-label');
    const pauseBtn = document.getElementById('web-ai-mcp-pause');
    if (!dot || !label || !pauseBtn) return;

    dot.className = `mcp-dot ${isProcessingQueue ? 'busy' : serverOnline ? 'online' : ''}`;
    label.textContent = isProcessingQueue
      ? `MCP Running (${autoStepsCount}/${settings.maxAutoSteps})`
      : 'MCP Agent';

    const autoEnabled = !autoPaused && (settings.autoRunReadOnly || settings.autoRunWrite);
    pauseBtn.className = autoEnabled ? '' : 'paused';
    pauseBtn.textContent = autoPaused
      ? '⏸ PAUSED'
      : autoEnabled
        ? `⚡ AUTO ${autoStepsCount}/${settings.maxAutoSteps}`
        : 'MANUAL';
  }

  async function refreshFabStatus() {
    if (!isExtensionAlive()) return;
    const res = await safeSendMessage({ type: 'MCP_HEALTH' });
    serverOnline = Boolean(res?.ok);
    updateHud();
  }

  async function loadSettings() {
    if (!isExtensionAlive()) return;
    const res = await safeSendMessage({ type: 'GET_SETTINGS' });
    if (res?.ok && res.settings) {
      settings = { ...settings, ...res.settings };
      updateHud();
    }
  }

  // ---------------- Deep DOM (Light + Open Shadow DOM) ----------------
  function queryAllDeep(root, selector, out = []) {
    if (!root) return out;
    try {
      const matched = root.querySelectorAll(selector);
      for (const el of matched) out.push(el);
      const all = root.querySelectorAll('*');
      for (const el of all) {
        if (el.shadowRoot) {
          queryAllDeep(el.shadowRoot, selector, out);
        }
      }
    } catch {
      // ignore inaccessible nodes
    }
    return out;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
      rect.width > 8 &&
      rect.height > 8 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      style.opacity !== '0'
    );
  }

  function isAiCurrentlyStreaming() {
    // Selector khusus tombol Stop generation yang akurat (tidak salah deteksi icon lain)
    const stopSelectors = [
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop generating" i]',
      'button[aria-label*="Stop response" i]',
      'button[aria-label*="Stop streaming" i]',
      'button[aria-label="Stop" i]',
      'button[aria-label*="Hentikan respons" i]',
      'button[aria-label*="Hentikan" i]',
    ];
    for (const sel of stopSelectors) {
      const nodes = document.querySelectorAll(sel);
      for (const el of nodes) {
        if (isVisible(el) && !el.closest('#web-ai-mcp-hud') && !el.closest('.web-ai-mcp-card')) {
          return true;
        }
      }
    }
    return false;
  }

  function waitUntilNotStreaming(timeoutMs = 5000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        const streaming = isAiCurrentlyStreaming();
        const domQuietMs = Date.now() - lastMutationAt;
        // Selesai jika tidak ada tombol Stop, atau DOM sudah tenang >= 1.5 detik, atau timeout
        if (!streaming || domQuietMs >= 1500 || Date.now() - start >= timeoutMs) {
          resolve();
          return;
        }
        setTimeout(check, 250);
      };
      check();
    });
  }

  function isInsideCodeViewer(el) {
    return Boolean(
      el &&
        el.closest(
          '.cm-editor, .monaco-editor, pre, code, .qwen-markdown-code, [class*="qwen-markdown-code" i], .web-ai-mcp-card, #web-ai-mcp-hud'
        )
    );
  }

  function findChatInput() {
    const selectors = [
      '#prompt-textarea',
      'div.ProseMirror[contenteditable="true"]#prompt-textarea',
      'div.ProseMirror[contenteditable="true"]',
      'rich-textarea div.ql-editor[contenteditable="true"]',
      'div.ql-editor[contenteditable="true"]',
      'textarea.message-input-textarea',
      'textarea[placeholder*="Ask Qwen" i]',
      'textarea[placeholder*="Qwen" i]',
      'textarea#chat-input',
      'textarea[data-testid]',
      'textarea[placeholder]',
      'textarea',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
    ];

    for (const sel of selectors) {
      const nodes = queryAllDeep(document, sel);
      for (const el of nodes) {
        if (el.classList.contains('inputarea')) continue;
        if (isInsideCodeViewer(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 40) continue;
        if (isVisible(el)) {
          return el;
        }
      }
    }
    return null;
  }

  function isButtonEnabled(btn) {
    if (!btn || !isVisible(btn)) return false;
    if (btn.closest('.web-ai-mcp-card') || btn.closest('#web-ai-mcp-hud')) return false;
    return !(
      btn.disabled ||
      btn.getAttribute('aria-disabled') === 'true' ||
      btn.classList.contains('disabled')
    );
  }

  function findSendButton(inputEl = null) {
    const selectors = [
      '#send-message-button',
      'button.send-message-button',
      '.message-input-right-button-send button',
      'button[data-testid="send-button"]',
      'button[data-testid="fruitjuice-send-button"]',
      'button[data-testid*="send" i]',
      'button[aria-label="Send prompt" i]',
      'button[aria-label="Send message" i]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="Kirim" i]',
      'button[aria-label*="Run" i]',
      'button[aria-label*="Submit" i]',
      'button.send-button',
      'button[class*="send-button" i]',
      'button[class*="send-message" i]',
      'button[type="submit"]',
      'div[role="button"][aria-label*="Send" i]',
      'div[role="button"][aria-label*="Kirim" i]',
    ];
    for (const sel of selectors) {
      const nodes = queryAllDeep(document, sel);
      for (const btn of nodes) {
        if (isButtonEnabled(btn)) {
          return btn;
        }
      }
    }

    // Fallback khusus UI composer modern (seperti Qwen yang tombol panah ↑-nya tanpa aria-label)
    if (inputEl) {
      let container = inputEl.closest('form');
      if (!container) {
        let cur = inputEl.parentElement;
        for (let i = 0; i < 6 && cur && cur !== document.body; i++) {
          const rect = cur.getBoundingClientRect();
          if (rect.height > 30 && rect.height < 360 && cur.querySelectorAll('button').length >= 2) {
            container = cur;
            break;
          }
          cur = cur.parentElement;
        }
      }
      if (container) {
        const candidates = Array.from(container.querySelectorAll('button, [role="button"]')).filter((btn) => {
          if (!isButtonEnabled(btn)) return false;
          if (btn.getAttribute('aria-haspopup')) return false;
          const label = (btn.innerText || btn.textContent || '').trim();
          // Tombol kirim panah ↑ di Qwen/AI modern berupa tombol ikon tanpa teks panjang
          if (label.length > 0 && !/^(send|kirim|submit|↑)$/i.test(label)) return false;
          const aria = (btn.getAttribute('aria-label') || btn.getAttribute('title') || '').toLowerCase();
          if (/(voice|mic|audio|attach|upload|file|image|plus|add|menu|model|stop|cancel)/.test(aria)) {
            return false;
          }
          return Boolean(btn.querySelector('svg') || label);
        });
        if (candidates.length > 0) {
          // Pilih tombol paling kanan di bar input
          candidates.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
          return candidates[0];
        }
      }
    }

    return null;
  }

  function getInputLength(input) {
    if (!input) return 0;
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      return (input.value || '').trim().length;
    }
    return (input.innerText || input.textContent || '').trim().length;
  }

  function setInputContent(input, text) {
    input.focus();

    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      const proto = input.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      const currentVal = input.value || '';
      const nextVal = currentVal.trim() ? `${currentVal}\n\n${text}` : text;
      if (setter) {
        setter.call(input, nextVal);
      } else {
        input.value = nextVal;
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    const beforeLen = getInputLength(input);
    const existing = (input.innerText || '').trim();
    const payload = existing ? `\n\n${text}` : text;

    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(input);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('insertText', false, payload);
    } catch {
      // fallback below
    }

    if (getInputLength(input) <= beforeLen) {
      if (!existing) {
        input.innerHTML = '';
      }
      const lines = payload.split('\n');
      for (const line of lines) {
        const p = document.createElement('p');
        if (line) {
          p.textContent = line;
        } else {
          p.appendChild(document.createElement('br'));
        }
        input.appendChild(p);
      }
    }

    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  async function triggerAutoSend(input) {
    await waitUntilNotStreaming(4000);
    await new Promise((r) => setTimeout(r, 220));

    const lenBefore = getInputLength(input);
    if (lenBefore === 0) return true;

    for (let attempt = 0; attempt < 5; attempt++) {
      const sendBtn = findSendButton(input);
      if (sendBtn) {
        sendBtn.click();
        await new Promise((r) => setTimeout(r, 320));
        if (getInputLength(input) < lenBefore) {
          return true;
        }
      }
      await new Promise((r) => setTimeout(r, 180));
    }

    input.focus();
    const enterOpts = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    };
    input.dispatchEvent(new KeyboardEvent('keydown', enterOpts));
    input.dispatchEvent(new KeyboardEvent('keypress', enterOpts));
    input.dispatchEvent(new KeyboardEvent('keyup', enterOpts));

    await new Promise((r) => setTimeout(r, 300));
    if (getInputLength(input) < lenBefore) {
      return true;
    }

    input.dispatchEvent(new KeyboardEvent('keydown', { ...enterOpts, ctrlKey: true }));
    return true;
  }

  async function insertTextIntoChat(text, autoSend = false) {
    const input = findChatInput();
    if (!input) {
      return { ok: false, error: 'Kolom input chat AI tidak ditemukan di halaman ini.' };
    }

    setInputContent(input, text);

    if (autoSend) {
      resetTurnDedupe();
      await triggerAutoSend(input);
    }

    return { ok: true };
  }

  // ---------------- MCP Tool Call Parser & Multi-Renderer Scanner ----------------
  function isInsideUserMessageOrInput(el) {
    if (!el) return true;
    if (el.closest('.web-ai-mcp-card, #web-ai-mcp-hud')) return true;
    if (el.closest('textarea, input')) return true;

    // Pastikan blok CodeMirror/Monaco viewer tidak dianggap kotak input chat
    const chatInput = findChatInput();
    if (chatInput && (chatInput === el || chatInput.contains(el))) return true;
    if (
      el.closest('[contenteditable="true"]') &&
      !el.closest('.cm-editor, .monaco-editor, pre, .qwen-markdown-code, [class*="code-block" i], [class*="codeblock" i]')
    ) {
      return true;
    }

    // Pesan milik user di berbagai platform AI (ChatGPT, Claude, Gemini, Qwen, DeepSeek, dll.)
    if (el.closest('[data-message-author-role="user"]')) return true;
    if (el.closest('[data-testid="user-message"]')) return true;
    if (el.closest('user-query')) return true;
    if (el.closest('.chat-user, .user-message, [class*="user-message" i], [class*="chat-user" i], [class*="qwen-chat-message-user" i]')) {
      return true;
    }
    return false;
  }

  function extractTextPreservingLines(node) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) {
      return node.nodeValue || '';
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName;
    if (tag === 'BR') return '\n';

    const isBlock = tag === 'DIV' || tag === 'P' || tag === 'TR' || tag === 'LI' || tag === 'PRE';
    let out = '';
    for (const child of node.childNodes) {
      out += extractTextPreservingLines(child);
    }
    if (isBlock && out && !out.endsWith('\n')) {
      out += '\n';
    }
    return out;
  }

  function extractCodeText(blockEl) {
    if (!blockEl) return '';

    // 1. CodeMirror 6 (dipakai Qwen & editor modern: .cm-editor > .cm-scroller > .cm-content > .cm-line)
    const cmContent = blockEl.matches('.cm-content')
      ? blockEl
      : blockEl.querySelector('.cm-content');
    if (cmContent) {
      const lines = cmContent.querySelectorAll('.cm-line');
      if (lines.length > 0) {
        return Array.from(lines)
          .map((line) => line.innerText || line.textContent || '')
          .join('\n')
          .trim();
      }
      return (cmContent.innerText || cmContent.textContent || '').trim();
    }

    // 2. Monaco Editor (dipakai Qwen / VS Code web renderer: .view-lines > .view-line berposisi top)
    const monacoLinesRoot = blockEl.matches('.view-lines')
      ? blockEl
      : blockEl.querySelector('.view-lines');
    if (monacoLinesRoot) {
      const viewLines = Array.from(monacoLinesRoot.querySelectorAll('.view-line'));
      if (viewLines.length > 0) {
        viewLines.sort((a, b) => {
          const topA = parseFloat(a.style.top);
          const topB = parseFloat(b.style.top);
          if (!Number.isNaN(topA) && !Number.isNaN(topB)) return topA - topB;
          return a.getBoundingClientRect().top - b.getBoundingClientRect().top;
        });
        return viewLines
          .map((line) => line.innerText || line.textContent || '')
          .join('\n')
          .trim();
      }
    }

    // 3. Highlight.js table dengan nomor baris (td.hljs-ln-code)
    const hljsCodeCells = blockEl.querySelectorAll('td.hljs-ln-code');
    if (hljsCodeCells.length > 0) {
      return Array.from(hljsCodeCells)
        .map((td) => td.innerText || td.textContent || '')
        .join('\n')
        .trim();
    }

    // 4. Standar <pre>, <code>, atau wrapper custom (bersihkan gutter/nomor baris/tombol di clone)
    const innerCode = blockEl.tagName === 'CODE' ? blockEl : blockEl.querySelector('code');
    const codeHasJson = innerCode && /[{[]/.test(innerCode.textContent || '');
    const sourceEl = codeHasJson ? innerCode : blockEl;

    const clone = sourceEl.cloneNode(true);
    const junkSelectors = [
      '.linenumber',
      '.line-number',
      '.line-numbers',
      '.line-numbers-rows',
      '.react-syntax-highlighter-line-number',
      '.cm-gutters',
      '.cm-gutter',
      '.gutter',
      '.gutters',
      '.hljs-ln-numbers',
      '.margin-view-overlays',
      '[class*="line-num" i]',
      '[class*="linenum" i]',
      '[class*="gutter" i]',
      'button',
      '.web-ai-mcp-card',
      '.web-ai-mcp-output',
    ];
    for (const sel of junkSelectors) {
      clone.querySelectorAll(sel).forEach((n) => n.remove());
    }

    return extractTextPreservingLines(clone).trim();
  }

  function findCodeBlockContainers() {
    const result = [];
    const seen = new Set();

    const addUnique = (el) => {
      if (!el || seen.has(el)) return;
      if (el.classList?.contains('web-ai-mcp-output')) return;
      if (el.closest('.web-ai-mcp-card, #web-ai-mcp-hud')) return;
      if (!isVisible(el)) return;
      // Hindari duplikasi jika sudah ada parent/child di list
      for (const existing of result) {
        if (existing === el || existing.contains(el) || el.contains(existing)) {
          return;
        }
      }
      seen.add(el);
      result.push(el);
    };

    // Prioritas 1: Editor blok kode modern (Qwen CodeMirror 6 & Monaco Editor)
    for (const el of queryAllDeep(document, '.cm-editor, .monaco-editor')) {
      addUnique(el);
    }

    // Prioritas 2: Standar <pre> (ChatGPT, Claude, Gemini, DeepSeek, dll.)
    for (const el of queryAllDeep(document, 'pre')) {
      addUnique(el);
    }

    // Prioritas 3: Elemen <code> standalone berkelas language-* / mcp-tool tanpa <pre>
    for (const el of queryAllDeep(document, 'code[class*="language-"], code[class*="mcp-tool" i]')) {
      addUnique(el);
    }

    // Prioritas 4: Fallback khusus UI custom (mis. komponen Qwen tanpa <pre>/CodeMirror/Monaco)
    // Cari label bahasa persis "mcp-tool" lalu naik ke wrapper blok kode terdekat
    const labelCandidates = queryAllDeep(document, 'span, div, p, code, header');
    for (const el of labelCandidates) {
      if (el.children.length > 2) continue;
      if (el.closest('.web-ai-mcp-card, #web-ai-mcp-hud')) continue;
      const txt = (el.textContent || '').trim().toLowerCase();
      if (txt !== 'mcp-tool') continue;

      let wrap = el.parentElement;
      for (let depth = 0; depth < 4 && wrap && wrap !== document.body; depth++) {
        const wText = wrap.textContent || '';
        if (wText.length > 10 && wText.length < 150000 && /[{[]/.test(wText) && /"tool"|"name"/.test(wText)) {
          // Jangan ambil wrapper yang sudah berisi blok kode yang tertangkap di atas
          let overlaps = false;
          for (const existing of result) {
            if (existing.contains(wrap) || wrap.contains(existing)) {
              overlaps = true;
              break;
            }
          }
          if (!overlaps) {
            addUnique(wrap);
          }
          break;
        }
        wrap = wrap.parentElement;
      }
    }

    return result;
  }

  function normalizeRawCodeText(rawText) {
    return (rawText || '')
      .replace(/\r\n?/g, '\n')
      // Monaco & beberapa highlighter memakai non-breaking space (\u00A0) yang membuat JSON.parse gagal!
      .replace(/[\u00A0\u2007\u202F\u2009]/g, ' ')
      // Hapus zero-width characters (CodeMirror / markdown renderer)
      .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")
      .trim();
  }

  function stripInlineLineNumbers(text) {
    const lines = text.split('\n');

    // Pola A: nomor baris menempel di awal tiap baris, mis. "1 [" atau "1[" / "2   { \"tool\": ... }" / "6]"
    const inlineRe = /^\s*(\d{1,4})(?:\s+|(?=[{\[\]}",]))/;
    let inlineMatches = 0;
    for (const line of lines) {
      if (inlineRe.test(line)) inlineMatches++;
    }
    if (inlineMatches >= 2) {
      return lines.map((line) => line.replace(inlineRe, '')).join('\n');
    }

    // Pola B: nomor baris berdiri sendiri di baris terpisah (1\n[\n2\n{...})
    let standaloneNums = 0;
    for (const line of lines) {
      if (/^\s*\d{1,4}\s*$/.test(line)) standaloneNums++;
    }
    if (standaloneNums >= 2) {
      return lines.filter((line) => !/^\s*\d{1,4}\s*$/.test(line)).join('\n');
    }

    return text;
  }

  function extractJsonCandidate(rawText) {
    const text = normalizeRawCodeText(rawText);
    if (!text) return null;

    const firstBrace = text.indexOf('{');
    const firstBracket = text.indexOf('[');
    let start = -1;
    let endChar = '';

    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
      start = firstBrace;
      endChar = '}';
    } else if (firstBracket !== -1) {
      start = firstBracket;
      endChar = ']';
    }
    if (start === -1) return null;

    const end = text.lastIndexOf(endChar);
    if (end <= start) return null;

    return text.slice(start, end + 1);
  }

  function tryParseJsonTolerant(text) {
    const candidate = extractJsonCandidate(text);
    if (!candidate) return null;
    try {
      return JSON.parse(candidate);
    } catch {
      try {
        const cleaned = candidate.replace(/,\s*([}\]])/g, '$1');
        return JSON.parse(cleaned);
      } catch {
        return null;
      }
    }
  }

  function parseMcpToolBlock(rawText) {
    const normalized = normalizeRawCodeText(rawText);
    if (!normalized) return null;

    let parsed = tryParseJsonTolerant(normalized);
    if (!parsed) {
      // Fallback: jika nomor baris (1, 2, 3...) terbawa masuk ke teks blok kode (seperti Qwen)
      const withoutLineNums = stripInlineLineNumbers(normalized);
      if (withoutLineNums !== normalized) {
        parsed = tryParseJsonTolerant(withoutLineNums);
      }
    }
    if (!parsed) return null;

    const list = Array.isArray(parsed) ? parsed : [parsed];
    if (list.length === 0) return null;

    const validCalls = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') return null;
      const toolName = item.tool || item.name;
      if (typeof toolName !== 'string' || !KNOWN_TOOLS.has(toolName)) return null;
      const rawArgs = item.arguments ?? item.args ?? item.params ?? {};
      if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) return null;

      validCalls.push({
        tool: toolName,
        arguments: rawArgs,
      });
    }
    return validCalls;
  }

  function formatToolResultForChat(results) {
    const sections = results.map((r) => {
      const status = r.isError ? 'ERROR' : 'OK';
      const argsSummary = JSON.stringify(r.arguments || {});
      return [
        `[MCP_TOOL_RESULT tool="${r.tool}" status="${status}"]`,
        `Arguments: ${argsSummary}`,
        '```text',
        r.output || '(kosong)',
        '```',
      ].join('\n');
    });

    return [
      ...sections,
      '',
      'Lanjutkan tugas berdasarkan hasil MCP di atas. Jika perlu langkah lanjutan, langsung panggil blok ```mcp-tool berikutnya. Jika tugas sudah selesai sepenuhnya, simpan ringkasan ke update_session_memory lalu berikan jawaban akhir tanpa blok mcp-tool.',
    ].join('\n');
  }

  function canAutoRunCalls(calls) {
    if (autoPaused) return { allowed: false, reason: 'Mode otomatis sedang dijeda (PAUSED).' };
    if (autoStepsCount >= settings.maxAutoSteps) {
      return {
        allowed: false,
        reason: `Batas ${settings.maxAutoSteps} langkah otomatis tercapai — klik tombol di kartu untuk melanjutkan.`,
      };
    }

    for (const c of calls) {
      if (DESTRUCTIVE_TOOLS.has(c.tool)) {
        return { allowed: false, reason: `Tool "${c.tool}" bersifat hapus permanen — wajib klik manual.` };
      }
      if (MEMORY_WRITE_TOOLS.has(c.tool)) {
        if (!settings.autoRunReadOnly && !settings.autoRunWrite) {
          return { allowed: false, reason: 'Mode otomatis sedang nonaktif.' };
        }
        continue;
      }
      const isRead = READ_ONLY_TOOLS.has(c.tool);
      if (isRead && !settings.autoRunReadOnly) {
        return { allowed: false, reason: 'Auto-run Read-Only sedang nonaktif.' };
      }
      if (!isRead && !settings.autoRunWrite) {
        return { allowed: false, reason: 'Auto-run Edit/Write sedang nonaktif — klik manual.' };
      }
    }
    return { allowed: true };
  }

  // ---------------- Execution & Auto-Loop Queue ----------------
  async function executeToolCalls(calls, cardState, { sendToChat = true, isAutoRun = false } = {}) {
    const { statusEl, outputEl, runSendBtn, runOnlyBtn, copyBtn } = cardState;
    runSendBtn.disabled = true;
    runOnlyBtn.disabled = true;
    statusEl.className = 'web-ai-mcp-status';
    statusEl.textContent = isAutoRun
      ? '⚡ Menjalankan otomatis di Local MCP Server...'
      : 'Menjalankan di Local MCP Server...';

    const results = [];
    let hasError = false;

    for (const call of calls) {
      const effectiveArgs =
        call.tool === 'update_session_memory' && !call.arguments?.aiSource
          ? { ...(call.arguments || {}), aiSource: detectAiPlatformName() }
          : call.arguments;

      const res = await safeSendMessage({
        type: 'MCP_CALL_TOOL',
        tool: call.tool,
        arguments: effectiveArgs,
        isAutoRun,
      });

      if (!res.ok) {
        hasError = true;
        results.push({
          tool: call.tool,
          arguments: call.arguments,
          isError: true,
          output: `Error: ${res.error}`,
        });
      } else {
        if (res.isError) hasError = true;
        results.push({
          tool: call.tool,
          arguments: call.arguments,
          isError: res.isError,
          output: res.output,
        });
      }
    }

    const combinedText = results
      .map((r) => `# ${r.tool}${r.isError ? ' [ERROR]' : ''}\n${r.output}`)
      .join('\n\n');

    outputEl.style.display = 'block';
    outputEl.textContent =
      combinedText.slice(0, 6000) + (combinedText.length > 6000 ? '\n... (dipotong di preview)' : '');
    copyBtn.style.display = 'inline-block';

    if (sendToChat) {
      const chatPayload = formatToolResultForChat(results);
      const shouldAutoSend = Boolean(settings.autoSendResult);
      const inserted = await insertTextIntoChat(chatPayload, shouldAutoSend);
      if (inserted.ok) {
        statusEl.className = `web-ai-mcp-status ${hasError ? 'err' : 'ok'}`;
        statusEl.textContent = shouldAutoSend
          ? '✅ Selesai! Hasil otomatis dikirim kembali ke AI.'
          : '✅ Selesai! Hasil sudah dimasukkan ke kolom chat — tekan Enter untuk mengirim.';
      } else {
        statusEl.className = 'web-ai-mcp-status err';
        statusEl.textContent = `Tool selesai, tapi gagal sisip otomatis: ${inserted.error}`;
      }
    } else {
      statusEl.className = `web-ai-mcp-status ${hasError ? 'err' : 'ok'}`;
      statusEl.textContent = hasError ? 'Selesai dengan error.' : 'Berhasil dijalankan.';
    }

    runSendBtn.disabled = false;
    runOnlyBtn.disabled = false;
    return results;
  }

  async function processAutoQueue() {
    if (isProcessingQueue || autoPaused) return;
    if (autoQueue.length === 0) return;

    isProcessingQueue = true;
    updateHud();

    try {
      while (autoQueue.length > 0 && !autoPaused) {
        await waitUntilNotStreaming(4500);
        if (autoPaused) break;

        const batch = [];
        while (autoQueue.length > 0) {
          const job = autoQueue.shift();
          const st = blockStateMap.get(job.blockEl);
          if (!st || st.executed) continue;
          if (!job.forceManual && turnExecutedCanonicals.has(st.canonical)) {
            st.executed = true;
            continue;
          }

          const check = canAutoRunCalls(job.calls);
          if (!check.allowed) {
            job.cardState.statusEl.textContent = check.reason;
            continue;
          }
          st.executed = true;
          turnExecutedCanonicals.add(st.canonical);
          batch.push(job);
        }

        if (batch.length === 0) continue;

        autoStepsCount++;
        updateHud();

        const allResults = [];
        for (const job of batch) {
          const isSingle = batch.length === 1;
          const res = await executeToolCalls(job.calls, job.cardState, {
            sendToChat: isSingle,
            isAutoRun: true,
          });
          allResults.push(...res);
        }

        if (batch.length > 1 && allResults.length > 0) {
          const combinedPayload = formatToolResultForChat(allResults);
          await insertTextIntoChat(combinedPayload, Boolean(settings.autoSendResult));
          for (const job of batch) {
            job.cardState.statusEl.className = 'web-ai-mcp-status ok';
            job.cardState.statusEl.textContent = settings.autoSendResult
              ? '✅ Selesai (batch)! Semua hasil otomatis dikirim ke AI.'
              : '✅ Selesai (batch)! Hasil dimasukkan ke chat.';
          }
        }
      }
    } finally {
      isProcessingQueue = false;
      updateHud();
    }
  }

  function getCardAnchor(blockEl) {
    // Jika blok adalah CodeMirror/Monaco di dalam wrapper code block (mis. Qwen), tempelkan kartu di atas wrapper-nya agar tidak terpotong overflow:hidden
    const outerWrapper = blockEl.closest(
      '.qwen-markdown-code, [class*="qwen-markdown-code" i], [class*="code-block-wrapper" i]'
    );
    if (outerWrapper && outerWrapper.parentNode) {
      return outerWrapper;
    }
    return blockEl;
  }

  function createToolCard(blockEl, calls, isPreExisting) {
    const hasDestructive = calls.some((c) => DESTRUCTIVE_TOOLS.has(c.tool));
    const allReadOnly = calls.every((c) => READ_ONLY_TOOLS.has(c.tool) || MEMORY_WRITE_TOOLS.has(c.tool));
    const modeClass = hasDestructive ? 'danger-mode' : allReadOnly ? 'read-mode' : 'write-mode';
    const badgeClass = hasDestructive ? 'danger' : allReadOnly ? 'read' : 'write';
    const badgeLabel = hasDestructive ? 'MCP DELETE' : allReadOnly ? 'MCP READ' : 'MCP WRITE';

    const card = document.createElement('div');
    card.className = `web-ai-mcp-card ${modeClass}`;
    card.dataset.mcpInstance = INSTANCE_ID;

    const titleText = calls.length === 1 ? calls[0].tool : `${calls.length} MCP tools`;
    const targetText =
      calls.length === 1
        ? calls[0].arguments?.path || calls[0].arguments?.query || calls[0].arguments?.pattern || ''
        : calls.map((c) => c.tool).join(', ');

    const autoCheck = isPreExisting
      ? { allowed: false, reason: 'Blok dari riwayat chat sebelumnya (klik manual jika ingin jalankan ulang).' }
      : canAutoRunCalls(calls);

    card.innerHTML = `
      <div class="web-ai-mcp-card-top">
        <div class="web-ai-mcp-meta">
          <span class="web-ai-mcp-badge ${badgeClass}">${badgeLabel}</span>
          <span class="web-ai-mcp-title"></span>
          <span class="web-ai-mcp-target"></span>
        </div>
        <div class="web-ai-mcp-actions">
          <button type="button" class="web-ai-mcp-btn ${allReadOnly ? 'primary' : 'warn'}" data-act="run-send">▶ Jalankan &amp; Kirim</button>
          <button type="button" class="web-ai-mcp-btn" data-act="run-only">Jalankan Saja</button>
          <button type="button" class="web-ai-mcp-btn" data-act="copy" style="display:none">Salin</button>
        </div>
      </div>
      <div class="web-ai-mcp-status">${
        autoCheck.allowed
          ? '⏳ Menunggu AI selesai mengetik lalu jalankan otomatis...'
          : autoCheck.reason
      }</div>
      <pre class="web-ai-mcp-output" style="display:none"></pre>
    `;

    card.querySelector('.web-ai-mcp-title').textContent = titleText;
    card.querySelector('.web-ai-mcp-target').textContent = targetText ? `· ${targetText}` : '';

    const runSendBtn = card.querySelector('[data-act="run-send"]');
    const runOnlyBtn = card.querySelector('[data-act="run-only"]');
    const copyBtn = card.querySelector('[data-act="copy"]');
    const statusEl = card.querySelector('.web-ai-mcp-status');
    const outputEl = card.querySelector('.web-ai-mcp-output');

    const cardState = { statusEl, outputEl, runSendBtn, runOnlyBtn, copyBtn };
    let lastFormattedForChat = '';

    runSendBtn.addEventListener('click', async () => {
      const st = blockStateMap.get(blockEl);
      if (st) {
        st.executed = true;
        turnExecutedCanonicals.add(st.canonical);
      }
      autoStepsCount = 0;
      updateHud();
      const res = await executeToolCalls(calls, cardState, { sendToChat: true, isAutoRun: false });
      lastFormattedForChat = formatToolResultForChat(res);
    });

    runOnlyBtn.addEventListener('click', async () => {
      const st = blockStateMap.get(blockEl);
      if (st) {
        st.executed = true;
        turnExecutedCanonicals.add(st.canonical);
      }
      const res = await executeToolCalls(calls, cardState, { sendToChat: false, isAutoRun: false });
      lastFormattedForChat = formatToolResultForChat(res);
    });

    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(lastFormattedForChat || outputEl.textContent || '').then(() => {
        statusEl.textContent = 'Hasil disalin ke clipboard.';
      });
    });

    const anchorEl = getCardAnchor(blockEl);
    if (anchorEl.parentNode) {
      anchorEl.parentNode.insertBefore(card, anchorEl);
    }

    return { card, cardState, autoAllowed: autoCheck.allowed };
  }

  function scanCodeBlocks({ forceRunLatest = false } = {}) {
    if (!isExtensionAlive()) return 0;

    const blocks = findCodeBlockContainers();
    let latestRunnableJob = null;

    for (const blockEl of blocks) {
      if (isInsideUserMessageOrInput(blockEl)) continue;

      const rawText = extractCodeText(blockEl);
      const calls = parseMcpToolBlock(rawText);
      if (!calls) continue;

      const canonical = JSON.stringify(calls);
      const prev = blockStateMap.get(blockEl);

      // Jika blok sudah diproses dengan JSON kanonikal yang sama & kartunya masih menempel di DOM
      if (prev && prev.canonical === canonical && prev.cardEl?.isConnected) {
        if (!prev.executed) {
          latestRunnableJob = { blockEl, calls, cardState: prev.cardState };
        }
        continue;
      }

      const isPreExisting = initialCodeBlocks.has(blockEl);
      const alreadyDoneThisTurn = !isPreExisting && turnExecutedCanonicals.has(canonical);

      if (prev?.cardEl && prev.cardEl.parentNode) {
        prev.cardEl.remove();
      }
      if (prev?.timer) {
        clearTimeout(prev.timer);
      }

      const { card, cardState, autoAllowed } = createToolCard(
        blockEl,
        calls,
        isPreExisting || alreadyDoneThisTurn
      );
      if (alreadyDoneThisTurn) {
        cardState.statusEl.className = 'web-ai-mcp-status ok';
        cardState.statusEl.textContent = '✅ Sudah dijalankan pada giliran ini.';
      }

      const stateEntry = {
        canonical,
        cardEl: card,
        cardState,
        timer: null,
        queued: false,
        executed: Boolean(prev?.executed || alreadyDoneThisTurn),
      };
      blockStateMap.set(blockEl, stateEntry);

      if (!stateEntry.executed) {
        latestRunnableJob = { blockEl, calls, cardState };
      }

      safeSendMessage({
        type: 'TOOL_CALL_DETECTED',
        call: { calls, url: location.href },
      });

      if (!isPreExisting && autoAllowed && !stateEntry.executed) {
        stateEntry.timer = setTimeout(() => {
          if (!blockEl.isConnected || stateEntry.executed || stateEntry.queued) return;
          const latestCalls = parseMcpToolBlock(extractCodeText(blockEl));
          if (!latestCalls) return;
          // Bandingkan JSON kanonikal, bukan whitespace mentah (tahan terhadap syntax highlighting)
          if (JSON.stringify(latestCalls) === canonical) {
            stateEntry.queued = true;
            autoQueue.push({ blockEl, calls: latestCalls, cardState });
            processAutoQueue();
          }
        }, 700);
      }
    }

    if (forceRunLatest && latestRunnableJob) {
      const st = blockStateMap.get(latestRunnableJob.blockEl);
      if (st && !st.executed && !st.queued) {
        initialCodeBlocks.delete(latestRunnableJob.blockEl);
        st.queued = true;
        autoPaused = false;
        autoStepsCount = 0;
        autoQueue.push({ ...latestRunnableJob, forceManual: true });
        processAutoQueue();
        return 1;
      }
    }

    return latestRunnableJob ? 1 : 0;
  }

  // Reset counter langkah otomatis setiap kali user mengirim pesan baru sendiri
  document.addEventListener('keydown', (e) => {
    if (e.isTrusted && e.key === 'Enter' && !e.shiftKey) {
      autoStepsCount = 0;
      resetTurnDedupe();
      updateHud();
    }
  }, true);

  let scanDebounce = null;
  const observer = new MutationObserver(() => {
    if (!isExtensionAlive()) {
      observer.disconnect();
      return;
    }
    lastMutationAt = Date.now();
    if (scanDebounce) clearTimeout(scanDebounce);
    scanDebounce = setTimeout(() => scanCodeBlocks(), 250);
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'CONTENT_PING') {
      sendResponse({ ok: true, instanceId: INSTANCE_ID });
      return true;
    }
    if (msg.type === 'CONTENT_RESET_STEPS') {
      autoStepsCount = 0;
      autoPaused = false;
      resetTurnDedupe();
      updateHud();
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'CONTENT_SCAN_AND_RUN') {
      const count = scanCodeBlocks({ forceRunLatest: true });
      sendResponse({ ok: true, triggered: count });
      return true;
    }
    if (msg.type === 'CONTENT_INSERT_TEXT') {
      if (msg.resetStepCounter) {
        autoStepsCount = 0;
        autoPaused = false;
        resetTurnDedupe();
        updateHud();
      }
      insertTextIntoChat(msg.text || '', Boolean(msg.autoSend))
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    if (msg.type === 'SETTINGS_UPDATED' && msg.settings) {
      settings = { ...settings, ...msg.settings };
      refreshFabStatus();
      updateHud();
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  // Tandai blok kode yang sudah ada di riwayat chat lama sebelum script aktif
  findCodeBlockContainers().forEach((el) => initialCodeBlocks.add(el));

  loadSettings();
  mountFloatingHud();
  scanCodeBlocks();
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  // Backup scanner berkala (1.5 detik) untuk situs dengan Shadow DOM / virtualized list
  const backupInterval = setInterval(() => {
    if (!isExtensionAlive()) {
      clearInterval(backupInterval);
      observer.disconnect();
      return;
    }
    scanCodeBlocks();
  }, 1500);

  const healthInterval = setInterval(() => {
    if (!isExtensionAlive()) {
      clearInterval(healthInterval);
      return;
    }
    refreshFabStatus();
  }, 15000);
})();
