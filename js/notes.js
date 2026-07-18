/*
  notes.js — Chancellor Edwards

  Notes — a quiet, local-first surface for drafting LLM prompts.

  Design intent:
    A calm working surface between your thoughts and the model. Write what
    you're trying to do, shape the request, copy it out, paste responses back,
    revise. Copying is the primary action and is never gated behind saving.
    Saving is optional — it only preserves drafts worth continuing later.
    Nothing syncs, nothing streams; everything stays on this device.

  Storage (localStorage):
    "ce-notes-drafts-v1"  → JSON array of saved draft objects.
    "ce-notes-working-v1" → the current (possibly unsaved) draft, autosaved so
                            a reload or SPA re-entry never loses in-progress work.

  Current draft shape (legacy fields remain for compatibility):
    {
      id:        string|null  null until explicitly saved,
      objective: string        what the prompt should accomplish,
      prompt:    string        the main prompt,
      responses: string        scratch area for pasted model replies,
      createdAt: number,
      updatedAt: number
    }

  The module exposes window.CE_NOTES = { mount } so the SPA shell can re-mount
  on navigation re-entry. mount() is idempotent: it tears down prior listeners,
  re-reads the swapped DOM, and re-binds fresh handlers. It no-ops when the
  Notes root is absent (i.e. we're on another page).

  v3.0.0
*/
(function () {
  'use strict';

  /* ── Config ────────────────────────────────────────────────── */
  var DRAFTS_KEY  = 'ce-notes-drafts-v1';
  var WORKING_KEY = 'ce-notes-working-v1';

  var IS_MAC = /Mac|iPod|iPhone|iPad/.test(navigator.platform);

  /* ── Module state ──────────────────────────────────────────── */
  var state = {
    drafts:          [],
    working:         null,   // current draft (emptyDraft() until populated)
    handlers:        [],     // {el, type, fn} for clean teardown
    storageListener: null,
    pendingUndo:     null,   // last-deleted draft, awaiting undo
    toastTimer:      null,
    statusTimer:     null,
    mounted:         false
  };

  /* ── DOM helpers ──────────────────────────────────────────── */
  function $(id) { return document.getElementById(id); }

  function on(el, type, fn) {
    if (!el) return;
    el.addEventListener(type, fn);
    state.handlers.push({ el: el, type: type, fn: fn });
  }

  function offAll() {
    for (var i = 0; i < state.handlers.length; i++) {
      var h = state.handlers[i];
      try { h.el.removeEventListener(h.type, h.fn); } catch (e) { /* noop */ }
    }
    state.handlers = [];
  }

  /* ── Identity ──────────────────────────────────────────────── */
  function uuid() {
    if (window.crypto && window.crypto.randomUUID) {
      try { return window.crypto.randomUUID(); } catch (e) { /* fall through */ }
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /* ── Time formatting ───────────────────────────────────────── */
  function timeAgo(ts) {
    if (!ts) return 'just now';
    var diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60)      return 'just now';
    if (diff < 3600)    return Math.floor(diff / 60)   + 'm ago';
    if (diff < 86400)   return Math.floor(diff / 3600) + 'h ago';
    if (diff < 2592000) return Math.floor(diff / 86400) + 'd ago';
    var d = new Date(ts);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  /* ── Draft model ──────────────────────────────────────────── */
  function emptyDraft() {
    return {
      id: null,
      mode: 'free',
      purpose: '',
      body: '',
      goal: '',
      context: '',
      request: '',
      objective: '',
      prompt: '',
      desiredResult: '',
      responses: '',
      createdAt: null,
      updatedAt: null
    };
  }

  // Normalise any persisted object back into a full draft shape.
  function hydrate(obj) {
    var d = emptyDraft();
    var hasPrompt = obj && typeof obj === 'object' &&
      Object.prototype.hasOwnProperty.call(obj, 'prompt');
    var hasObjective = obj && typeof obj === 'object' &&
      Object.prototype.hasOwnProperty.call(obj, 'objective');
    if (obj && typeof obj === 'object') {
      for (var k in d) {
        if (Object.prototype.hasOwnProperty.call(d, k) && k in obj) d[k] = obj[k];
      }
    }
    if (d.mode !== 'free' && d.mode !== 'structured') d.mode = 'free';

    // Legacy migration is intentionally derived during hydration: existing
    // storage keys and fields stay intact, while repeated hydration is stable.
    if (!hasPrompt) {
      if (d.mode === 'structured') {
        d.prompt = textValue(d.request);
        d.desiredResult = textValue(d.goal);
      } else {
        d.prompt = [textValue(d.purpose).trim(), textValue(d.body).trim()]
          .filter(Boolean)
          .join('\n\n');
      }
    }
    d.prompt = textValue(d.prompt);
    d.context = textValue(d.context);
    d.desiredResult = textValue(d.desiredResult);
    if (!hasObjective) {
      d.objective = d.desiredResult;
      d.prompt = mergeContext(d.context, d.prompt);
    }
    d.objective = textValue(d.objective);
    d.responses = textValue(d.responses);
    return d;
  }

  function textValue(value) {
    return typeof value === 'string' ? value : '';
  }

  function mergeContext(context, prompt) {
    var sections = [];
    if (context.trim()) sections.push('# Context\n' + context);
    if (prompt.trim()) sections.push(prompt);
    return sections.join('\n\n');
  }

  function isValidDraft(d) {
    return d && typeof d === 'object' && typeof d.id === 'string';
  }

  function firstLine(text) {
    var line = (text || '').replace(/\r/g, '').split('\n')[0].trim();
    return line.length > 60 ? line.slice(0, 57) + '…' : line;
  }

  // A human label for the saved-drafts list.
  function titleOf(d) {
    var candidates = [d.prompt, d.objective];
    for (var i = 0; i < candidates.length; i++) {
      var line = firstLine(candidates[i]);
      if (line) return line;
    }
    return 'Untitled draft';
  }

  // Assemble the clean prompt string that gets copied.
  function buildPrompt(d) {
    var sections = [];
    var objective = textValue(d.objective);
    var prompt = textValue(d.prompt);
    if (objective.trim()) sections.push('# Mission\n' + objective);
    if (prompt.trim()) sections.push(prompt);
    return sections.join('\n\n');
  }

  function currentIsEmpty() {
    return buildPrompt(state.working) === '' && state.working.responses.trim() === '';
  }

  /* ── Storage ───────────────────────────────────────────────── */
  function loadDrafts() {
    try {
      var raw = localStorage.getItem(DRAFTS_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map(hydrate).filter(isValidDraft);
    } catch (e) {
      console.warn('[notes] load drafts failed, starting empty:', e);
      return [];
    }
  }

  function saveDrafts() {
    try {
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(state.drafts));
    } catch (e) {
      console.warn('[notes] save drafts failed:', e);
      toast('Could not save — local storage may be full or blocked.');
    }
  }

  function loadWorking() {
    try {
      var raw = localStorage.getItem(WORKING_KEY);
      return raw ? hydrate(JSON.parse(raw)) : emptyDraft();
    } catch (e) {
      return emptyDraft();
    }
  }

  function saveWorking() {
    try {
      localStorage.setItem(WORKING_KEY, JSON.stringify(state.working));
    } catch (e) { /* silent — copying never depends on this */ }
  }

  function clearWorking() {
    try { localStorage.removeItem(WORKING_KEY); } catch (e) { /* noop */ }
  }

  function indexOfDraft(id) {
    for (var i = 0; i < state.drafts.length; i++) {
      if (state.drafts[i].id === id) return i;
    }
    return -1;
  }

  /* ── Rendering ────────────────────────────────────────────── */
  function syncEditor() {
    var d = state.working;
    setField('notes-mission',   d.objective);
    setField('notes-body',      d.prompt);
    setField('notes-responses', d.responses);
    resizeMission();
  }

  function setField(id, value) {
    var el = $(id);
    if (el) el.value = value || '';
  }

  function resizeMission() {
    var el = $('notes-mission');
    if (!el) return;

    el.style.height = 'auto';
    var maxHeight = parseFloat(window.getComputedStyle(el).maxHeight);
    var nextHeight = Number.isFinite(maxHeight)
      ? Math.min(el.scrollHeight, maxHeight)
      : el.scrollHeight;

    el.style.height = nextHeight + 'px';
    el.style.overflowY = el.scrollHeight > nextHeight + 1 ? 'auto' : 'hidden';
  }

  function renderList() {
    var list  = $('notes-draft-list');
    var empty = $('notes-draft-empty');
    if (!list) return;

    list.innerHTML = '';
    if (empty) empty.hidden = state.drafts.length > 0;

    for (var i = 0; i < state.drafts.length; i++) {
      list.appendChild(renderDraftItem(state.drafts[i]));
    }
  }

  function renderDraftItem(draft) {
    var active = state.working.id != null && state.working.id === draft.id;

    var li = document.createElement('li');
    li.className = 'notes-draft-item' + (active ? ' is-active' : '');

    var open = document.createElement('button');
    open.type = 'button';
    open.className = 'notes-draft-open';
    open.setAttribute('data-act', 'open');
    open.setAttribute('data-id', draft.id);
    if (active) open.setAttribute('aria-current', 'true');

    var title = document.createElement('span');
    title.className = 'notes-draft-title';
    title.textContent = titleOf(draft);

    var meta = document.createElement('span');
    meta.className = 'notes-draft-meta';
    meta.textContent = timeAgo(draft.updatedAt);

    open.appendChild(title);
    open.appendChild(meta);

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'notes-draft-delete';
    del.setAttribute('data-act', 'delete');
    del.setAttribute('data-id', draft.id);
    del.setAttribute('aria-label', 'Delete draft: ' + titleOf(draft));
    del.innerHTML = '&times;';

    li.appendChild(open);
    li.appendChild(del);
    return li;
  }

  /* ── Actions ──────────────────────────────────────────────── */
  function updateField(field, value) {
    state.working[field] = value;
    state.working.updatedAt = Date.now();
    saveWorking();
  }

  function newDraft() {
    state.working = emptyDraft();
    clearWorking();
    syncEditor();
    renderList();
    var body = $('notes-body');
    if (body) body.focus();
    flashStatus('New draft');
  }

  function saveDraft() {
    if (currentIsEmpty()) {
      toast('Nothing to save yet');
      return;
    }
    var d = state.working;
    var now = Date.now();
    if (d.id) {
      d.updatedAt = now;
      var idx = indexOfDraft(d.id);
      if (idx >= 0) state.drafts[idx] = cloneDraft(d);
      else state.drafts.unshift(cloneDraft(d)); // was deleted elsewhere; re-add
    } else {
      d.id = d.id || uuid();
      d.createdAt = now;
      d.updatedAt = now;
      state.drafts.unshift(cloneDraft(d));
    }
    saveDrafts();
    saveWorking();
    renderList();
    flashStatus('Saved');
    toast('Draft saved');
  }

  function cloneDraft(d) {
    return hydrate(d); // shallow copy via the normaliser
  }

  function copyPrompt() {
    var text = buildPrompt(state.working);
    if (!text) {
      toast('Nothing to copy yet — write a prompt first');
      return;
    }
    writeClipboard(text).then(function () {
      toast('Prompt copied to clipboard');
      flashStatus('Copied');
    }, function () {
      toast('Could not copy — your browser blocked clipboard access');
    });
  }

  function openDraft(id) {
    var idx = indexOfDraft(id);
    if (idx < 0) return;
    state.working = hydrate(state.drafts[idx]);
    saveWorking();
    syncEditor();
    renderList();
    var body = $('notes-body');
    if (body) body.focus();
    flashStatus('Opened');
  }

  function deleteDraft(id) {
    var idx = indexOfDraft(id);
    if (idx < 0) return;
    var wasActive = state.working.id === id;
    var removed = state.drafts.splice(idx, 1)[0];
    saveDrafts();
    if (wasActive) { state.working.id = null; saveWorking(); } // keep text, detach
    renderList();

    state.pendingUndo = removed;
    toast('Draft deleted', 'Undo', function () {
      // Re-insert, newest-updated first.
      state.drafts.unshift(removed);
      state.drafts.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
      saveDrafts();
      if (wasActive) { state.working.id = removed.id; saveWorking(); }
      state.pendingUndo = null;
      renderList();
      flashStatus('Restored');
    });
  }

  /* ── Clipboard ────────────────────────────────────────────── */
  function writeClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      // Prefer the async API, but fall back if it's blocked rather than failing.
      return navigator.clipboard.writeText(text)['catch'](function () {
        return legacyCopy(text);
      });
    }
    return legacyCopy(text);
  }

  function legacyCopy(text) {
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) resolve(); else reject();
      } catch (err) { reject(err); }
    });
  }

  /* ── Feedback ─────────────────────────────────────────────── */
  function flashStatus(text) {
    var el = $('notes-status');
    if (!el) return;
    el.textContent = text;
    clearTimeout(state.statusTimer);
    state.statusTimer = setTimeout(function () { el.textContent = ''; }, 1800);
  }

  function toast(message, actionLabel, onAction) {
    var el = $('notes-toast');
    if (!el) return;
    el.innerHTML = '';
    var span = document.createElement('span');
    span.textContent = message;
    el.appendChild(span);

    if (actionLabel) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'notes-toast-action';
      btn.textContent = actionLabel;
      btn.addEventListener('click', function () {
        hideToast();
        if (onAction) onAction();
      });
      el.appendChild(btn);
    }

    el.hidden = false;
    void el.offsetWidth; // restart transition
    el.classList.add('is-visible');

    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(hideToast, actionLabel ? 6000 : 2400);
  }

  function hideToast() {
    var el = $('notes-toast');
    if (!el) return;
    el.classList.remove('is-visible');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () { el.hidden = true; }, 200);
  }

  /* ── Event handlers ───────────────────────────────────────── */
  var FIELD_MAP = {
    'notes-mission':   'objective',
    'notes-body':      'prompt',
    'notes-responses': 'responses'
  };

  function handleFieldInput(e) {
    var field = FIELD_MAP[e.target.id];
    if (field) updateField(field, e.target.value);
    if (e.target.id === 'notes-mission') resizeMission();
  }

  function handleListClick(e) {
    var btn = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    var id  = btn.getAttribute('data-id');
    var act = btn.getAttribute('data-act');
    if (!id) return;
    if (act === 'open') openDraft(id);
    else if (act === 'delete') deleteDraft(id);
  }

  // Scoped to the Notes root, so shortcuts never leak to other pages.
  function handleKeydown(e) {
    var mod = IS_MAC ? e.metaKey : e.ctrlKey;
    if (!mod) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      copyPrompt();
    } else if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      saveDraft();
    } else if (e.shiftKey && (e.key === 'n' || e.key === 'N')) {
      e.preventDefault();
      newDraft();
    }
  }

  /* ── Cross-tab sync ───────────────────────────────────────── */
  function handleStorage(e) {
    if (!e || e.key !== DRAFTS_KEY) return;
    state.drafts = loadDrafts();
    renderList();
  }

  /* ── Mount / bind ─────────────────────────────────────────── */
  function mount() {
    var root = $('notes-root');
    if (!root) return;          // Wrong page — gracefully do nothing.

    // Teardown any prior binding (idempotent across SPA re-entries).
    offAll();
    if (state.storageListener) {
      try { window.removeEventListener('storage', state.storageListener); } catch (e) { /* noop */ }
      state.storageListener = null;
    }
    clearTimeout(state.toastTimer);
    clearTimeout(state.statusTimer);

    // Restore data. The working draft survives reloads and SPA re-entry.
    state.drafts  = loadDrafts();
    state.working = loadWorking();

    syncEditor();
    renderList();

    // Wire events. Field inputs are bound individually; container clicks and
    // shortcuts are delegated. Everything is tracked for clean teardown.
    for (var id in FIELD_MAP) {
      if (Object.prototype.hasOwnProperty.call(FIELD_MAP, id)) {
        on($(id), 'input', handleFieldInput);
      }
    }
    on($('notes-save'),       'click',   saveDraft);
    on($('notes-copy'),       'click',   copyPrompt);
    on($('notes-new'),        'click',   newDraft);
    on($('notes-draft-list'), 'click',   handleListClick);
    on(root,                  'keydown', handleKeydown);
    on(window,                'resize',  resizeMission);

    // Cross-tab: if another tab writes the saved list, refresh ours.
    state.storageListener = handleStorage;
    window.addEventListener('storage', state.storageListener);

    // Zero-friction start: focus the body on a cold load. On SPA navigation the
    // shell deliberately focuses the page heading for screen-reader orientation,
    // so only take focus when nothing else has claimed it.
    setTimeout(function () {
      if (document.activeElement === document.body) {
        var body = $('notes-body');
        if (body) body.focus();
      }
    }, 0);

    state.mounted = true;
  }

  /* ── Expose + auto-mount ──────────────────────────────────── */
  window.CE_NOTES = { mount: mount };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
