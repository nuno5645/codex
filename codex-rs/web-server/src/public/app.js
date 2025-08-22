// Minimal terminal-like renderer for Codex events
const term = document.getElementById('term');
const promptEl = document.getElementById('prompt');
const runBtn = document.getElementById('run');
const cancelBtn = document.getElementById('cancel');
const compactBtn = document.getElementById('compact');
const fullAutoEl = document.getElementById('full-auto');
const cwdEl = document.getElementById('cwd');
const imagesEl = document.getElementById('images');
const imagesBtn = document.getElementById('images-btn');
const imagesChipsEl = document.getElementById('images-chips');
const attachmentsEl = document.getElementById('attachments');
const showReasoningEl = document.getElementById('show-reasoning');
const modelEl = document.getElementById('model');
const profileEl = document.getElementById('profile');
const overridesEl = document.getElementById('overrides');
const approvalPolicyEl = document.getElementById('approval-policy');
const sandboxModeEl = document.getElementById('sandbox-mode');
const dangerBypassEl = document.getElementById('danger-bypass');
const statusTokens = document.getElementById('status-tokens');
const statusModel = document.getElementById('status-model');
const statusSession = document.getElementById('status-session');
const convListEl = document.getElementById('conv-list');
const refreshConvBtn = document.getElementById('refresh-conv');
const searchConvEl = document.getElementById('search-conv');
// File picker elements
const fileListEl = document.getElementById('file-list');
const fileSearchEl = document.getElementById('file-search');
const refreshFilesBtn = document.getElementById('refresh-files');
const currentPathEl = document.getElementById('current-path');
const upDirBtn = document.getElementById('up-dir');
const setCwdBtn = document.getElementById('set-cwd');
const inputBoxEl = document.querySelector('.input-box');
// Chats modal elements
const chatsModal = document.getElementById('chats-modal');
const openChatsBtn = document.getElementById('open-chats');
const closeChatsBtn = document.getElementById('close-chats');
// Settings modal elements
const settingsModal = document.getElementById('settings-modal');
const openSettingsBtn = document.getElementById('open-settings');
const closeSettingsBtn = document.getElementById('close-settings');

let currentTaskId = null;
let currentConversationId = null;
let es = null;
let activeExecs = 0;
let activePatches = 0;
let pastedImages = [];
let currentObjectUrls = [];
let currentBrowsePath = '';
let parentBrowsePath = null;
let turnBusy = false; // true while agent is responding
let awaitingApproval = false; // true while waiting for user approval

// Heuristic classifier for read-only commands (best-effort UI hinting only)
function isProbablyReadOnlyCommand(cmdArray) {
  try {
    const cmd = (cmdArray || []).join(' ').trim();
    if (!cmd) return true;
    const lower = cmd.toLowerCase();
    // Obvious write/modify indicators
    if (/[>|>>]|\b(tee|chmod|chown|rm|mv|cp|mkdir|rmdir)\b/.test(lower)) return false;
    if (/\b(git\s+(add|commit|push|reset|merge|rebase|clean|stash|apply|am|checkout\s+-b))\b/.test(lower)) return false;
    // Read-oriented common commands
    const readHeads = [
      'cat', 'sed', 'head', 'tail', 'rg', 'grep', 'egrep', 'fgrep', 'ls', 'find', 'nl', 'awk', 'cut', 'wc', 'stat', 'file',
      'git show', 'git diff', 'git log', 'git status', 'git ls-files', 'git rev-parse', 'git branch', 'git remote -v'
    ];
    for (const h of readHeads) {
      if (lower.startsWith(h)) return true;
    }
    // Default to read-only unless clearly writing (UI hint only)
    return true;
  } catch {
    return true;
  }
}

// Extract likely file targets from a command line for display
function extractReadableTargets(cmdArray) {
  try {
    const joined = (cmdArray || []).join(' ');
    const s = joined.replace(/["'`]/g, ' ');
    const candidates = [];
    const regex = /\s((?:\.{0,2}\/)?[\w@%+~#=,:.-]+\/[\w@%+~#=,:./-]+|[\w@%+~#=,:.-]+\.(?:rs|ts|tsx|js|jsx|json|toml|md|txt|yaml|yml|sh|py|go|rb|java|kt|c|h|cpp|hpp|css|html|lock|nix))\b/g;
    let m;
    while ((m = regex.exec(s)) !== null) {
      const p = (m[1] || '').trim();
      if (!p) continue;
      if (p.startsWith('-')) continue; // flags
      if (/^\d+(,\d+)?p$/.test(p)) continue; // sed ranges
      if (/^\d+$/.test(p)) continue;
      candidates.push(p);
    }
    // dedupe while preserving order
    const seen = new Set();
    const out = [];
    for (const c of candidates) { if (!seen.has(c)) { seen.add(c); out.push(c); } }
    return out;
  } catch {
    return [];
  }
}

function prettyReadLabel(cmdArray) {
  const files = extractReadableTargets(cmdArray);
  if (files.length === 0) return 'read';
  const max = 3;
  const shown = files.slice(0, max).join(', ');
  const more = files.length > max ? ` +${files.length - max} more` : '';
  return `read: ${shown}${more}`;
}

function setInteractionLocked(locked) {
  // Disable/enable user inputs while it's not the user's turn
  try { promptEl.disabled = locked; } catch {}
  try { runBtn.disabled = locked; } catch {}
  try { imagesBtn.disabled = locked; } catch {}
  try { imagesEl.disabled = locked; } catch {}
}

function updateTurnPill() {
  const pill = document.getElementById('status-turn');
  if (!pill) return;
  // Reset variant classes, then apply based on state
  try { pill.classList.remove('pill--ready', 'pill--busy', 'pill--approval'); } catch {}
  if (awaitingApproval) {
    try { pill.classList.add('pill--approval'); } catch {}
    pill.innerHTML = '';
    const spin = document.createElement('span');
    spin.className = 'spinner';
    const txt = document.createElement('span');
    txt.textContent = 'turn: awaiting approval…';
    pill.appendChild(spin);
    pill.appendChild(txt);
  } else if (turnBusy) {
    try { pill.classList.add('pill--busy'); } catch {}
    pill.innerHTML = '';
    const spin = document.createElement('span');
    spin.className = 'spinner';
    const txt = document.createElement('span');
    txt.textContent = 'turn: agent working…';
    pill.appendChild(spin);
    pill.appendChild(txt);
  } else {
    try { pill.classList.add('pill--ready'); } catch {}
    pill.textContent = 'turn: ready';
  }
}

function line(text, cls = '') {
  const div = document.createElement('div');
  div.className = 'line ' + cls;
  div.textContent = text;
  term.appendChild(div);
  term.scrollTop = term.scrollHeight;
  return div;
}

function richLine(parts, cls = '') {
  const div = document.createElement('div');
  div.className = 'line ' + cls;
  for (const p of parts) {
    if (typeof p === 'string') {
      div.append(document.createTextNode(p));
    } else if (p && p.tag) {
      const span = document.createElement('span');
      span.className = p.tag;
      span.textContent = p.text;
      div.appendChild(span);
    }
  }
  term.appendChild(div);
  term.scrollTop = term.scrollHeight;
  return div;
}

function formatDuration(ms) {
  const s = ms / 1000;
  if (s < 1) return ms.toFixed(0) + 'ms';
  if (s < 60) return s.toFixed(2) + 's';
  const m = Math.floor(s / 60);
  return m + 'm ' + (s % 60).toFixed(1) + 's';
}

function base64ToUtf8(b64) {
  try {
    const bin = atob(b64);
    // Convert binary string to UTF-8
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    const dec = new TextDecoder('utf-8', { fatal: false });
    return dec.decode(bytes);
  } catch (e) {
    return '[binary]';
  }
}

// Decode chunks that may arrive either as base64 strings (future) or
// as arrays of byte values (current backend via serde_bytes JSON).
function decodeChunk(chunk) {
  try {
    if (typeof chunk === 'string') {
      return base64ToUtf8(chunk);
    }
    if (Array.isArray(chunk)) {
      const bytes = new Uint8Array(chunk);
      const dec = new TextDecoder('utf-8', { fatal: false });
      return dec.decode(bytes);
    }
  } catch (_) {}
  return '[binary]';
}

function revokeObjectUrls() {
  try { for (const u of currentObjectUrls) URL.revokeObjectURL(u); } catch {}
  currentObjectUrls = [];
}

function truncateName(name, max = 28) {
  if (!name) return '';
  if (name.length <= max) return name;
  const head = Math.ceil(max * 0.65);
  const tail = max - head - 1;
  return name.slice(0, head) + '…' + name.slice(-tail);
}

function renderImageChips() {
  if (!imagesChipsEl) return;
  imagesChipsEl.innerHTML = '';
  const files = Array.from(imagesEl?.files || []);
  files.forEach((file, idx) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.title = file.name;
    chip.textContent = truncateName(file.name);
    const x = document.createElement('button');
    x.className = 'xbtn';
    x.type = 'button';
    x.setAttribute('aria-label', `Remove ${file.name}`);
    x.textContent = '×';
    x.addEventListener('click', () => {
      try {
        const dt = new DataTransfer();
        Array.from(imagesEl.files).forEach((f, i) => { if (i !== idx) dt.items.add(f); });
        imagesEl.files = dt.files;
        imagesEl.dispatchEvent(new Event('change'));
      } catch {}
    });
    chip.appendChild(x);
    imagesChipsEl.appendChild(chip);
  });
}

function renderAttachments() {
  if (!attachmentsEl) return;
  revokeObjectUrls();
  attachmentsEl.innerHTML = '';
  const files = Array.from(imagesEl?.files || []);
  const hasPicked = files.length > 0;
  const hasPasted = pastedImages && pastedImages.length > 0;
  if (!hasPicked && !hasPasted) {
    attachmentsEl.hidden = true;
    return;
  }
  attachmentsEl.hidden = false;
  // Pasted images
  pastedImages.forEach((url, index) => {
    const wrap = document.createElement('div');
    wrap.className = 'attachment';
    const img = document.createElement('img');
    img.src = url;
    img.alt = 'pasted image';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = 'Remove image';
    btn.textContent = '×';
    btn.addEventListener('click', () => {
      pastedImages.splice(index, 1);
      renderAttachments();
    });
    wrap.appendChild(img);
    wrap.appendChild(btn);
    attachmentsEl.appendChild(wrap);
  });
  // Selected images
  files.forEach((file, idx) => {
    const url = URL.createObjectURL(file);
    currentObjectUrls.push(url);
    const wrap = document.createElement('div');
    wrap.className = 'attachment';
    const img = document.createElement('img');
    img.src = url;
    img.alt = file.name || 'selected image';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = 'Remove image';
    btn.textContent = '×';
    btn.addEventListener('click', () => {
      try {
        const dt = new DataTransfer();
        Array.from(imagesEl.files).forEach((f, i) => { if (i !== idx) dt.items.add(f); });
        imagesEl.files = dt.files;
        imagesEl.dispatchEvent(new Event('change'));
      } catch {}
    });
    wrap.appendChild(img);
    wrap.appendChild(btn);
    attachmentsEl.appendChild(wrap);
  });
}

// Very small Markdown renderer for a handful of constructs we use:
// - triple-backtick code blocks -> <pre><code>
// - inline `code` -> <span class="mono">
// - preserve simple newlines
function renderMarkdownToNodes(md) {
  const frag = document.createDocumentFragment();
  if (!md) return frag;

  // Split by code fences first
  const fenceRegex = /```([\s\S]*?)```/g;
  let lastIndex = 0;
  let m;
  while ((m = fenceRegex.exec(md)) !== null) {
    const before = md.slice(lastIndex, m.index);
    if (before) {
      // render inline code in the 'before' chunk
      appendInlineMarkdown(frag, before);
    }
    const code = m[1].replace(/^\n+|\n+$/g, '');
    const pre = document.createElement('pre');
    const codeEl = document.createElement('code');
    codeEl.textContent = code;
    pre.appendChild(codeEl);
    frag.appendChild(pre);
    lastIndex = fenceRegex.lastIndex;
  }
  const rest = md.slice(lastIndex);
  if (rest) appendInlineMarkdown(frag, rest);
  return frag;

  function appendInlineMarkdown(container, text) {
    // Replace inline `code` occurrences with span.mono and **bold** with <strong>
    // Split on inline code first to avoid interfering with backticks
    const parts = text.split(/(`[^`]*`)/g);
    for (const p of parts) {
      if (!p) continue;
      if (p.startsWith('`') && p.endsWith('`')) {
        const span = document.createElement('span');
        span.className = 'mono';
        span.textContent = p.slice(1, -1);
        container.appendChild(span);
      } else {
        // support **bold** and preserve newlines
        const boldSplit = p.split(/(\*\*[^*]*\*\*)/g);
        for (const bp of boldSplit) {
          if (!bp) continue;
          if (bp.startsWith('**') && bp.endsWith('**')) {
            const strong = document.createElement('strong');
            strong.textContent = bp.slice(2, -2);
            container.appendChild(strong);
          } else {
            const lines = bp.split(/\n/);
            for (let i = 0; i < lines.length; i++) {
              if (i > 0) container.appendChild(document.createTextNode('\n'));
              container.appendChild(document.createTextNode(lines[i]));
            }
          }
        }
      }
    }
  }
}

// Accept either (containerElement, text) for legacy or (blockObj, text)
function appendReasoningContent(target, text) {
  if (!text) return;
  let contentEl = null;
  let headerEl = null;
  if (target && target.contentEl) {
    // blockObj
    contentEl = target.contentEl;
    headerEl = target.headerEl;
  } else {
    contentEl = target;
  }

  // If first chunk contains a leading **Title**, extract it into header
  const leadingTitle = text.match(/^\s*\*\*([^*]+)\*\*/);
  if (leadingTitle && headerEl) {
    headerEl.textContent = `reasoning — ${leadingTitle[1].trim()}`;
    // strip the leading bold from text
    text = text.replace(leadingTitle[0], '').trimStart();
  }

  // preserve paragraph spacing
  const parts = text.split(/\n\n+/g);
  for (let i = 0; i < parts.length; i++) {
    const nodes = renderMarkdownToNodes(parts[i]);
    contentEl.appendChild(nodes);
    if (i < parts.length - 1) contentEl.appendChild(document.createElement('br'));
  }
}

function resetStream() {
  if (es) { es.close(); es = null; }
  currentTaskId = null;
  cancelBtn.disabled = true;
  compactBtn.disabled = true;
  // reset UI execution status
  activeExecs = 0;
  turnBusy = false;
  awaitingApproval = false;
  updateTurnPill();
  setInteractionLocked(false);
  updateExecStatus();
}

// --- File picker logic ---
function isProbablyImageName(name) {
  if (!name) return false;
  const n = String(name).toLowerCase();
  return /(\.png|\.jpg|\.jpeg|\.gif|\.webp|\.bmp|\.tif|\.tiff|\.heic|\.heif)$/i.test(n);
}
function renderFileList(items) {
  if (!fileListEl) return;
  fileListEl.innerHTML = '';
  (items || []).forEach((it) => {
    const row = document.createElement('div');
    row.className = 'file-item';
    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = it.is_dir ? '📁' : '📄';
    const name = document.createElement('div');
    name.className = 'name';
    const fileNameStr = it.name || it.rel_path || '(unnamed)';
    name.textContent = fileNameStr;
    const meta = document.createElement('div');
    meta.className = 'meta';
    if (!it.is_dir && typeof it.size === 'number') {
      const kb = Math.max(1, Math.round(it.size / 1024));
      meta.textContent = `${kb} KB`;
    } else {
      meta.textContent = it.is_dir ? 'dir' : '';
    }
    row.appendChild(icon);
    row.appendChild(name);
    row.appendChild(meta);

    // Compute the full path once for click + drag
    const fullPath = it.path || it.abs_path || '';

    // Make items draggable – but disable dragging for image files
    const isImageItem = !it.is_dir && isProbablyImageName(fileNameStr);
    if (!isImageItem) {
      row.setAttribute('draggable', 'true');
      row.title = 'Drag to input to insert path';
      row.addEventListener('dragstart', (e) => {
        try {
          row.classList.add('dragging');
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'copy';
            // Custom type for internal drops plus a plain-text fallback
            e.dataTransfer.setData('application/x-codex-path', fullPath);
            e.dataTransfer.setData('text/plain', fullPath);
          }
        } catch {}
      });
      row.addEventListener('dragend', () => { row.classList.remove('dragging'); });
    } else {
      row.title = 'Click to insert path (drag disabled for images)';
    }

    row.addEventListener('click', () => {
      if (it.is_dir) {
        browse(fullPath);
      } else if (fullPath) {
        line('selected file: ' + fullPath, 'dim');
        const sep = promptEl.value && !/\s$/.test(promptEl.value) ? ' ' : '';
        promptEl.value = (promptEl.value || '') + sep + fullPath;
        promptEl.focus();
      }
    });
    fileListEl.appendChild(row);
  });
}

async function browse(path) {
  try {
    const u = path ? `/api/browse?path=${encodeURIComponent(path)}` : '/api/browse';
    const res = await fetch(u);
    if (!res.ok) return;
    const data = await res.json();
    currentBrowsePath = data.current_path || path || '';
    parentBrowsePath = data.parent_path || null;
    if (currentPathEl) currentPathEl.value = currentBrowsePath;
    renderFileList(data.items || []);
  } catch {}
}

async function searchFilesInPath(query) {
  if (!query) { await browse(currentBrowsePath); return; }
  try {
    const params = new URLSearchParams();
    if (currentBrowsePath) params.set('cwd', currentBrowsePath);
    params.set('q', query);
    const res = await fetch(`/api/search_files?${params.toString()}`);
    if (!res.ok) return;
    const data = await res.json();
    // Map search results to file list shape
    const items = (data.items || []).map(it => ({
      name: it.name || it.rel_path,
      path: it.abs_path,
      is_dir: it.is_dir,
      size: it.size,
    }));
    renderFileList(items);
  } catch {}
}

async function start(prompt) {
  // Show loading immediately for responsiveness
  try { runBtn.classList.add('loading'); } catch {}
  resetStream();
  turnBusy = true;
  awaitingApproval = false;
  updateTurnPill();
  setInteractionLocked(true);
  updateExecStatus();
  const pickedImages = await Promise.all(Array.from(imagesEl.files || []).map(file => new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = () => res(reader.result);
    reader.onerror = rej;
    reader.readAsDataURL(file);
  })));
  const images = [...(pastedImages || []), ...pickedImages];

  const body = {
    prompt: prompt || '',
    full_auto: !!fullAutoEl.checked,
    cwd: cwdEl.value.trim() || undefined,
    images: images.length ? images : undefined,
    conversation_id: currentConversationId || undefined,
    model: (modelEl && modelEl.value.trim()) ? modelEl.value.trim() : undefined,
    config_profile: (profileEl && profileEl.value.trim()) ? profileEl.value.trim() : undefined,
  };

  // Parse overrides from input string into ["key=value", ...]
  if (overridesEl && overridesEl.value.trim()) {
    const raw = overridesEl.value.trim();
    // Split on commas or newlines
    const parts = raw
      .split(/[\n,]/g)
      .map(s => s.trim())
      .filter(s => s.length > 0 && s.includes('='));
    if (parts.length > 0) {
      body.overrides = parts;
    }
  };

  const ap = approvalPolicyEl && approvalPolicyEl.value.trim();
  if (ap) body.approval_policy = ap;
  const sm = sandboxModeEl && sandboxModeEl.value.trim();
  if (sm) body.sandbox_mode = sm;
  if (dangerBypassEl && dangerBypassEl.checked) body.dangerously_bypass = true;

  richLine([{tag:'tag', text:'user     '}, {text: prompt || '(images only)'}], 'user');

  const res = await fetch('/api/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    line('! start failed: ' + t, 'error');
    try { runBtn.classList.remove('loading'); } catch {}
    turnBusy = false;
    awaitingApproval = false;
    updateTurnPill();
    setInteractionLocked(false);
    updateExecStatus();
    return;
  }
  const { task_id, conversation_id } = await res.json();
  currentTaskId = task_id;
  currentConversationId = conversation_id;
  cancelBtn.disabled = false;
  compactBtn.disabled = false;
  // show loading on Run while there are active execs
  updateExecStatus();
  hydrateConversationsList();
  stream(task_id);
  // Clear attachments after successful start
  pastedImages = [];
  renderAttachments();
  if (imagesEl) imagesEl.value = '';
  renderImageChips();
  // Keep model/profile/overrides as-is for next run
}

async function sendApproval(kind, eventId, decision) {
  if (!currentTaskId) return;
  const endpoint = kind === 'exec' ? '/api/approve/exec' : '/api/approve/patch';
  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: currentTaskId, event_id: eventId, decision })
    });
  } catch {}
}

function updateExecStatus() {
  const pill = document.getElementById('status-exec');
  if (!pill) return;
  if (activeExecs > 0) {
    pill.textContent = `exec: running (${activeExecs})`;
  } else {
    pill.textContent = 'exec: idle';
  }
  // Show loading on Run while either a command runs or it's not user's turn
  if (activeExecs > 0 || turnBusy || awaitingApproval) runBtn.classList.add('loading');
  else runBtn.classList.remove('loading');
}

function updatePatchStatus() {
  const pill = document.getElementById('status-patch');
  if (!pill) return;
  if (activePatches > 0) {
    pill.textContent = `patch: applying (${activePatches})`;
  } else {
    pill.textContent = 'patch: idle';
  }
}

function stream(taskId) {
  if (es) { es.close(); es = null; }
  es = new EventSource(`/api/events/${encodeURIComponent(taskId)}`);
  const agentMsgLines = new Map(); // event id -> div for deltas
  // For proper streaming formatting: keep a per-id buffer and content element
  const agentMsgBufferById = new Map(); // id -> full accumulated text
  const agentMsgContentElById = new Map(); // id -> content element inside the line
  // Track last rendered texts to collapse obvious duplicates
  let lastAgentFinal = '';
  const lastAgentDeltaById = new Map(); // id -> last delta text
  let lastBackground = '';
  const cmdOutputLines = new Map(); // call_id -> output pre element
  const execOutStats = new Map(); // call_id -> {lines, bytes, summaryEl}
  const reasoningLines = new Map(); // event id -> div for reasoning content (legacy)
  const reasoningBlocks = new Map(); // event id -> {block, headerEl, contentEl}
  const cmdMap = new Map(); // call_id -> command (string)
  const execStatusMap = new Map(); // call_id -> {statusEl, blockEl}
  // Track diffs we've already rendered within a turn to avoid duplicates
  const shownDiffs = new Set();
  line('… streaming events', 'dim');

  es.onmessage = (ev) => {
    try {
      const event = JSON.parse(ev.data);
      const id = event.id || '';
      const msg = event.msg || {};
      const ty = msg.type;
      switch (ty) {
        case 'task_started': {
          richLine([{tag:'tag', text:'status   '}, {text: 'task started'}], 'dim');
          turnBusy = true;
          updateTurnPill();
          setInteractionLocked(true);
          updateExecStatus();
          break;
        }
        case 'exec_approval_request': {
          awaitingApproval = true;
          updateTurnPill();
          setInteractionLocked(true);
          updateExecStatus();
          line('You need to approve…', 'dim');
          const title = `Approve command?`;
          const block = document.createElement('div');
          block.className = 'approval-block';
          const h = document.createElement('div'); h.className = 'approval-title'; h.textContent = title; block.appendChild(h);
          const cmd = document.createElement('div');
          cmd.className = 'exec-cmd';
          if (isProbablyReadOnlyCommand(msg.command)) {
            cmd.textContent = prettyReadLabel(msg.command);
          } else {
            cmd.textContent = `$ ${ (msg.command||[]).join(' ') }`;
          }
          block.appendChild(cmd);
          const cwd = document.createElement('div'); cwd.className = 'exec-cwd'; cwd.textContent = `cwd: ${msg.cwd || ''}`; block.appendChild(cwd);
          // Read-only hint
          if (isProbablyReadOnlyCommand(msg.command)) {
            const hint = document.createElement('div');
            hint.className = 'dim';
            hint.textContent = '(looks read-only)';
            block.appendChild(hint);
          }
          const actions = document.createElement('div'); actions.className = 'approval-actions';
          const bApprove = document.createElement('button'); bApprove.className='btn approve'; bApprove.textContent='Approve'; bApprove.onclick=()=>sendApproval('exec', id, 'approved');
          const bApproveSess = document.createElement('button'); bApproveSess.className='btn approve'; bApproveSess.textContent='Approve (session)'; bApproveSess.onclick=()=>sendApproval('exec', id, 'approved_for_session');
          const bDeny = document.createElement('button'); bDeny.className='btn deny'; bDeny.textContent='Deny'; bDeny.onclick=()=>sendApproval('exec', id, 'denied');
          const bAbort = document.createElement('button'); bAbort.className='btn secondary'; bAbort.textContent='Abort turn'; bAbort.onclick=()=>sendApproval('exec', id, 'abort');
          actions.appendChild(bApprove); actions.appendChild(bApproveSess); actions.appendChild(bDeny); actions.appendChild(bAbort);
          block.appendChild(actions);
          term.appendChild(block); term.scrollTop = term.scrollHeight;
          break;
        }
        case 'apply_patch_approval_request': {
          awaitingApproval = true;
          updateTurnPill();
          setInteractionLocked(true);
          updateExecStatus();
          line('You need to approve…', 'dim');
          const title = `Approve patch?`;
          const block = document.createElement('div');
          block.className = 'approval-block';
          const h = document.createElement('div'); h.className = 'approval-title'; h.textContent = title; block.appendChild(h);
          const reason = document.createElement('div'); reason.className='dim'; reason.textContent = msg.reason ? `reason: ${msg.reason}` : ''; block.appendChild(reason);
          const actions = document.createElement('div'); actions.className = 'approval-actions';
          const bApprove = document.createElement('button'); bApprove.className='btn approve'; bApprove.textContent='Approve'; bApprove.onclick=()=>sendApproval('patch', id, 'approved');
          const bApproveSess = document.createElement('button'); bApproveSess.className='btn approve'; bApproveSess.textContent='Approve (session)'; bApproveSess.onclick=()=>sendApproval('patch', id, 'approved_for_session');
          const bDeny = document.createElement('button'); bDeny.className='btn deny'; bDeny.textContent='Deny'; bDeny.onclick=()=>sendApproval('patch', id, 'denied');
          const bAbort = document.createElement('button'); bAbort.className='btn secondary'; bAbort.textContent='Abort turn'; bAbort.onclick=()=>sendApproval('patch', id, 'abort');
          actions.appendChild(bApprove); actions.appendChild(bApproveSess); actions.appendChild(bDeny); actions.appendChild(bAbort);
          block.appendChild(actions);
          term.appendChild(block); term.scrollTop = term.scrollHeight;
          break;
        }
        case 'session_configured': {
          const sid = (msg.session_id || '').toString().slice(0, 8);
          statusModel.textContent = 'model: ' + (msg.model || '?');
          statusSession.textContent = 'session: ' + (sid || '–');
          richLine([{tag:'tag', text:'session  '}, {text: `configured (model=${msg.model || '?'})` }], 'dim');
          break;
        }
        case 'agent_message': {
          const text = (msg.message || '').trim();
          // Reuse existing line if we streamed deltas; otherwise create a new one
          let lineEl = agentMsgLines.get(id);
          let contentEl = agentMsgContentElById.get(id);
          if (!lineEl || !contentEl) {
            lineEl = richLine([{tag:'tag', text:'agent    '}], 'agent');
            contentEl = document.createElement('div');
            contentEl.className = 'agent-content';
            lineEl.appendChild(contentEl);
            agentMsgLines.set(id, lineEl);
            agentMsgContentElById.set(id, contentEl);
          }
          agentMsgBufferById.set(id, text);
          // Re-render full content for correct formatting
          try { contentEl.textContent = ''; } catch {}
          contentEl.appendChild(renderMarkdownToNodes(text));
          term.scrollTop = term.scrollHeight;
          break;
        }
        case 'agent_message_delta': {
          // Ensure we have a dedicated content container for this message id
          let lineEl = agentMsgLines.get(id);
          let contentEl = agentMsgContentElById.get(id);
          if (!lineEl || !contentEl) {
            lineEl = richLine([{tag:'tag', text:'agent    '}], 'agent');
            contentEl = document.createElement('div');
            contentEl.className = 'agent-content';
            lineEl.appendChild(contentEl);
            agentMsgLines.set(id, lineEl);
            agentMsgContentElById.set(id, contentEl);
          }
          const delta = (msg.delta || '').trim();
          const last = lastAgentDeltaById.get(id) || '';
          if (delta && delta === last) break; // drop duplicate delta for this id
          lastAgentDeltaById.set(id, delta);
          // Append to buffer and re-render to keep formatting consistent while streaming
          const prev = agentMsgBufferById.get(id) || '';
          const next = prev + delta;
          agentMsgBufferById.set(id, next);
          try { contentEl.textContent = ''; } catch {}
          contentEl.appendChild(renderMarkdownToNodes(next));
          term.scrollTop = term.scrollHeight;
          break;
        }
        case 'agent_reasoning_section_break': {
          // create a structured reasoning block (header + body)
          const block = document.createElement('div');
          block.className = 'reasoning-block';
          const headerEl = document.createElement('div');
          headerEl.className = 'reasoning-header';
          headerEl.textContent = 'reasoning';
          const contentEl = document.createElement('div');
          contentEl.className = 'reasoning-body';
          block.appendChild(headerEl);
          block.appendChild(contentEl);
          term.appendChild(block);
          term.scrollTop = term.scrollHeight;
          reasoningBlocks.set(id, { block, headerEl, contentEl });
          break;
        }
        case 'agent_reasoning': {
          // prefer structured block if created by section_break
          const b = reasoningBlocks.get(id);
          if (b) {
            appendReasoningContent(b, msg.text || '');
          } else {
            // fallback to inline lines
            let div = reasoningLines.get(id);
            if (!div) {
              div = richLine([{tag:'tag', text:'reasoning'}], 'dim reasoning');
              reasoningLines.set(id, div);
            }
            div.appendChild(renderMarkdownToNodes(msg.text || ''));
          }
          term.scrollTop = term.scrollHeight;
          break;
        }
        case 'agent_reasoning_delta': {
          const b = reasoningBlocks.get(id);
          if (b) {
            appendReasoningContent(b, msg.delta || '');
          } else {
            let div = reasoningLines.get(id);
            if (!div) {
              div = richLine([{tag:'tag', text:'reasoning'}], 'dim reasoning');
              reasoningLines.set(id, div);
            }
            div.appendChild(renderMarkdownToNodes(msg.delta || ''));
          }
          term.scrollTop = term.scrollHeight;
          break;
        }
        case 'agent_reasoning_raw_content': {
          const b = reasoningBlocks.get(id);
          if (b) {
            appendReasoningContent(b, msg.text || '');
          } else {
            let div = reasoningLines.get(id);
            if (!div) {
              div = richLine([{tag:'tag', text:'reasoning'}], 'dim reasoning');
              reasoningLines.set(id, div);
            }
            div.appendChild(renderMarkdownToNodes(msg.text || ''));
          }
          term.scrollTop = term.scrollHeight;
          break;
        }
        case 'agent_reasoning_raw_content_delta': {
          const b = reasoningBlocks.get(id);
          if (b) {
            appendReasoningContent(b, msg.delta || '');
          } else {
            let div = reasoningLines.get(id);
            if (!div) {
              div = richLine([{tag:'tag', text:'reasoning'}], 'dim reasoning');
              reasoningLines.set(id, div);
            }
            div.appendChild(renderMarkdownToNodes(msg.delta || ''));
          }
          term.scrollTop = term.scrollHeight;
          break;
        }
        case 'exec_command_begin': {
          awaitingApproval = false;
          updateTurnPill();
          setInteractionLocked(true);
          updateExecStatus();
          const cwd = msg.cwd ? String(msg.cwd) : '';
          const cmd = (msg.command || []).join(' ');
          const block = document.createElement('div');
          block.className = 'exec-block';
          const header = document.createElement('div');
          header.className = 'exec-header';
          const tagSpan = document.createElement('span');
          tagSpan.className = 'tag';
          tagSpan.textContent = isProbablyReadOnlyCommand(msg.command) ? 'read     ' : 'exec     ';
          const cmdSpan = document.createElement('span');
          cmdSpan.className = 'exec-cmd';
          if (isProbablyReadOnlyCommand(msg.command)) {
            cmdSpan.textContent = prettyReadLabel(msg.command);
          } else {
            cmdSpan.textContent = `$ ${cmd}`;
          }
          const statusEl = document.createElement('span');
          statusEl.className = 'exec-status running';
          const spin = document.createElement('span');
          spin.className = 'spinner';
          statusEl.appendChild(spin);
          const stTxt = document.createElement('span');
          stTxt.textContent = 'running…';
          statusEl.appendChild(stTxt);
          // Read-only badge
          if (isProbablyReadOnlyCommand(msg.command)) {
            const ro = document.createElement('span');
            ro.className = 'badge read';
            ro.title = 'Heuristic: read-only command';
            ro.textContent = 'read';
            statusEl.appendChild(ro);
          }
          header.appendChild(tagSpan);
          header.appendChild(cmdSpan);
          header.appendChild(statusEl);
          block.appendChild(header);
          if (cwd) {
            const cwdEl = document.createElement('div');
            cwdEl.className = 'exec-cwd';
            cwdEl.textContent = `cwd: ${cwd}`;
            block.appendChild(cwdEl);
          }
          // Collapsed output container (details)
          const outWrap = document.createElement('details');
          outWrap.className = 'exec-output-wrap';
          outWrap.open = false; // collapsed by default
          const outSum = document.createElement('summary');
          outSum.className = 'exec-output-summary';
          outSum.textContent = 'output';
          const outPre = document.createElement('div');
          outPre.className = 'exec-output';
          outWrap.appendChild(outSum);
          outWrap.appendChild(outPre);
          block.appendChild(outWrap);
          term.appendChild(block);
          term.scrollTop = term.scrollHeight;
          if (msg.call_id) {
            cmdMap.set(msg.call_id, cmd);
            cmdOutputLines.set(msg.call_id, outPre);
            execStatusMap.set(msg.call_id, { statusEl, blockEl: block });
            execOutStats.set(msg.call_id, { lines: 0, bytes: 0, summaryEl: outSum });
          }
          activeExecs += 1;
          updateExecStatus();
          break;
        }
        case 'exec_command_output_delta': {
          const cid = msg.call_id;
          let outPre = cmdOutputLines.get(cid);
          if (!outPre) {
            outPre = document.createElement('div');
            outPre.className = 'exec-output';
            term.appendChild(outPre);
            cmdOutputLines.set(cid, outPre);
          }
          let text = decodeChunk(msg.chunk);
          if (text === '[binary]') {
            const cmdShown = cmdMap.get(cid);
            if (cmdShown) text = `$ ${cmdShown}`;
          }
          const span = document.createElement('span');
          if (msg.stream === 'stderr') span.className = 'stderr';
          span.textContent = text;
          outPre.appendChild(span);
          // Update summary counts
          const stats = execOutStats.get(cid);
          if (stats && stats.summaryEl) {
            const addedLines = (text.match(/\n/g) || []).length + (text && !text.endsWith('\n') ? 1 : 0);
            stats.lines += addedLines;
            stats.bytes += (typeof text === 'string' ? text.length : 0);
            stats.summaryEl.textContent = `output (${stats.lines} lines, ${stats.bytes} bytes)`;
          }
          term.scrollTop = term.scrollHeight;
          break;
        }
        case 'exec_command_end': {
          let ms = 0;
          if (typeof msg.duration === 'number') {
            ms = msg.duration;
          } else if (msg.duration) {
            const secs = Number(msg.duration.secs || 0);
            const nanos = Number(msg.duration.nanos || 0);
            ms = secs * 1000 + Math.round(nanos / 1e6);
          }
          const d = formatDuration(ms);
          const info = execStatusMap.get(msg.call_id);
          if (info) {
            info.statusEl.innerHTML = '';
            info.statusEl.classList.remove('running');
            info.statusEl.classList.add('done', msg.exit_code === 0 ? 'ok' : 'fail');
            const txt = document.createElement('span');
            txt.textContent = `exit ${msg.exit_code} (${d})`;
            info.statusEl.appendChild(txt);
          } else {
            // fallback
            richLine([{tag:'tag', text:'exec end '}, {text: `exit ${msg.exit_code} (${d})`}], 'dim');
          }
          if (msg.call_id && cmdMap.has(msg.call_id)) cmdMap.delete(msg.call_id);
          activeExecs = Math.max(0, activeExecs - 1);
          updateExecStatus();
          break;
        }
        case 'plan_update': {
          const plan = msg.plan || [];
          line('plan update:', 'dim');
          for (const it of plan) {
            line(`  - [${(it.status || '').toString().toLowerCase()}] ${it.step || ''}`, 'dim');
          }
          break;
        }
        
        case 'patch_apply_begin': {
          awaitingApproval = false;
          updateTurnPill();
          setInteractionLocked(true);
          updateExecStatus();
          line('applying patch…', 'dim');
          activePatches += 1;
          updatePatchStatus();
          break;
        }
        case 'patch_apply_end': {
          const ok = !!msg.success;
          line(`patch apply ${ok ? 'ok' : 'failed'}`, ok ? 'dim' : 'error');
          activePatches = Math.max(0, activePatches - 1);
          updatePatchStatus();
          break;
        }
        case 'background_event': {
          const txt = (msg.message || '').trim();
          if (txt && txt === lastBackground) break;
          lastBackground = txt;
          line(txt, 'dim');
          break;
        }
        case 'turn_diff': {
          const diff = msg.unified_diff || '';
          if (!diff) { line('diff: (empty)', 'dim'); break; }
          // De-duplicate identical diffs within the same turn
          if (shownDiffs.has(diff)) {
            break;
          }
          shownDiffs.add(diff);

          // Split into files using 'diff --git a/... b/...'
          const files = [];
          let current = null;
          const lines = diff.split(/\r?\n/);
          for (let raw of lines) {
            if (!raw) continue;
            if (raw.startsWith('diff --git ')) {
              if (current) files.push(current);
              current = { header: raw, hunks: [], add: 0, del: 0 };
            } else if (current) {
              // count +/-
              if (raw.startsWith('+') && !raw.startsWith('+++')) current.add++;
              if (raw.startsWith('-') && !raw.startsWith('---')) current.del++;
              current.hunks.push(raw);
            }
          }
          if (current) files.push(current);

          const wrapper = document.createElement('div');
          wrapper.className = 'diff-files';

          for (const f of files) {
            const det = document.createElement('details');
            det.className = 'diff-file';
            det.open = false;

            const sum = document.createElement('summary');
            sum.className = 'diff-summary';
            const title = document.createElement('span');
            title.className = 'diff-title';
            title.textContent = f.header.replace('diff --git ', '');
            const actions = document.createElement('span');
            actions.className = 'diff-actions';
            const addBadge = document.createElement('span'); addBadge.className = 'badge add'; addBadge.textContent = `+${f.add}`;
            const delBadge = document.createElement('span'); delBadge.className = 'badge del'; delBadge.textContent = `-${f.del}`;
            const copyBtn = document.createElement('button'); copyBtn.className = 'btn-mini'; copyBtn.textContent = 'Copy diff';
            copyBtn.addEventListener('click', (e) => {
              e.preventDefault(); e.stopPropagation();
              const text = [f.header, ...f.hunks].join('\n');
              navigator.clipboard && navigator.clipboard.writeText(text).then(() => {
                copyBtn.textContent = 'Copied';
                setTimeout(() => copyBtn.textContent = 'Copy diff', 1200);
              }).catch(() => {});
            });
            actions.appendChild(addBadge); actions.appendChild(delBadge); actions.appendChild(copyBtn);
            sum.appendChild(title); sum.appendChild(actions);

            const block = document.createElement('div');
            block.className = 'diff-block';
            for (const raw of f.hunks) {
              const div = document.createElement('div');
              let cls = 'diff-line ';
              if (raw.startsWith('+++ ') || raw.startsWith('--- ')) cls += 'file';
              else if (raw.startsWith('@@')) cls += 'hunk';
              else if (raw.startsWith('+')) cls += 'add';
              else if (raw.startsWith('-')) cls += 'del';
              else cls += 'meta';
              div.className = cls;
              div.textContent = raw;
              block.appendChild(div);
            }

            det.appendChild(sum);
            det.appendChild(block);
            wrapper.appendChild(det);
          }

          term.appendChild(wrapper);
          term.scrollTop = term.scrollHeight;
          break;
        }
        case 'token_count': {
          const total = msg.total_tokens ?? 0;
          const input = (msg.input_tokens ?? 0) - (msg.cached_input_tokens ?? 0);
          const cached = msg.cached_input_tokens ?? 0;
          const output = msg.output_tokens ?? 0;
          statusTokens.textContent = `tokens: total=${input+output} input=${input}${cached>0?`(+${cached} cached)`:''} output=${output}`;
          break;
        }
        case 'error': {
          line('! ' + (msg.message || 'Error'), 'error');
          break;
        }
        case 'task_complete': {
          richLine([{tag:'tag', text:'status   '}, {text: 'task complete'}], 'dim');
          currentTaskId = null;
          cancelBtn.disabled = true;
          compactBtn.disabled = true;
          // ensure status cleared when task completes
          activeExecs = 0;
          turnBusy = false;
          awaitingApproval = false;
          updateTurnPill();
          setInteractionLocked(false);
          updateExecStatus();
          break;
        }
        case 'turn_aborted': {
          line('turn aborted', 'error');
          currentTaskId = null;
          cancelBtn.disabled = true;
          compactBtn.disabled = true;
          awaitingApproval = false;
          turnBusy = false;
          updateTurnPill();
          setInteractionLocked(false);
          break;
        }
        case 'shutdown_complete': {
          line('session shutdown', 'dim');
          es && es.close();
          currentTaskId = null;
          cancelBtn.disabled = true;
          compactBtn.disabled = true;
          awaitingApproval = false;
          turnBusy = false;
          updateTurnPill();
          setInteractionLocked(false);
          break;
        }
        case 'token_count_update': {
          if (msg.total_tokens) {
            statusTokens.textContent = `tokens: ${msg.total_tokens}`;
          }
          break;
        }
        case 'turn_started': {
          richLine([{tag:'tag', text:'status   '}, {text: 'turn started'}], 'dim');
          // New turn: clear seen diffs
          shownDiffs.clear();
          turnBusy = true;
          awaitingApproval = false;
          updateTurnPill();
          setInteractionLocked(true);
          updateExecStatus();
          break;
        }
        case 'turn_complete': {
          richLine([{tag:'tag', text:'status   '}, {text: 'turn complete'}], 'dim');
          // End of turn: clear seen diffs to prepare for next turn
          shownDiffs.clear();
          awaitingApproval = false;
          turnBusy = false;
          updateTurnPill();
          setInteractionLocked(false);
          updateExecStatus();
          break;
        }
        default: {
          // Fallback: dump raw JSON line
          line(JSON.stringify(event), 'dim');
        }
      }
    } catch (e) {
      line('! parse error: ' + e.message, 'error');
    }
  };
  es.onerror = () => {
    line('! event stream error', 'error');
    turnBusy = false;
    awaitingApproval = false;
    updateTurnPill();
    setInteractionLocked(false);
    updateExecStatus();
  };
}

async function hydrateConversationsList() {
  try {
    const res = await fetch('/api/conversations');
    if (!res.ok) return;
    const data = await res.json();
    const filter = searchConvEl.value.trim().toLowerCase();
    convListEl.innerHTML = '';
    for (const c of (data.conversations || [])) {
      if (filter && !c.title.toLowerCase().includes(filter) && !c.id.toLowerCase().includes(filter)) continue;
      const div = document.createElement('div');
      div.className = 'conv-item' + (c.id === currentConversationId ? ' active' : '');
      div.tabIndex = 0;
      const title = document.createElement('div');
      title.className = 'conv-title';
      title.textContent = c.title || 'Untitled';
      const sub = document.createElement('div');
      sub.className = 'conv-sub';
      sub.textContent = c.id.slice(0, 8) + ' • ' + (new Date(c.updated_at_ms).toLocaleString());
      div.appendChild(title);
      div.appendChild(sub);
      div.addEventListener('click', async () => {
        currentConversationId = c.id;
        Array.from(convListEl.children).forEach(el => el.classList.remove('active'));
        div.classList.add('active');
        // Load summary of messages
        try {
          const d = await fetch(`/api/conversations/${encodeURIComponent(c.id)}?full=0`).then(r => r.json());
          term.innerHTML = '';
          line(`Loaded conversation ${c.id}`, 'dim');
          for (const m of (d.messages || [])) {
            richLine([{tag:'tag', text:(m.role || 'agent').padEnd(9,' ')}, {text: m.text || ''}], '');
          }
        } catch {}
      });
      convListEl.appendChild(div);
    }
  } catch {}
}

refreshConvBtn.addEventListener('click', hydrateConversationsList);
searchConvEl.addEventListener('input', hydrateConversationsList);
showReasoningEl.addEventListener('change', () => {
  if (showReasoningEl.checked) {
    term.classList.remove('collapsed-reasoning');
  } else {
    term.classList.add('collapsed-reasoning');
  }
});

// Write is always enabled now; toggle removed from UI.

// File picker events
if (refreshFilesBtn) refreshFilesBtn.addEventListener('click', () => browse(currentBrowsePath));
if (upDirBtn) upDirBtn.addEventListener('click', () => { if (parentBrowsePath) browse(parentBrowsePath); });
if (setCwdBtn) setCwdBtn.addEventListener('click', () => { if (currentBrowsePath) { cwdEl.value = currentBrowsePath; line('cwd set: ' + currentBrowsePath, 'dim'); } });
if (fileSearchEl) fileSearchEl.addEventListener('input', (e) => { searchFilesInPath(e.target.value.trim()); });

// Chats modal events
if (openChatsBtn) openChatsBtn.addEventListener('click', () => { chatsModal?.setAttribute('open', ''); hydrateConversationsList(); });
if (closeChatsBtn) closeChatsBtn.addEventListener('click', () => { chatsModal?.removeAttribute('open'); });
if (chatsModal) chatsModal.addEventListener('click', (e) => { if (e.target === chatsModal) chatsModal.removeAttribute('open'); });

// Settings modal events
if (openSettingsBtn) openSettingsBtn.addEventListener('click', () => { settingsModal?.setAttribute('open',''); });
if (closeSettingsBtn) closeSettingsBtn.addEventListener('click', () => { settingsModal?.removeAttribute('open'); });
if (settingsModal) settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) settingsModal.removeAttribute('open'); });

// Populate the sidebar with the initial working directory on load
try { browse(null); } catch {}

runBtn.addEventListener('click', async () => {
  const text = promptEl.value;
  promptEl.value = '';
  await start(text);
});
promptEl.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const text = promptEl.value;
    promptEl.value = '';
    await start(text);
  }
});

// Allow pasting images directly into the prompt textarea
promptEl.addEventListener('paste', async (e) => {
  try {
    const dt = e.clipboardData;
    if (!dt) return;
    const items = dt.items ? Array.from(dt.items) : [];
    const imageFiles = [];
    for (const it of items) {
      if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) imageFiles.push(f);
      }
    }
    // Fallback: some browsers expose files only via dt.files
    if (imageFiles.length === 0 && dt.files && dt.files.length) {
      for (const f of Array.from(dt.files)) {
        if (f && f.type && f.type.startsWith('image/')) imageFiles.push(f);
      }
    }
    if (imageFiles.length === 0) return;
    const urls = await Promise.all(imageFiles.map(f => new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(f);
    })));
    let changed = false;
    for (const u of urls) {
      if (!pastedImages.includes(u)) { pastedImages.push(u); changed = true; }
    }
    if (changed) renderAttachments();
  } catch {}
});

// --- Drag & drop into the prompt (from sidebar or OS) ---
// Helpers to collect files from OS drops, including folders
async function readAllDirectoryEntries(dirReader) {
  const entries = [];
  while (true) {
    const batch = await new Promise((res) => dirReader.readEntries(res));
    if (!batch || batch.length === 0) break;
    entries.push(...batch);
  }
  return entries;
}

async function traverseFsEntry(entry, basePath, out) {
  try {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      const relPath = basePath ? `${basePath}/${file.name}` : (file.webkitRelativePath || file.name);
      out.push({ file, relPath });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const entries = await readAllDirectoryEntries(reader);
      for (const child of entries) {
        await traverseFsEntry(child, basePath ? `${basePath}/${entry.name}` : entry.name, out);
      }
    }
  } catch {}
}

async function traverseFsHandle(handle, basePath, out) {
  try {
    if (handle.kind === 'file') {
      const file = await handle.getFile();
      const relPath = basePath ? `${basePath}/${file.name}` : (file.webkitRelativePath || file.name);
      out.push({ file, relPath });
    } else if (handle.kind === 'directory') {
      for await (const [name, child] of handle.entries()) {
        if (child.kind === 'file') {
          const file = await child.getFile();
          const relPath = basePath ? `${basePath}/${name}` : name;
          out.push({ file, relPath });
        } else if (child.kind === 'directory') {
          await traverseFsHandle(child, basePath ? `${basePath}/${name}` : name, out);
        }
      }
    }
  } catch {}
}

async function collectDroppedFiles(dt) {
  const out = [];
  try {
    const items = Array.from(dt.items || []);
    if (items.length) {
      // Try per-item modern FS Access API and WebKit API without gating on the first item
      let handledAny = false;
      for (const it of items) {
        if (it && typeof it.getAsFileSystemHandle === 'function') {
          try {
            const h = await it.getAsFileSystemHandle();
            if (h) {
              await traverseFsHandle(h, '', out);
              handledAny = true;
              continue;
            }
          } catch {}
        }
        if (it && typeof it.webkitGetAsEntry === 'function') {
          try {
            const entry = it.webkitGetAsEntry();
            if (entry) {
              await traverseFsEntry(entry, '', out);
              handledAny = true;
              continue;
            }
          } catch {}
        }
      }
      if (handledAny) return out;
    }
    // Final fallback: plain FileList (will include files but not folders)
    const files = Array.from(dt.files || []);
    for (const f of files) out.push({ file: f, relPath: f.webkitRelativePath || f.name });
  } catch {}
  return out;
}
function setDropActive(active) {
  if (inputBoxEl) {
    if (active) inputBoxEl.classList.add('drop-target');
    else inputBoxEl.classList.remove('drop-target');
  }
}

async function handleDropOnPrompt(e) {
  try {
    e.preventDefault();
    // Ensure page-wide handlers don't interfere
    e.stopPropagation();
    setDropActive(false);
    const dt = e.dataTransfer;
    if (!dt) return;

    // Prefer internal drags from our sidebar (file picker).
    // Only treat as internal if our custom type is present to avoid misclassifying
    // OS drags where browsers expose absolute paths in text/plain.
    const hasInternalType = Array.from(dt.types || []).includes('application/x-codex-path');
    const internal = hasInternalType ? dt.getData('application/x-codex-path') : '';
    if (hasInternalType && internal && internal.trim().startsWith('/')) {
      const path = internal.trim();
      const sep = promptEl.value && !/\s$/.test(promptEl.value) ? ' ' : '';
      promptEl.value = (promptEl.value || '') + sep + path;
      promptEl.focus();
      return;
    }

    // OS drops (files or folders): append relative paths or names only; do not attach images on drop
    const collected = await collectDroppedFiles(dt);
    if (collected.length) {
      const names = collected.map(x => x.relPath || (x.file && x.file.name)).filter(Boolean);
      if (names.length) {
        const sep = promptEl.value && !/\s$/.test(promptEl.value) ? ' ' : '';
        promptEl.value = (promptEl.value || '') + sep + names.join(' ');
        promptEl.focus();
      }
      return;
    }
  } catch {}
}

// Enable drag & drop into the prompt (and the whole input box)
const dropTargets = [promptEl, inputBoxEl].filter(Boolean);
for (const el of dropTargets) {
  el.addEventListener('dragenter', (e) => { e.preventDefault(); setDropActive(true); });
  el.addEventListener('dragover',  (e) => { e.preventDefault(); setDropActive(true); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
  el.addEventListener('dragleave', (e) => { e.preventDefault(); setDropActive(false); });
  el.addEventListener('drop', handleDropOnPrompt);
}

// Optional nicety: allow dropping a folder/file onto the CWD field to set it
cwdEl.addEventListener('dragover', (e) => { e.preventDefault(); cwdEl.classList.add('drop-target'); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
cwdEl.addEventListener('dragleave', () => cwdEl.classList.remove('drop-target'));
cwdEl.addEventListener('drop', (e) => {
  e.preventDefault();
  cwdEl.classList.remove('drop-target');
  const dt = e.dataTransfer;
  if (!dt) return;
  const path = dt.getData('application/x-codex-path') || dt.getData('text/plain');
  if (path && path.trim().startsWith('/')) {
    cwdEl.value = path.trim();
    line('cwd set: ' + cwdEl.value, 'dim');
  }
});

// Prevent the browser from navigating on accidental page-wide drops,
// but allow drops within our input box or prompt textarea.
document.addEventListener('dragover', (e) => {
  // Always prevent default to indicate a drop target exists somewhere
  e.preventDefault();
});
document.addEventListener('drop', (e) => {
  const t = e.target;
  const inPrompt = promptEl && (t === promptEl || (t && promptEl.contains(t)));
  const inBox = inputBoxEl && (t === inputBoxEl || (t && inputBoxEl.contains(t)));
  if (!inPrompt && !inBox) {
    e.preventDefault();
  }
});

// Image picker wiring
if (imagesBtn) {
  imagesBtn.addEventListener('click', () => imagesEl && imagesEl.click());
}
if (imagesEl) {
  imagesEl.addEventListener('change', () => { renderImageChips(); renderAttachments(); });
}
// Initial chips render on load
renderImageChips();
