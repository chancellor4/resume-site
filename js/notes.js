/*
  notes.js — Chancellor Edwards

  Notes — a local-first, offline-only micro-vault.

  Design intent (from docs/PLAN-v2.md):
    Notes never asks for attention. Never makes a network request.
    It is your desk drawer: the paper is always there, nothing syncs,
    nothing streams. Capture is instant, search is fluid, persistence
    is local.

  Storage:
    localStorage["ce-notes-v1"] → JSON array of note objects.
    localStorage["ce-notes-prefs-v1"] → { filter, query } (UI memory).

  Note shape:
    {
      id:        string   UUID (or fallback),
      title:     string   first line, inferred if omitted,
      body:      string   full note content,
      tags:      string[] parsed from inline #hashtags,
      createdAt: number   ms since epoch,
      updatedAt: number   ms since epoch,
      pinned:    boolean,
      archived:  boolean
    }

  The module exposes window.CE_NOTES = { mount } so the SPA shell can
  re-mount on navigation re-entry. mount() is idempotent: it clears
  prior listeners, re-reads the DOM, and re-binds fresh handlers.

  v2.0.0
*/
(function () {
  'use strict';

  /* ── Config ────────────────────────────────────────────────── */
  var STORE_KEY  = 'ce-notes-v1';
  var PREFS_KEY  = 'ce-notes-prefs-v1';
  var EXPORT_VER = 1;

  /* ── Module state ──────────────────────────────────────────── */
  var state = {
    notes:    [],
    filter:   'all',       // 'all' | 'pinned' | 'archived'
    query:    '',
    editing:  null,        // note id currently being edited, or null
    mounted:  false,
    handlers: [],          // {el, type, fn} for clean teardown
    storageListener: null
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

  /* ── Safety: escape + attribute-safe URL ───────────────────── */
  function esc(str) {
    if (str === null || str === undefined) return '';
    var el = document.createElement('span');
    el.textContent = String(str);
    return el.innerHTML;
  }

  /* ── Identity ──────────────────────────────────────────────── */
  function uuid() {
    if (window.crypto && window.crypto.randomUUID) {
      try { return window.crypto.randomUUID(); } catch (e) { /* fall through */ }
    }
    // RFC4122 v4 fallback
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /* ── Time formatting ───────────────────────────────────────── */
  function timeAgo(ts) {
    if (!ts) return '';
    var diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 5)     return 'just now';
    if (diff < 60)    return diff + 's ago';
    if (diff < 3600)  return Math.floor(diff / 60)   + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 2592000) return Math.floor(diff / 86400) + 'd ago';
    // Older than a month: show absolute date
    var d = new Date(ts);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  /* ── Storage ───────────────────────────────────────────────── */
  function loadNotes() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isValidNote);
    } catch (e) {
      console.warn('[notes] load failed, starting empty:', e);
      return [];
    }
  }

  function saveNotes() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state.notes));
    } catch (e) {
      // Quota, private mode, etc. — surface a quiet inline hint.
      console.warn('[notes] save failed:', e);
      showFlash('Could not save — local storage may be full or blocked.');
    }
  }

  function loadPrefs() {
    try {
      var raw = localStorage.getItem(PREFS_KEY);
      if (!raw) return;
      var p = JSON.parse(raw) || {};
      if (p.filter === 'pinned' || p.filter === 'archived' || p.filter === 'all') {
        state.filter = p.filter;
      }
      if (typeof p.query === 'string') state.query = p.query;
    } catch (e) { /* silent */ }
  }

  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({
        filter: state.filter,
        query:  state.query
      }));
    } catch (e) { /* silent */ }
  }

  // Coalesce rapid pref writes (e.g. typing in search) so storage isn't
  // touched on every keystroke. Trailing-edge debounce keeps the last
  // value the user settled on.
  var _savePrefsTimer = null;
  function savePrefsDebounced() {
    if (_savePrefsTimer) clearTimeout(_savePrefsTimer);
    _savePrefsTimer = setTimeout(function () {
      _savePrefsTimer = null;
      savePrefs();
    }, 300);
  }

  function isValidNote(n) {
    return n && typeof n === 'object'
      && typeof n.id === 'string'
      && typeof n.body === 'string'
      && typeof n.createdAt === 'number';
  }

  /* ── Note operations ──────────────────────────────────────── */
  function parseTags(body) {
    if (!body) return [];
    var matches = body.match(/(?:^|\s)#([\w-]{1,48})/g);
    if (!matches) return [];
    var seen = {};
    var out = [];
    for (var i = 0; i < matches.length; i++) {
      var tag = matches[i].trim().replace(/^#/, '').toLowerCase();
      if (!seen[tag]) { seen[tag] = true; out.push(tag); }
    }
    return out;
  }

  function inferTitle(body) {
    if (!body) return '';
    var firstLine = body.split(/\r?\n/)[0].trim();
    if (firstLine.length > 80) return firstLine.slice(0, 80).trim() + '…';
    return firstLine;
  }

  function createNote(title, body) {
    var now = Date.now();
    var note = {
      id:        uuid(),
      title:     (title || '').trim(),
      body:      body || '',
      tags:      parseTags(body),
      createdAt: now,
      updatedAt: now,
      pinned:    false,
      archived:  false
    };
    state.notes.unshift(note);
    saveNotes();
    return note;
  }

  function updateNote(id, patch) {
    for (var i = 0; i < state.notes.length; i++) {
      if (state.notes[i].id === id) {
        var n = state.notes[i];
        if ('title' in patch) n.title = (patch.title || '').trim();
        if ('body'  in patch) { n.body = patch.body || ''; n.tags = parseTags(n.body); }
        if ('pinned' in patch)   n.pinned   = !!patch.pinned;
        if ('archived' in patch) n.archived = !!patch.archived;
        n.updatedAt = Date.now();
        saveNotes();
        return n;
      }
    }
    return null;
  }

  function removeNote(id) {
    var before = state.notes.length;
    state.notes = state.notes.filter(function (n) { return n.id !== id; });
    if (state.notes.length !== before) saveNotes();
  }

  /* ── Filtering ────────────────────────────────────────────── */
  function matchesQuery(n, q) {
    if (!q) return true;
    var haystack = (n.title + ' ' + n.body + ' ' + n.tags.join(' ')).toLowerCase();
    // Multi-term AND: each whitespace-separated term must appear.
    var terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    for (var i = 0; i < terms.length; i++) {
      if (haystack.indexOf(terms[i]) === -1) return false;
    }
    return true;
  }

  function visibleNotes() {
    var filter = state.filter;
    var q      = state.query;
    var out    = state.notes.filter(function (n) {
      if (filter === 'pinned'   && !n.pinned)   return false;
      if (filter === 'archived' && !n.archived) return false;
      if (filter === 'all'      && n.archived)  return false;
      return matchesQuery(n, q);
    });

    // Pinned first (within "all" and "pinned"), then most-recently-updated.
    out.sort(function (a, b) {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
    return out;
  }

  /* ── Rendering ────────────────────────────────────────────── */
  function renderNote(n) {
    var tagsHtml = '';
    if (n.tags && n.tags.length) {
      var bits = [];
      for (var i = 0; i < n.tags.length; i++) {
        bits.push('<span class="notes-tag">#' + esc(n.tags[i]) + '</span>');
      }
      tagsHtml = '<div class="notes-card-tags">' + bits.join('') + '</div>';
    }

    var title = n.title || inferTitle(n.body) || 'Untitled';
    var previewBody = n.body;
    // Strip the first line if it matches the inferred title (avoids dup).
    var firstLine = (n.body || '').split(/\r?\n/)[0].trim();
    if (!n.title && firstLine && firstLine.indexOf(title.replace(/…$/, '')) === 0) {
      previewBody = (n.body || '').split(/\r?\n/).slice(1).join('\n').trim();
    }

    var pinLabel     = n.pinned   ? 'Unpin'    : 'Pin';
    var archiveLabel = n.archived ? 'Restore'  : 'Archive';

    return (
      '<article class="notes-card' + (n.pinned ? ' is-pinned' : '') +
                                    (n.archived ? ' is-archived' : '') +
        '" data-note-id="' + esc(n.id) + '">' +
        '<header class="notes-card-head">' +
          '<h3 class="notes-card-title">' + esc(title) + '</h3>' +
          '<time class="notes-card-time" datetime="' + new Date(n.updatedAt).toISOString() + '">' +
            esc(timeAgo(n.updatedAt)) +
          '</time>' +
        '</header>' +
        (previewBody ? '<p class="notes-card-body">' + esc(previewBody) + '</p>' : '') +
        tagsHtml +
        '<footer class="notes-card-actions">' +
          '<button type="button" class="notes-btn" data-act="pin">' + pinLabel + '</button>' +
          '<button type="button" class="notes-btn" data-act="archive">' + archiveLabel + '</button>' +
          '<button type="button" class="notes-btn" data-act="edit">Edit</button>' +
          '<button type="button" class="notes-btn notes-btn-quiet" data-act="delete">Delete</button>' +
        '</footer>' +
      '</article>'
    );
  }

  function renderList() {
    var list  = $('notes-list');
    var empty = $('notes-empty');
    var count = $('notes-count');
    if (!list) return;

    var items = visibleNotes();

    if (!items.length) {
      list.innerHTML = '';
      if (empty) {
        empty.hidden = false;
        empty.textContent = state.query
          ? 'Nothing matches “' + state.query + '”.'
          : (state.filter === 'archived'
              ? 'No archived notes yet.'
              : (state.filter === 'pinned'
                  ? 'Nothing pinned yet.'
                  : 'No notes yet. Write the first one above.'));
      }
    } else {
      if (empty) empty.hidden = true;
      var html = '';
      for (var i = 0; i < items.length; i++) html += renderNote(items[i]);
      list.innerHTML = html;
    }

    if (count) {
      var total   = state.notes.length;
      var visible = items.length;
      count.textContent = visible === total
        ? total + (total === 1 ? ' note' : ' notes')
        : visible + ' of ' + total;
    }

    // Update filter pill active states
    var pills = document.querySelectorAll('[data-filter]');
    for (var p = 0; p < pills.length; p++) {
      var f = pills[p].getAttribute('data-filter');
      var on = f === state.filter;
      pills[p].classList.toggle('notes-pill-active', on);
      pills[p].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function showFlash(msg) {
    var flash = $('notes-flash');
    if (!flash) return;
    flash.textContent = msg;
    flash.hidden = false;
    clearTimeout(flash._t);
    flash._t = setTimeout(function () { flash.hidden = true; }, 4000);
  }

  /* ── Compose ──────────────────────────────────────────────── */
  function handleCompose(e) {
    if (e && e.preventDefault) e.preventDefault();
    var titleEl = $('notes-compose-title');
    var bodyEl  = $('notes-compose-body');
    if (!bodyEl) return;

    var body  = bodyEl.value;
    var title = titleEl ? titleEl.value : '';

    if (!body.trim() && !title.trim()) {
      // Nothing to save — keep things calm, no error.
      bodyEl.focus();
      return;
    }

    if (state.editing) {
      updateNote(state.editing, { title: title, body: body });
      state.editing = null;
      var submitBtn = $('notes-compose-submit');
      if (submitBtn) submitBtn.textContent = 'Save note';
      var cancelBtn = $('notes-compose-cancel');
      if (cancelBtn) cancelBtn.hidden = true;
    } else {
      createNote(title, body);
    }

    if (titleEl) titleEl.value = '';
    bodyEl.value = '';
    renderList();
    bodyEl.focus();
  }

  function cancelEdit() {
    state.editing = null;
    var titleEl   = $('notes-compose-title');
    var bodyEl    = $('notes-compose-body');
    var submitBtn = $('notes-compose-submit');
    var cancelBtn = $('notes-compose-cancel');
    if (titleEl) titleEl.value = '';
    if (bodyEl)  bodyEl.value  = '';
    if (submitBtn) submitBtn.textContent = 'Save note';
    if (cancelBtn) cancelBtn.hidden = true;
  }

  function startEdit(id) {
    var n = null;
    for (var i = 0; i < state.notes.length; i++) {
      if (state.notes[i].id === id) { n = state.notes[i]; break; }
    }
    if (!n) return;

    state.editing = id;
    var titleEl   = $('notes-compose-title');
    var bodyEl    = $('notes-compose-body');
    var submitBtn = $('notes-compose-submit');
    var cancelBtn = $('notes-compose-cancel');

    if (titleEl) titleEl.value = n.title || '';
    if (bodyEl)  { bodyEl.value = n.body || ''; bodyEl.focus(); }
    if (submitBtn) submitBtn.textContent = 'Update note';
    if (cancelBtn) cancelBtn.hidden = false;

    // Scroll compose into view gently for clarity.
    var form = $('notes-compose');
    if (form && form.scrollIntoView) form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ── Card action dispatcher ───────────────────────────────── */
  function handleCardClick(e) {
    var btn = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    var card = btn.closest ? btn.closest('[data-note-id]') : null;
    if (!card) return;
    var id  = card.getAttribute('data-note-id');
    var act = btn.getAttribute('data-act');
    if (!id || !act) return;

    switch (act) {
      case 'pin':
        var n = findNote(id);
        if (n) updateNote(id, { pinned: !n.pinned });
        renderList();
        break;
      case 'archive':
        var m = findNote(id);
        if (m) updateNote(id, { archived: !m.archived });
        renderList();
        break;
      case 'edit':
        startEdit(id);
        break;
      case 'delete':
        // Soft confirm — native prompt is calm enough for a single action.
        if (window.confirm('Delete this note? This cannot be undone.')) {
          removeNote(id);
          if (state.editing === id) cancelEdit();
          renderList();
        }
        break;
    }
  }

  function findNote(id) {
    for (var i = 0; i < state.notes.length; i++) {
      if (state.notes[i].id === id) return state.notes[i];
    }
    return null;
  }

  /* ── Filter + search ──────────────────────────────────────── */
  function handleFilterClick(e) {
    var btn = e.target.closest ? e.target.closest('[data-filter]') : null;
    if (!btn) return;
    var f = btn.getAttribute('data-filter');
    if (f !== 'all' && f !== 'pinned' && f !== 'archived') return;
    state.filter = f;
    savePrefs();
    renderList();
  }

  function handleSearchInput(e) {
    state.query = e.target.value || '';
    savePrefsDebounced();
    renderList();
  }

  /* ── Keyboard: Cmd/Ctrl+Enter to save ─────────────────────── */
  function handleComposeKeydown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleCompose(e);
    } else if (e.key === 'Escape' && state.editing) {
      e.preventDefault();
      cancelEdit();
    }
  }

  /* ── Export / Import ──────────────────────────────────────── */
  function handleExport() {
    var payload = {
      version:  EXPORT_VER,
      exportedAt: new Date().toISOString(),
      notes:    state.notes
    };
    try {
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var url  = URL.createObjectURL(blob);
      var a    = document.createElement('a');
      var stamp = new Date().toISOString().slice(0, 10);
      a.href     = url;
      a.download = 'notes-' + stamp + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      showFlash('Exported ' + state.notes.length + (state.notes.length === 1 ? ' note.' : ' notes.'));
    } catch (e) {
      console.warn('[notes] export failed:', e);
      showFlash('Export failed. Try a different browser.');
    }
  }

  function handleImportClick() {
    var input = $('notes-import-file');
    if (input) input.click();
  }

  function handleImportFile(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        var incoming = Array.isArray(data) ? data : (data && data.notes);
        if (!Array.isArray(incoming)) throw new Error('unrecognised shape');

        var existingIds = {};
        for (var i = 0; i < state.notes.length; i++) existingIds[state.notes[i].id] = true;

        var added = 0;
        for (var j = 0; j < incoming.length; j++) {
          var n = incoming[j];
          if (!n || typeof n !== 'object') continue;
          // Regenerate id if missing or colliding — import is additive, not merging.
          if (!n.id || existingIds[n.id]) n.id = uuid();
          if (typeof n.body !== 'string') n.body = '';
          if (typeof n.title !== 'string') n.title = '';
          if (typeof n.createdAt !== 'number') n.createdAt = Date.now();
          if (typeof n.updatedAt !== 'number') n.updatedAt = n.createdAt;
          n.pinned   = !!n.pinned;
          n.archived = !!n.archived;
          n.tags = Array.isArray(n.tags) ? n.tags.slice(0, 32) : parseTags(n.body);
          state.notes.unshift(n);
          existingIds[n.id] = true;
          added++;
        }
        saveNotes();
        renderList();
        showFlash('Imported ' + added + (added === 1 ? ' note.' : ' notes.'));
      } catch (err) {
        console.warn('[notes] import failed:', err);
        showFlash('That file wasn’t a recognised notes export.');
      } finally {
        // Reset so the same file can be re-imported if needed.
        e.target.value = '';
      }
    };
    reader.onerror = function () { showFlash('Couldn’t read that file.'); };
    reader.readAsText(file);
  }

  /* ── Cross-tab sync ───────────────────────────────────────── */
  function handleStorage(e) {
    if (!e || e.key !== STORE_KEY) return;
    state.notes = loadNotes();
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

    loadPrefs();
    state.notes   = loadNotes();
    state.editing = null;

    // Hydrate search box + filter pills from prefs.
    var searchEl = $('notes-search');
    if (searchEl) searchEl.value = state.query || '';

    // Wire events.
    var form      = $('notes-compose');
    var bodyEl    = $('notes-compose-body');
    var cancelBtn = $('notes-compose-cancel');
    var list      = $('notes-list');
    var filters   = $('notes-filters');
    var exportBtn = $('notes-export');
    var importBtn = $('notes-import');
    var importEl  = $('notes-import-file');

    on(form,      'submit',   handleCompose);
    on(bodyEl,    'keydown',  handleComposeKeydown);
    on(cancelBtn, 'click',    cancelEdit);
    on(list,      'click',    handleCardClick);
    on(filters,   'click',    handleFilterClick);
    on(searchEl,  'input',    handleSearchInput);
    on(exportBtn, 'click',    handleExport);
    on(importBtn, 'click',    handleImportClick);
    on(importEl,  'change',   handleImportFile);

    // Cross-tab: if another tab writes, we refresh.
    state.storageListener = handleStorage;
    window.addEventListener('storage', state.storageListener);

    renderList();

    // Autofocus for instant capture — only if nothing else is focused
    // and the user hasn't already interacted.
    setTimeout(function () {
      if (document.activeElement === document.body && bodyEl) {
        try { bodyEl.focus(); } catch (e) { /* noop */ }
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
