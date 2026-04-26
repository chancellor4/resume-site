/*
  news-surface.js — Chancellor Edwards
  Ambient News Surface (v1.1) — homepage render layer.

  Design intent
  -------------
  A calm, image-aware newsstand that lives quietly beneath the Fountain
  Clock and never competes with it. The browser never fetches publisher
  RSS — it reads a single committed snapshot at /assets/news.json
  (or the inline shim window.__NEWS_SNAPSHOT__ when present).

  Two card variants share one component:
    • image-led — when imageUrl is present and loads successfully.
    • text-led  — when imageUrl is null OR the image fails to load.
  The image well reserves aspect-ratio space, so an onerror swap
  introduces no layout shift.

  Architecture
  ------------
  - Single IIFE; exposes window.CE_NEWS.{mount, unmount} so the SPA
    shell (js/shell.js) can re-bind after DOM swaps.
  - If the page lacks [data-news-surface], the module stays inert.
  - Snapshot loaded from window.__NEWS_SNAPSHOT__ (preferred) or
    fetch('assets/news.json') as a fallback. Empty/error → quiet section.
  - Rendering is surgical: build a DocumentFragment once, swap it in.
  - Honors data-mode="dnd" and prefers-reduced-motion via CSS only.
*/
(function () {
  'use strict';

  if (typeof document === 'undefined') return;

  /* ── Constants ───────────────────────────────────────────── */

  var SNAPSHOT_URL     = 'assets/news.json';
  var ITEM_CAP         = 12;
  var FETCH_TIMEOUT_MS = 4000;

  var ALLOWED_SOURCE_TYPES = {
    'fashion-authority': 1,
    'fashion-business':  1,
    'youth-culture':     1,
    'global-affairs':    1,
    'world-news':        1
  };

  var SOURCE_TYPE_LABELS = {
    'fashion-authority': 'Fashion',
    'fashion-business':  'Business',
    'youth-culture':     'Culture',
    'global-affairs':    'Global',
    'world-news':        'World'
  };

  /* ── State ───────────────────────────────────────────────── */

  var inflight = null;

  /* ── Tiny helpers ────────────────────────────────────────── */

  function $(sel, root) { return (root || document).querySelector(sel); }

  /* Snapshot delivery has two channels:
       1. Inline global (assets/news-snapshot.js) — primary path.
          Loaded as a normal <script> with the page itself, so it works
          under file://, costs zero extra requests in production, and
          is race-free with our render.
       2. fetch(assets/news.json) — fallback for the rare case the
          shim wasn't included or hasn't loaded yet. */
  function loadSnapshot() {
    if (window.__NEWS_SNAPSHOT__ && typeof window.__NEWS_SNAPSHOT__ === 'object') {
      return Promise.resolve(window.__NEWS_SNAPSHOT__);
    }
    if (!window.fetch) return Promise.reject(new Error('no fetch'));
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, FETCH_TIMEOUT_MS) : null;
    var url = SNAPSHOT_URL + '?v=' + Math.floor(Date.now() / (5 * 60 * 1000));
    return fetch(url, { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (r) {
        if (!r.ok) throw new Error('snapshot ' + r.status);
        return r.json();
      })
      .then(function (j) { if (timer) clearTimeout(timer); return j; })
      .catch(function (e) { if (timer) clearTimeout(timer); throw e; });
  }

  function isHttpUrl(u) {
    if (typeof u !== 'string' || u.length < 8) return false;
    return u.indexOf('http://') === 0 || u.indexOf('https://') === 0;
  }
  function isHttpsUrl(u) {
    return typeof u === 'string' && u.indexOf('https://') === 0;
  }

  function isValidItem(it) {
    if (!it || typeof it !== 'object') return false;
    if (typeof it.title !== 'string' || !it.title) return false;
    if (typeof it.source !== 'string' || !it.source) return false;
    if (!ALLOWED_SOURCE_TYPES[it.sourceType]) return false;
    if (!isHttpUrl(it.link)) return false;
    if (typeof it.publishedAt !== 'string' || isNaN(Date.parse(it.publishedAt))) return false;
    return true;
  }

  /* Quiet relative-time formatter. Stays in past tense. */
  function relativeTime(iso) {
    var then = Date.parse(iso);
    if (isNaN(then)) return '';
    var diffMin = Math.max(0, Math.round((Date.now() - then) / 60000));
    if (diffMin < 1)    return 'just now';
    if (diffMin < 60)   return diffMin + 'm ago';
    var hours = Math.round(diffMin / 60);
    if (hours < 24)     return hours + 'h ago';
    var days = Math.round(hours / 24);
    if (days < 7)       return days + 'd ago';
    try {
      return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch (e) { return ''; }
  }

  /* ── Card builders ───────────────────────────────────────── */

  function makeEyebrow(it) {
    var chips = document.createElement('span');
    chips.className = 'news-chips';

    var source = document.createElement('span');
    source.className = 'news-chip news-chip-source';
    source.textContent = it.source;
    chips.appendChild(source);

    var category = document.createElement('span');
    category.className = 'news-chip news-chip-category';
    category.textContent = SOURCE_TYPE_LABELS[it.sourceType] || 'News';
    chips.appendChild(category);

    return chips;
  }

  function makeBody(it) {
    var body = document.createElement('span');
    body.className = 'news-body';

    body.appendChild(makeEyebrow(it));

    var titleEl = document.createElement('h3');
    titleEl.className = 'news-title';
    titleEl.textContent = it.title;
    body.appendChild(titleEl);

    var foot = document.createElement('span');
    foot.className = 'news-foot';

    var time = document.createElement('time');
    time.className = 'news-time';
    time.dateTime = it.publishedAt;
    time.textContent = relativeTime(it.publishedAt);
    foot.appendChild(time);

    var arrow = document.createElement('span');
    arrow.className = 'news-affordance';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = 'Open original ↗';
    foot.appendChild(arrow);

    body.appendChild(foot);
    return body;
  }

  function makeImageWell(it, onFail) {
    var well = document.createElement('span');
    well.className = 'news-image-well';

    var img = document.createElement('img');
    img.className = 'news-image';
    img.src = it.imageUrl;
    img.alt = ''; // decorative — title sits in the same link
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    // Locks the intrinsic 16:10 aspect-ratio for browsers that don't
    // honor CSS aspect-ratio yet. Pixel values are nominal — the well's
    // CSS positions the image to fill its frame.
    img.width = 800;
    img.height = 500;
    img.addEventListener('error', function () { onFail(); }, { once: true });

    var overlay = document.createElement('span');
    overlay.className = 'news-image-overlay';
    overlay.setAttribute('aria-hidden', 'true');

    well.appendChild(img);
    well.appendChild(overlay);
    return well;
  }

  function makeFallbackWell(it) {
    var well = document.createElement('span');
    well.className = 'news-image-well news-image-fallback';
    well.setAttribute('aria-hidden', 'true');

    var mark = document.createElement('span');
    mark.className = 'news-fallback-mark';
    mark.textContent = SOURCE_TYPE_LABELS[it.sourceType] || 'News';

    var source = document.createElement('span');
    source.className = 'news-fallback-source';
    source.textContent = it.source;

    well.appendChild(mark);
    well.appendChild(source);
    return well;
  }

  function makeCard(it) {
    var card = document.createElement('article');
    card.className = 'news-item';
    card.setAttribute('data-source', it.source);
    card.setAttribute('data-source-type', it.sourceType);

    var hasImage = isHttpsUrl(it.imageUrl);
    card.setAttribute('data-variant', hasImage ? 'image' : 'fallback');

    var link = document.createElement('a');
    link.className = 'news-link';
    link.href = it.link;
    link.target = '_blank';
    link.rel = 'noopener noreferrer external';
    // Screen-reader label so the link announces source + title together.
    link.setAttribute('aria-label', it.source + ': ' + it.title);

    if (hasImage) {
      var well = makeImageWell(it, function () {
        // Image failed — swap to the reserved fallback well without
        // changing the card's aspect-ratio footprint.
        card.setAttribute('data-variant', 'fallback');
        if (well.parentNode === link) link.replaceChild(makeFallbackWell(it), well);
      });
      link.appendChild(well);
    } else {
      link.appendChild(makeFallbackWell(it));
    }
    link.appendChild(makeBody(it));

    card.appendChild(link);
    return card;
  }

  /* ── Render ──────────────────────────────────────────────── */

  function renderEmpty(root) {
    root.setAttribute('hidden', '');
    root.setAttribute('data-state', 'empty');
  }

  function renderItems(root, items) {
    var listEl = $('[data-news-list]', root);
    if (!listEl) return;

    var frag = document.createDocumentFragment();
    items.slice(0, ITEM_CAP).forEach(function (it) {
      frag.appendChild(makeCard(it));
    });

    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    listEl.appendChild(frag);

    root.removeAttribute('hidden');
    root.setAttribute('data-state', 'ready');

    var asof = $('[data-news-asof]', root);
    if (asof && items.length) {
      asof.textContent = 'Updated ' + relativeTime(items[0].publishedAt);
    }
  }

  /* ── Lifecycle ───────────────────────────────────────────── */

  function mount() {
    var root = $('[data-news-surface]');
    if (!root) {
      if (inflight && inflight.abort) try { inflight.abort(); } catch (e) {}
      inflight = null;
      return;
    }

    root.setAttribute('data-state', 'loading');

    if (inflight && inflight.abort) try { inflight.abort(); } catch (e) {}
    var p = loadSnapshot();
    inflight = p;

    p.then(function (snap) {
      if (inflight !== p) return;
      var items = (snap && Array.isArray(snap.items)) ? snap.items.filter(isValidItem) : [];
      if (items.length === 0) { renderEmpty(root); return; }
      renderItems(root, items);
    }).catch(function () {
      // Fail-silent: keep the homepage unchanged.
      renderEmpty(root);
    });
  }

  function unmount() {
    if (inflight && inflight.abort) try { inflight.abort(); } catch (e) {}
    inflight = null;
  }

  window.CE_NEWS = { mount: mount, unmount: unmount };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
})();
