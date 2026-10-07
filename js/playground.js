/*
  playground.js — Chancellor Edwards
  Playground (v5) — Blogging and life updates.

  Design intent
  -------------
  One reading column. The room renders the public archive — the
  Blog-API's read-only contract — as a chronological index grouped by
  year, and one article at a time. Plain text stays plain text; photographs
  follow the words as simple figures; nothing animates for its own sake.

  Architecture
  ------------
  - Single IIFE; exposes window.CE_PLAYGROUND.{mount, unmount} so the SPA
    shell (js/shell.js) can re-enter after a DOM swap. playground.html's
    inline bootstrap calls mount() on every entry.
  - Routes live in the query string: playground.html (index) and
    playground.html?entry=<id> (article). In-page link clicks are handled
    here with pushState; back/forward is handled by the shell, which
    re-fetches the page and re-runs the bootstrap. When the shell is
    absent, this module handles popstate itself.
  - Data: GET {origin}/api/v1/public/entries[?cursor] and
    /public/entries/:id (+ /photos pages). The origin is read from
    <main data-archive-origin>; an empty value means same-origin.
    Public reads are no-store on the server, so the index page cache
    here lives only for the session and goes stale after five minutes.
  - Rendering builds DOM with createElement only — archive text is never
    parsed as HTML.
  - Styles: css/playground.css (loaded by the bootstrap on SPA entry).
*/
(function () {
  'use strict';

  if (typeof document === 'undefined') return;
  if (!window.fetch || !window.Promise) return;

  /* ── Constants ───────────────────────────────────────────── */

  var DEFAULT_ORIGIN    = 'https://journal-app-api-is52rxqtkq-uc.a.run.app';
  var API_BASE          = '/api/v1/public';
  var PAGE_SIZE         = 20;
  var FETCH_TIMEOUT_MS  = 8000;
  var LIST_STALE_MS     = 5 * 60 * 1000;
  var LOADING_DELAY_MS  = 300;
  var EXCERPT_CHARS     = 150;
  var MAX_EMPTY_PAGES   = 5;   // empty filtered pages may still carry a cursor
  var MAX_PHOTO_PAGES   = 4;   // 50 photos per entry, 20 per page
  var LONG_TITLE_CHARS  = 80;  // past this, the article title steps down a size

  var ROOM_TITLE  = 'Blogging';
  var INDEX_TITLE = 'Blogging — Chancellor Edwards (Chance Edwards)';
  var AUTHOR      = 'Chancellor Edwards';
  var PLACE       = 'Houston, TX';

  var ID_PATTERN  = /^[A-Za-z0-9_-]{1,128}$/;
  var DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                'August', 'September', 'October', 'November', 'December'];
  var DAYS   = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  /* ── State ───────────────────────────────────────────────── */

  var list = { entries: [], nextCursor: null, loadedAt: 0, origin: null };
  var entryCache = {};          // id → PublicEntryDTO with all photo pages
  var controller = null;        // AbortController for the view in flight
  var renderToken = 0;          // stale-promise guard
  var bound = false;            // document-level listeners attached once

  /* ── Tiny helpers ────────────────────────────────────────── */

  function $(sel, root) { return (root || document).querySelector(sel); }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!attrs.hasOwnProperty(k) || attrs[k] == null) continue;
        if (k === 'text') node.textContent = attrs[k];
        else if (k === 'className') node.className = attrs[k];
        else node.setAttribute(k, attrs[k]);
      }
    }
    if (children) {
      for (var i = 0; i < children.length; i++) {
        if (children[i]) node.appendChild(children[i]);
      }
    }
    return node;
  }

  function empty(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function isPlaygroundPage() {
    return document.body && document.body.getAttribute('data-page') === 'playground';
  }

  function rootEl() { return $('main[data-archive-origin]'); }

  function archiveOrigin() {
    var root = rootEl();
    var attr = root ? root.getAttribute('data-archive-origin') : null;
    if (attr === null) return DEFAULT_ORIGIN;
    return attr.replace(/\/+$/, '');
  }

  function apiUrl(path) {
    var origin = archiveOrigin();
    if (!origin) return API_BASE + path;           // same-origin
    return origin + API_BASE + path;
  }

  function mediaUrl(path) {
    if (typeof path !== 'string') return null;
    if (/^https:\/\//i.test(path)) return path;
    if (path.charAt(0) !== '/') return null;
    var origin = archiveOrigin();
    return origin ? origin + path : path;
  }

  /* ── Dates ───────────────────────────────────────────────── */

  // entryDate is a calendar day the author chose, not an instant —
  // parse it by hand so no timezone can shift it.
  function parseDay(s) {
    var m = DATE_PATTERN.exec(s || '');
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return { y: y, m: mo, d: d, date: new Date(Date.UTC(y, mo - 1, d)) };
  }

  function dayOfWeek(day) { return DAYS[day.date.getUTCDay()]; }

  function formatDay(day, opts) {
    opts = opts || {};
    var out = day.d + ' ' + MONTHS[day.m - 1];
    if (opts.year !== false) out += ' ' + day.y;
    if (opts.weekday) out = dayOfWeek(day) + ', ' + out;
    return out;
  }

  function isoDay(day) {
    return day.y + '-' + (day.m < 10 ? '0' : '') + day.m + '-' + (day.d < 10 ? '0' : '') + day.d;
  }

  function dayFromInstant(iso) {
    var t = Date.parse(iso || '');
    if (isNaN(t)) return null;
    var d = new Date(t);
    return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(),
             date: new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) };
  }

  /* ── Text ────────────────────────────────────────────────── */

  function paragraphsOf(content) {
    var text = String(content || '').replace(/\r\n?/g, '\n').trim();
    if (!text) return [];
    return text.split(/\n[ \t]*\n+/).map(function (p) { return p.trim(); }).filter(Boolean);
  }

  function excerptOf(content) {
    var paras = paragraphsOf(content);
    if (!paras.length) return '';
    var first = paras[0].replace(/\s+/g, ' ');
    if (first.length <= EXCERPT_CHARS) return first;
    var cut = first.lastIndexOf(' ', EXCERPT_CHARS);
    if (cut < EXCERPT_CHARS * 0.6) cut = EXCERPT_CHARS;
    return first.slice(0, cut).replace(/[\s,;:—–-]+$/, '') + '…';
  }

  // A paragraph keeps its own line breaks (verse, lists written by hand).
  function paragraphNode(text, className) {
    var p = el('p', className ? { className: className } : null);
    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) {
      if (i > 0) p.appendChild(document.createElement('br'));
      p.appendChild(document.createTextNode(lines[i]));
    }
    return p;
  }

  /* ── Validation ──────────────────────────────────────────── */

  function cleanEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) return null;
    var day = parseDay(raw.entryDate);
    if (!day) return null;
    return {
      id: raw.id,
      title: typeof raw.title === 'string' ? raw.title.trim() : '',
      content: typeof raw.content === 'string' ? raw.content : '',
      day: day,
      tags: Array.isArray(raw.tags) ? raw.tags.filter(function (t) { return typeof t === 'string' && t.trim(); }) : [],
      publishedAt: typeof raw.publishedAt === 'string' ? raw.publishedAt : null,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
      photos: Array.isArray(raw.photos) ? raw.photos.map(cleanPhoto).filter(Boolean) : [],
      nextPhotoCursor: typeof raw.nextPhotoCursor === 'string' ? raw.nextPhotoCursor : null
    };
  }

  function cleanPhoto(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var url = mediaUrl(raw.url);
    if (!url || typeof raw.photoId !== 'string') return null;
    var w = +raw.width, h = +raw.height;
    return {
      id: raw.photoId,
      url: url,
      width: w > 0 ? Math.round(w) : null,
      height: h > 0 ? Math.round(h) : null,
      caption: typeof raw.caption === 'string' ? raw.caption.trim() : '',
      altText: typeof raw.altText === 'string' ? raw.altText.trim() : ''
    };
  }

  /* ── Fetching ────────────────────────────────────────────── */

  function ArchiveError(kind, status) { this.kind = kind; this.status = status || 0; }

  function fetchJSON(url, signal) {
    var timer = null;
    var local = window.AbortController ? new AbortController() : null;
    if (local) {
      if (signal) signal.addEventListener('abort', function () { local.abort(); });
      timer = setTimeout(function () { local.abort(); }, FETCH_TIMEOUT_MS);
    }
    return fetch(url, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      headers: { 'Accept': 'application/json' },
      signal: local ? local.signal : undefined
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      if (res.status === 404) throw new ArchiveError('missing', 404);
      if (!res.ok) throw new ArchiveError('unavailable', res.status);
      return res.json().catch(function () { throw new ArchiveError('unavailable', res.status); });
    }, function (err) {
      if (timer) clearTimeout(timer);
      if (signal && signal.aborted) throw new ArchiveError('aborted');
      throw new ArchiveError('unavailable');
    });
  }

  function fetchListPage(cursor, signal) {
    var q = '?limit=' + PAGE_SIZE + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    return fetchJSON(apiUrl('/entries' + q), signal).then(function (page) {
      var entries = Array.isArray(page && page.entries) ? page.entries.map(cleanEntry).filter(Boolean) : [];
      var next = (page && typeof page.nextCursor === 'string' && page.nextCursor) ? page.nextCursor : null;
      return { entries: entries, nextCursor: next };
    });
  }

  // Follow the cursor through empty pages until something arrives or it ends.
  function fetchListFrom(cursor, signal) {
    var hops = 0;
    function step(c) {
      return fetchListPage(c, signal).then(function (page) {
        if (page.entries.length || !page.nextCursor || ++hops >= MAX_EMPTY_PAGES) return page;
        return step(page.nextCursor);
      });
    }
    return step(cursor);
  }

  function listIsFresh() {
    return list.loadedAt && (Date.now() - list.loadedAt) < LIST_STALE_MS && list.origin === archiveOrigin();
  }

  function ensureList(signal) {
    if (listIsFresh()) return Promise.resolve(list);
    return fetchListFrom(null, signal).then(function (page) {
      list = { entries: page.entries, nextCursor: page.nextCursor, loadedAt: Date.now(), origin: archiveOrigin() };
      return list;
    }, function (err) {
      // A closed gate reads as "nothing published yet", not as a fault.
      if (err.kind === 'missing') {
        list = { entries: [], nextCursor: null, loadedAt: Date.now(), origin: archiveOrigin() };
        return list;
      }
      throw err;
    });
  }

  function loadMore(signal) {
    if (!list.nextCursor) return Promise.resolve([]);
    return fetchListFrom(list.nextCursor, signal).then(function (page) {
      var seen = {};
      list.entries.forEach(function (e) { seen[e.id] = 1; });
      var fresh = page.entries.filter(function (e) { return !seen[e.id]; });
      list.entries = list.entries.concat(fresh);
      list.nextCursor = page.nextCursor;
      return fresh;
    });
  }

  function fetchEntry(id, signal) {
    if (entryCache[id] && entryCache[id].origin === archiveOrigin()) return Promise.resolve(entryCache[id].entry);
    return fetchJSON(apiUrl('/entries/' + encodeURIComponent(id)), signal).then(function (body) {
      var entry = cleanEntry(body && body.entry);
      if (!entry) throw new ArchiveError('unavailable');
      return fetchRemainingPhotos(entry, signal).then(function () {
        entryCache[id] = { entry: entry, origin: archiveOrigin() };
        return entry;
      });
    });
  }

  function fetchRemainingPhotos(entry, signal) {
    var hops = 0;
    function step() {
      if (!entry.nextPhotoCursor || hops++ >= MAX_PHOTO_PAGES) return Promise.resolve();
      var q = '?limit=' + PAGE_SIZE + '&cursor=' + encodeURIComponent(entry.nextPhotoCursor);
      return fetchJSON(apiUrl('/entries/' + encodeURIComponent(entry.id) + '/photos' + q), signal)
        .then(function (page) {
          var more = Array.isArray(page && page.photos) ? page.photos.map(cleanPhoto).filter(Boolean) : [];
          entry.photos = entry.photos.concat(more);
          entry.nextPhotoCursor = (page && typeof page.nextCursor === 'string' && page.nextCursor) ? page.nextCursor : null;
          return step();
        }, function () { entry.nextPhotoCursor = null; }); // show what arrived
    }
    return step();
  }

  /* ── Routing ─────────────────────────────────────────────── */

  function routeFromLocation() {
    var m = /[?&]entry=([^&#]*)/.exec(location.search);
    var id = '';
    if (m) { try { id = decodeURIComponent(m[1]); } catch (e) { id = ''; } }
    if (id && ID_PATTERN.test(id)) return { view: 'entry', id: id };
    return { view: 'index' };
  }

  function indexHref() { return 'playground.html'; }
  function entryHref(id) { return 'playground.html?entry=' + encodeURIComponent(id); }

  function samePath(anchor) {
    try {
      var url = new URL(anchor.href, location.href);
      return url.origin === location.origin && url.pathname === location.pathname && !url.hash;
    } catch (e) { return false; }
  }

  // Keep the reader's place in whichever view they leave, so back/forward
  // returns them to it (the shell swaps <main>, which would otherwise clamp it).
  function rememberScroll() {
    var state = history.state && typeof history.state === 'object' ? history.state : {};
    var next = {};
    for (var k in state) if (state.hasOwnProperty(k)) next[k] = state[k];
    next.pgScroll = window.scrollY || window.pageYOffset || 0;
    try { history.replaceState(next, '', location.href); } catch (e) { /* ignore */ }
  }

  function onDocumentClick(e) {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (!isPlaygroundPage() || !history.pushState) return;

    var a = e.target.closest ? e.target.closest('a') : null;
    if (!a || !a.href || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;

    rememberScroll();
    if (!samePath(a)) return;

    e.preventDefault();
    if (a.href === location.href) { window.scrollTo(0, 0); return; }

    var seeded = !!(history.state && history.state.shell);
    history.pushState({ shell: seeded, playground: true }, '', a.href);
    try { window.scrollTo({ top: 0, left: 0, behavior: 'instant' }); } catch (e2) { window.scrollTo(0, 0); }
    render({ focusHeading: true });
  }

  function onPopState() {
    // When the shell seeded this entry it will re-fetch the page and the
    // bootstrap will call mount(); otherwise the room routes itself.
    if (!isPlaygroundPage()) return;
    if (history.state && history.state.shell) return;
    render({ focusHeading: true, restoreScroll: true });
  }

  function bindOnce() {
    if (bound) return;
    bound = true;
    document.addEventListener('click', onDocumentClick);
    window.addEventListener('popstate', onPopState);
  }

  /* ── Stylesheet readiness (SPA entry appends the <link> late) ── */

  function whenStylesReady(cb) {
    var link = $('link[href$="css/playground.css"]');
    if (!link || link.sheet) { cb(); return; }
    var done = false;
    function finish() { if (done) return; done = true; cb(); }
    link.addEventListener('load', finish, { once: true });
    link.addEventListener('error', finish, { once: true });
    setTimeout(finish, 1500);
  }

  /* ── Shared pieces ───────────────────────────────────────── */

  function roomHeader() {
    return el('section', { className: 'pg-room', 'aria-labelledby': 'pg-title' }, [
      el('p', { className: 'hero-eyebrow', text: 'Writing' }),
      el('h1', { id: 'pg-title', text: ROOM_TITLE }),
      el('p', { className: 'pg-lede', text: 'My Life!' }),
      el('p', { className: 'pg-signal', 'data-signal': 'connecting' }, [
        el('span', { className: 'pg-signal-led', 'aria-hidden': 'true' }),
        el('span', { className: 'pg-signal-text', text: 'archive · connecting' })
      ])
    ]);
  }

  // The masthead's signal line mirrors the archive's state in words; the
  // LED beside it is decoration only.
  function setSignal(state, text) {
    var signal = $('.pg-signal');
    if (!signal) return;
    signal.setAttribute('data-signal', state);
    var t = $('.pg-signal-text', signal);
    if (t) t.textContent = text;
  }

  function signalCount() {
    var n = list.entries.length;
    var count = n + (n === 1 ? ' entry' : ' entries');
    if (list.nextCursor) count += ' shown';
    else if (n > 1) count = 'all ' + count;
    setSignal('online', 'archive online · ' + count);
  }

  function endMarker() {
    return el('p', { className: 'pg-end', text: 'end of archive' });
  }

  function statusNode() {
    return el('p', { className: 'pg-status', role: 'status', 'aria-live': 'polite' });
  }

  function stateBlock(kind, heading, text, action) {
    var block = el('section', { className: 'pg-state pg-enter', 'data-state': kind, 'aria-labelledby': 'pg-state-heading' }, [
      el('h2', { id: 'pg-state-heading', className: 'pg-state-heading', text: heading }),
      text ? el('p', { className: 'pg-state-text', text: text }) : null
    ]);
    if (action) block.appendChild(action);
    return block;
  }

  function retryButton(onRetry) {
    var b = el('button', { type: 'button', className: 'pg-button', text: 'Try again' });
    b.addEventListener('click', onRetry);
    return b;
  }

  function allWritingLink(className) {
    return el('a', { className: className || 'pg-all', href: indexHref(), text: 'All writing' });
  }

  function titleOf(entry, opts) {
    if (entry.title) return entry.title;
    return formatDay(entry.day, opts || {});
  }

  function showStatusLater(status, text, token) {
    return setTimeout(function () {
      if (token !== renderToken || !document.contains(status)) return;
      status.classList.add('pg-status--busy');
      status.textContent = text;
    }, LOADING_DELAY_MS);
  }

  function focusHeading(root) {
    var h = $('h1', root);
    if (!h) return;
    h.setAttribute('tabindex', '-1');
    try { h.focus({ preventScroll: true }); } catch (e) { h.focus(); }
  }

  /* ── Index view ──────────────────────────────────────────── */

  function tagNodes(holder, tags) {
    holder.appendChild(el('span', { className: 'visually-hidden', text: 'Tagged ' }));
    tags.forEach(function (tag, i) {
      if (i) holder.appendChild(document.createTextNode(' '));
      holder.appendChild(el('span', { className: 'pg-tag', text: tag.trim() }));
    });
    return holder;
  }

  function itemNode(entry) {
    var link = el('a', { className: 'pg-item-link', href: entryHref(entry.id) });
    link.appendChild(el('time', { className: 'pg-item-date', datetime: isoDay(entry.day), text: formatDay(entry.day, { year: false }) }));
    link.appendChild(entry.title
      ? el('h3', { className: 'pg-item-title', text: entry.title })
      : el('h3', { className: 'pg-item-title pg-item-title--untitled', text: 'Untitled' }));
    var excerpt = excerptOf(entry.content);
    if (excerpt) link.appendChild(el('p', { className: 'pg-item-excerpt', text: excerpt }));

    var foot = el('span', { className: 'pg-item-foot' });
    if (entry.tags.length) foot.appendChild(tagNodes(el('span', { className: 'pg-item-tags' }), entry.tags));
    foot.appendChild(el('span', { className: 'pg-item-more', 'aria-hidden': 'true', text: excerpt ? 'read' : 'view' }));
    link.appendChild(foot);
    return el('li', { className: 'pg-item' }, [link]);
  }

  function appendItems(container, entries) {
    var firstNew = null;
    entries.forEach(function (entry) {
      var year = String(entry.day.y);
      var section = $('.pg-year[data-year="' + year + '"]', container);
      if (!section) {
        section = el('section', { className: 'pg-year', 'data-year': year, 'aria-labelledby': 'pg-year-' + year }, [
          el('h2', { id: 'pg-year-' + year, className: 'pg-year-label', text: year }),
          el('ol', { className: 'pg-list' })
        ]);
        container.appendChild(section);
      }
      var li = itemNode(entry);
      $('.pg-list', section).appendChild(li);
      if (!firstNew) firstNew = $('a', li);
    });
    return firstNew;
  }

  function renderIndex(root, opts) {
    var token = ++renderToken;
    var signal = controller ? controller.signal : undefined;

    document.title = INDEX_TITLE;
    empty(root);

    var wrap = el('div', { className: 'site-wrap pg' });
    var view = el('section', { className: 'pg-index', 'aria-label': 'All pieces' });
    var status = statusNode();
    wrap.appendChild(roomHeader());
    wrap.appendChild(view);
    view.appendChild(status);
    root.appendChild(wrap);

    if (opts.focusHeading) focusHeading(root);

    var timer = showStatusLater(status, 'Loading…', token);

    ensureList(signal).then(function (data) {
      if (token !== renderToken) return;
      clearTimeout(timer);
      status.textContent = '';

      if (!data.entries.length) {
        setSignal('online', 'archive online · 0 entries');
        view.appendChild(stateBlock('empty', 'Nothing published yet.',
          'When there is something to read, it will be here — dated, and in order.'));
        return;
      }

      var years = el('div', { className: 'pg-years pg-enter' });
      appendItems(years, data.entries);
      view.appendChild(years);

      signalCount();
      var more = moreControl(view, years, status);
      view.appendChild(more || endMarker());

      if (opts.restoreScroll) restoreScroll();
    }).catch(function (err) {
      if (token !== renderToken || err.kind === 'aborted') return;
      clearTimeout(timer);
      status.textContent = '';
      setSignal('offline', 'archive · no signal');
      view.appendChild(stateBlock('unavailable', 'The archive isn’t reachable right now.',
        '',
        retryButton(function () { list.loadedAt = 0; render({}); })));
    });
  }

  function moreControl(view, years, status) {
    if (!list.nextCursor) return null;
    var holder = el('div', { className: 'pg-more' });
    var button = el('button', { type: 'button', className: 'pg-button', text: 'Older pieces' });
    holder.appendChild(button);

    button.addEventListener('click', function () {
      button.disabled = true;
      button.textContent = 'Loading…';
      var signal = controller ? controller.signal : undefined;
      loadMore(signal).then(function (fresh) {
        if (!document.contains(view)) return;
        var first = appendItems(years, fresh);
        signalCount();
        if (!list.nextCursor) {
          holder.parentNode.replaceChild(endMarker(), holder);
        } else {
          button.disabled = false;
          button.textContent = 'Older pieces';
        }
        status.classList.remove('pg-status--busy');
        status.textContent = fresh.length
          ? fresh.length + (fresh.length === 1 ? ' older piece added.' : ' older pieces added.')
          : 'That is everything.';
        if (first) { first.focus({ preventScroll: false }); }
      }).catch(function (err) {
        if (err.kind === 'aborted' || !document.contains(view)) return;
        button.disabled = false;
        button.textContent = 'Older pieces';
        status.classList.remove('pg-status--busy');
        status.textContent = 'Couldn’t reach the archive for older pieces. Try again in a moment.';
      });
    });
    return holder;
  }

  function restoreScroll() {
    var st = history.state;
    if (!st) return;
    // An entry this room pushed, reached again by traversal without a
    // remembered place, starts at the top rather than where the swap left it.
    var y = typeof st.pgScroll === 'number' ? st.pgScroll : (st.playground ? 0 : null);
    if (y === null) return;
    // Restoring a position is not a scroll the reader asked for: no easing.
    requestAnimationFrame(function () {
      try { window.scrollTo({ top: y, left: 0, behavior: 'instant' }); } catch (e) { window.scrollTo(0, y); }
    });
  }

  /* ── Article view ────────────────────────────────────────── */

  function figureNode(photo, entryTitle) {
    var fig = el('figure', { className: 'pg-figure' });
    var tall = photo.width && photo.height && (photo.height / photo.width) > 1.15;
    if (tall) fig.className += ' pg-figure--tall';

    var frame = el('span', { className: 'pg-figure-frame' });
    if (photo.width && photo.height) {
      frame.style.aspectRatio = photo.width + ' / ' + photo.height;
      frame.style.setProperty('--pg-ratio', String(photo.width / photo.height));
    }

    var img = el('img', {
      className: 'pg-photo',
      src: photo.url,
      alt: photo.altText || photo.caption || ('Photograph from “' + entryTitle + '”'),
      loading: 'lazy',
      decoding: 'async',
      referrerpolicy: 'no-referrer'
    });
    if (photo.width) img.width = photo.width;
    if (photo.height) img.height = photo.height;
    img.addEventListener('error', function () {
      fig.setAttribute('data-photo', 'unavailable');
      var note = el('span', { className: 'pg-photo-missing', role: 'img', 'aria-label': img.alt, text: 'This photograph isn’t available right now.' });
      frame.replaceChild(note, img);
    }, { once: true });
    img.addEventListener('load', function () { fig.setAttribute('data-photo', 'ready'); }, { once: true });

    frame.appendChild(img);
    fig.appendChild(frame);
    if (photo.caption) fig.appendChild(el('figcaption', { className: 'pg-caption', text: photo.caption }));
    return fig;
  }

  function neighboursOf(id) {
    var i = -1;
    for (var k = 0; k < list.entries.length; k++) if (list.entries[k].id === id) { i = k; break; }
    if (i < 0) return null;
    return { later: i > 0 ? list.entries[i - 1] : null, earlier: i + 1 < list.entries.length ? list.entries[i + 1] : null, last: i === list.entries.length - 1 };
  }

  function neighbourLink(label, entry, className) {
    return el('a', { className: 'pg-neighbour ' + className, href: entryHref(entry.id) }, [
      el('span', { className: 'pg-neighbour-label', text: label }),
      el('span', { className: 'pg-neighbour-title', text: titleOf(entry) }),
      el('time', { className: 'pg-neighbour-date', datetime: isoDay(entry.day), text: formatDay(entry.day) })
    ]);
  }

  function continueNav(entry, nav) {
    var n = neighboursOf(entry.id);
    empty(nav);
    var row = el('div', { className: 'pg-neighbours' });
    if (n && n.later)   row.appendChild(neighbourLink('Later', n.later, 'pg-neighbour--later'));
    if (n && n.earlier) row.appendChild(neighbourLink('Earlier', n.earlier, 'pg-neighbour--earlier'));
    if (row.childNodes.length) nav.appendChild(row);
    nav.appendChild(allWritingLink());
  }

  function renderArticle(root, id, opts) {
    var token = ++renderToken;
    var signal = controller ? controller.signal : undefined;

    empty(root);
    var wrap = el('div', { className: 'site-wrap pg' });
    var status = statusNode();
    wrap.appendChild(status);
    root.appendChild(wrap);

    var timer = showStatusLater(status, 'Loading…', token);

    fetchEntry(id, signal).then(function (entry) {
      if (token !== renderToken) return;
      clearTimeout(timer);
      status.textContent = '';

      var heading = titleOf(entry, { weekday: true });
      document.title = heading + ' — ' + AUTHOR;

      var head = el('header', { className: 'pg-article-head' });
      head.appendChild(el('p', { className: 'pg-kicker' }, [
        el('a', { href: indexHref(), text: ROOM_TITLE })
      ]));
      if (entry.title) {
        head.appendChild(el('time', { className: 'pg-date', datetime: isoDay(entry.day), text: formatDay(entry.day, { weekday: true }) }));
        head.appendChild(el('h1', {
          id: 'pg-article-title',
          className: entry.title.length > LONG_TITLE_CHARS ? 'pg-title--long' : null,
          text: entry.title
        }));
      } else {
        head.appendChild(el('h1', { id: 'pg-article-title' }, [
          el('time', { datetime: isoDay(entry.day), text: heading })
        ]));
      }
      head.appendChild(el('p', { className: 'pg-byline', text: AUTHOR + ' · ' + PLACE }));

      var article = el('article', { className: 'pg-article pg-enter', 'aria-labelledby': 'pg-article-title' }, [head]);

      var paras = paragraphsOf(entry.content);
      if (paras.length) {
        var prose = el('div', { className: 'pg-prose' });
        paras.forEach(function (p) { prose.appendChild(paragraphNode(p)); });
        article.appendChild(prose);
      }

      if (entry.photos.length) {
        var photos = el('div', { className: 'pg-photos', role: 'group', 'aria-label': 'Photographs' });
        entry.photos.forEach(function (ph) { photos.appendChild(figureNode(ph, heading)); });
        article.appendChild(photos);
      }

      if (!paras.length && !entry.photos.length) {
        article.appendChild(el('p', { className: 'pg-prose pg-wordless', text: 'This entry holds only its date.' }));
      }

      var foot = el('footer', { className: 'pg-article-foot' });
      if (entry.tags.length) {
        foot.appendChild(tagNodes(el('p', { className: 'pg-tags' }), entry.tags));
      }
      var published = dayFromInstant(entry.publishedAt);
      var updated   = dayFromInstant(entry.updatedAt);
      if (published && updated && isoDay(updated) !== isoDay(published) && updated.date > published.date) {
        foot.appendChild(el('p', { className: 'pg-updated' }, [
          document.createTextNode('Edited '),
          el('time', { datetime: isoDay(updated), text: formatDay(updated) })
        ]));
      }
      if (foot.childNodes.length) article.appendChild(foot);

      wrap.appendChild(article);

      var nav = el('nav', { className: 'pg-continue pg-enter', 'aria-label': 'Continue reading' });
      wrap.appendChild(nav);
      continueNav(entry, nav);

      if (opts.focusHeading) focusHeading(root);
      if (opts.restoreScroll) restoreScroll();

      // Neighbours come from the index; fetch it quietly if we arrived by deep link,
      // and reach one page further when this is the last piece we know of.
      var known = neighboursOf(entry.id);
      var need = !listIsFresh() || (known && known.last && list.nextCursor);
      if (need) {
        var p = listIsFresh() ? loadMore(signal) : ensureList(signal);
        p.then(function () {
          if (token !== renderToken || !document.contains(nav)) return;
          continueNav(entry, nav);
        }).catch(function () { /* the article stands on its own */ });
      }
    }).catch(function (err) {
      if (token !== renderToken || err.kind === 'aborted') return;
      clearTimeout(timer);
      status.textContent = '';
      document.title = (err.kind === 'missing' ? 'Not here' : 'Unavailable') + ' — ' + INDEX_TITLE;
      wrap.appendChild(el('p', { className: 'pg-kicker' }, [el('a', { href: indexHref(), text: ROOM_TITLE })]));
      if (err.kind === 'missing') {
        wrap.appendChild(stateBlock('missing', 'This piece isn’t here.',
          'It may have been taken back, or the link may be wrong.',
          allWritingLink('pg-button pg-button--link')));
      } else {
        wrap.appendChild(stateBlock('unavailable', 'The archive isn’t reachable right now.',
          '',
          retryButton(function () { render({}); })));
      }
      if (opts.focusHeading) {
        var h = $('.pg-state-heading', wrap);
        if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
      }
    });
  }

  /* ── Render dispatcher ───────────────────────────────────── */

  function render(opts) {
    opts = opts || {};
    var root = rootEl();
    if (!root) return;
    if (controller) try { controller.abort(); } catch (e) { /* ignore */ }
    controller = window.AbortController ? new AbortController() : null;

    var route = routeFromLocation();
    root.setAttribute('data-view', route.view);
    if (route.view === 'entry') renderArticle(root, route.id, opts);
    else renderIndex(root, opts);
  }

  /* ── Lifecycle ───────────────────────────────────────────── */

  function mount() {
    var root = rootEl();
    if (!root || !isPlaygroundPage()) { unmount(); return; }
    bindOnce();
    // The shell focuses the page's static h1 after a swap; carry that focus
    // over to the heading the room renders.
    var active = document.activeElement;
    var fromShell = !!(active && active.tagName === 'H1');
    whenStylesReady(function () {
      if (!document.contains(root)) return;
      render({ focusHeading: fromShell, restoreScroll: true });
    });
  }

  function unmount() {
    if (controller) try { controller.abort(); } catch (e) { /* ignore */ }
    controller = null;
    renderToken++;
  }

  window.CE_PLAYGROUND = { mount: mount, unmount: unmount };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
})();
