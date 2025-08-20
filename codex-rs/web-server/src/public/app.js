// Minimal terminal-like renderer for Codex events
const term = document.getElementById('term');
const promptEl = document.getElementById('prompt');
const runBtn = document.getElementById('run');
const cancelBtn = document.getElementById('cancel');
const compactBtn = document.getElementById('compact');
const fullAutoEl = document.getElementById('full-auto');
const cwdEl = document.getElementById('cwd');
const imagesEl = document.getElementById('images');
const attachmentsEl = document.getElementById('attachments');
const showReasoningEl = document.getElementById('show-reasoning');
const statusTokens = document.getElementById('status-tokens');
const statusModel = document.getElementById('status-model');
const statusSession = document.getElementById('status-session');
const convListEl = document.getElementById('conv-list');
const refreshConvBtn = document.getElementById('refresh-conv');
const searchConvEl = document.getElementById('search-conv');
const writeEnableEl = document.getElementById('write-enable');
// File picker elements
const fileListEl = document.getElementById('file-list');
const fileSearchEl = document.getElementById('file-search');
const refreshFilesBtn = document.getElementById('refresh-files');
const currentPathEl = document.getElementById('current-path');
const upDirBtn = document.getElementById('up-dir');
const setCwdBtn = document.getElementById('set-cwd');
// Chats modal elements
const chatsModal = document.getElementById('chats-modal');
const openChatsBtn = document.getElementById('open-chats');
const closeChatsBtn = document.getElementById('close-chats');

let currentTaskId = null;
let currentConversationId = null;
let es = null;
let activeExecs = 0;
let activePatches = 0;
let pastedImages = [];
let currentBrowsePath = '';
let parentBrowsePath = null;

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

function renderAttachments() {
  if (!attachmentsEl) return;
  attachmentsEl.innerHTML = '';
  if (!pastedImages || pastedImages.length === 0) {
    attachmentsEl.hidden = true;
    return;
  }
  attachmentsEl.hidden = false;
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
  updateExecStatus();
}

// --- File picker logic ---
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
    name.textContent = it.name || it.rel_path || '(unnamed)';
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
    row.addEventListener('click', () => {
      const fullPath = it.path || it.abs_path || '';
      if (it.is_dir) {
        browse(fullPath);
      } else if (fullPath) {
        line('selected file: ' + fullPath, 'dim');
        // Append path into the prompt for convenience
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
  resetStream();
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
  };

  richLine([{tag:'tag', text:'user     '}, {text: prompt || '(images only)'}], 'user');

  const res = await fetch('/api/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    line('! start failed: ' + t, 'error');
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
}

function updateExecStatus() {
  const pill = document.getElementById('status-exec');
  if (!pill) return;
  if (activeExecs > 0) {
    pill.textContent = `exec: running (${activeExecs})`;
    runBtn.classList.add('loading');
  } else {
    pill.textContent = 'exec: idle';
    runBtn.classList.remove('loading');
  }
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
  const cmdOutputLines = new Map(); // call_id -> output pre element
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
        case 'session_configured': {
          const sid = (msg.session_id || '').toString().slice(0, 8);
          statusModel.textContent = 'model: ' + (msg.model || '?');
          statusSession.textContent = 'session: ' + (sid || '–');
          richLine([{tag:'tag', text:'session  '}, {text: `configured (model=${msg.model || '?'})` }], 'dim');
          break;
        }
        case 'task_started': {
          richLine([{tag:'tag', text:'status   '}, {text: 'task started'}], 'dim');
          break;
        }
        case 'agent_message': {
          const div = richLine([{tag:'tag', text:'agent    '}], 'agent');
          const nodes = renderMarkdownToNodes(msg.message || '');
          div.appendChild(nodes);
          agentMsgLines.set(id, div);
          break;
        }
        case 'agent_message_delta': {
          let div = agentMsgLines.get(id);
          if (!div) {
            div = richLine([{tag:'tag', text:'agent    '}], 'agent');
            agentMsgLines.set(id, div);
          }
          div.appendChild(renderMarkdownToNodes(msg.delta || ''));
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
          const cwd = msg.cwd ? String(msg.cwd) : '';
          const cmd = (msg.command || []).join(' ');
          const block = document.createElement('div');
          block.className = 'exec-block';
          const header = document.createElement('div');
          header.className = 'exec-header';
          const tagSpan = document.createElement('span');
          tagSpan.className = 'tag';
          tagSpan.textContent = 'exec     ';
          const cmdSpan = document.createElement('span');
          cmdSpan.className = 'exec-cmd';
          cmdSpan.textContent = `$ ${cmd}`;
          const statusEl = document.createElement('span');
          statusEl.className = 'exec-status running';
          const spin = document.createElement('span');
          spin.className = 'spinner';
          statusEl.appendChild(spin);
          const stTxt = document.createElement('span');
          stTxt.textContent = 'running…';
          statusEl.appendChild(stTxt);
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
          const outPre = document.createElement('div');
          outPre.className = 'exec-output';
          block.appendChild(outPre);
          term.appendChild(block);
          term.scrollTop = term.scrollHeight;
          if (msg.call_id) {
            cmdMap.set(msg.call_id, cmd);
            cmdOutputLines.set(msg.call_id, outPre);
            execStatusMap.set(msg.call_id, { statusEl, blockEl: block });
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
        case 'apply_patch_approval_request': {
          line('apply patch requested (auto in web full-auto)', 'dim');
          break;
        }
        case 'patch_apply_begin': {
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
          line(msg.message || '', 'dim');
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
          updateExecStatus();
          break;
        }
        case 'turn_aborted': {
          line('turn aborted', 'error');
          currentTaskId = null;
          cancelBtn.disabled = true;
          compactBtn.disabled = true;
          break;
        }
        case 'shutdown_complete': {
          line('session shutdown', 'dim');
          es && es.close();
          currentTaskId = null;
          cancelBtn.disabled = true;
          compactBtn.disabled = true;
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
          break;
        }
        case 'turn_complete': {
          richLine([{tag:'tag', text:'status   '}, {text: 'turn complete'}], 'dim');
          // End of turn: clear seen diffs to prepare for next turn
          shownDiffs.clear();
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

writeEnableEl.addEventListener('change', async () => {
  try {
    const res = await fetch('/api/write_enabled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !!writeEnableEl.checked }),
    });
    if (!res.ok) {
      writeEnableEl.checked = !writeEnableEl.checked;
      return;
    }
  } catch (e) {
    writeEnableEl.checked = !writeEnableEl.checked;
  }
});

// File picker events
if (refreshFilesBtn) refreshFilesBtn.addEventListener('click', () => browse(currentBrowsePath));
if (upDirBtn) upDirBtn.addEventListener('click', () => { if (parentBrowsePath) browse(parentBrowsePath); });
if (setCwdBtn) setCwdBtn.addEventListener('click', () => { if (currentBrowsePath) { cwdEl.value = currentBrowsePath; line('cwd set: ' + currentBrowsePath, 'dim'); } });
if (fileSearchEl) fileSearchEl.addEventListener('input', (e) => { searchFilesInPath(e.target.value.trim()); });

// Chats modal events
if (openChatsBtn) openChatsBtn.addEventListener('click', () => { chatsModal?.setAttribute('open', ''); hydrateConversationsList(); });
if (closeChatsBtn) closeChatsBtn.addEventListener('click', () => { chatsModal?.removeAttribute('open'); });
if (chatsModal) chatsModal.addEventListener('click', (e) => { if (e.target === chatsModal) chatsModal.removeAttribute('open'); });

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

cancelBtn.addEventListener('click', async () => {
  if (!currentTaskId) return;
  try {
    await fetch(`/api/cancel/${encodeURIComponent(currentTaskId)}`, { method: 'POST' });
    line('cancel sent', 'dim');
  } catch {}
});
compactBtn.addEventListener('click', async () => {
  if (!currentTaskId) return;
  try {
    await fetch(`/api/compact/${encodeURIComponent(currentTaskId)}`, { method: 'POST' });
    line('compact requested', 'dim');
  } catch {}
});

// Initial boot
line('Codex Web CLI ready. Type a prompt to begin.', 'dim');
// Initialize file browser and pre-hydrate chats (modal)
browse();
hydrateConversationsList();
// fetch current write-enabled state
(async () => {
  try {
    const r = await fetch('/api/write_enabled');
    if (r.ok) {
      const j = await r.json();
      // OkResponse { ok: bool }
      if (typeof j.ok === 'boolean') writeEnableEl.checked = !!j.ok;
    }
  } catch {}
})();
