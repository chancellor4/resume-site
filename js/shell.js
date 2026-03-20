/*
  shell.js — Chancellor Edwards
  SPA shell router: intercepts same-origin navigation, swaps page content
  via fetch + DOM replacement, keeps the vinyl player iframe alive across
  page transitions so audio playback is truly continuous.

  Progressive enhancement: if pushState, fetch, or DOMParser are absent
  the script bails silently and normal MPA navigation takes over.

  v1.0.0
*/
(function () {
  'use strict';

  /* ── Feature gate ────────────────────────────────────────── */
  if (!window.history || !window.history.pushState) return;
  if (!window.fetch) return;
  if (!window.DOMParser) return;

  /* ── Constants ───────────────────────────────────────────── */
  var PERSIST_SCRIPTS = ['js/refined.js', 'js/vinyl.js', 'js/shell.js'];
  var transitioning   = false;

  /* ── Helpers ─────────────────────────────────────────────── */

  /**
   * Determine whether an anchor element targets an internal page
   * that should be handled by the SPA router.
   */
  function isInternalLink(anchor) {
    if (!anchor || !anchor.href) return false;
    if (anchor.target && anchor.target !== '_self') return false;
    if (anchor.hasAttribute('download')) return false;

    try {
      var url = new URL(anchor.href, location.origin);
      if (url.origin !== location.origin) return false;
      // Same page — let browser scroll to hash or no-op
      if (url.pathname === location.pathname) return false;
      // Only intercept .html pages and bare directory paths
      var path = url.pathname;
      if (/\.html?$/i.test(path)) return true;
      if (/\/$/.test(path)) return true;
      // Bare path with no extension (e.g. /about)
      if (path.indexOf('.') === -1) return true;
      return false;
    } catch (e) { return false; }
  }

  /**
   * Extract the filename portion of a URL for nav-active matching.
   */
  function filenameOf(url) {
    try {
      var parts = new URL(url, location.origin).pathname.split('/');
      return parts[parts.length - 1] || 'index.html';
    } catch (e) { return ''; }
  }

  /**
   * Toggle the nav-active class on navigation links to reflect
   * the current page.
   */
  function updateNavActive(url) {
    var target = filenameOf(url);
    var links  = document.querySelectorAll('.nav-links a');

    for (var i = 0; i < links.length; i++) {
      var href  = links[i].getAttribute('href') || '';
      var match = (href === target) ||
                  (target === '' && href === 'index.html') ||
                  (target === 'index.html' && href === 'index.html');
      if (match) {
        links[i].classList.add('nav-active');
      } else {
        links[i].classList.remove('nav-active');
      }
    }
  }

  /**
   * ES5-safe closest('a') fallback.
   */
  function closestAnchor(el) {
    while (el && el.tagName !== 'A') el = el.parentElement;
    return el;
  }

  /**
   * Collect inline script source from a parsed document,
   * skipping persistent shell scripts and JSON-LD blocks.
   */
  function collectPageScripts(doc) {
    var all     = doc.querySelectorAll('script');
    var sources = [];

    for (var i = 0; i < all.length; i++) {
      var s = all[i];
      // Skip structured data
      if (s.type === 'application/ld+json') continue;

      var src  = s.getAttribute('src') || '';
      var skip = false;

      for (var j = 0; j < PERSIST_SCRIPTS.length; j++) {
        if (src.indexOf(PERSIST_SCRIPTS[j]) !== -1) { skip = true; break; }
      }
      if (skip) continue;

      // Only capture inline scripts with content
      if (!src && s.textContent && s.textContent.trim()) {
        sources.push(s.textContent);
      }
    }
    return sources;
  }

  /**
   * Execute an array of script source strings by injecting
   * ephemeral <script> elements into the document.
   */
  function runScripts(sources) {
    for (var i = 0; i < sources.length; i++) {
      try {
        var el = document.createElement('script');
        el.textContent = sources[i];
        document.body.appendChild(el);
        document.body.removeChild(el);
      } catch (e) {
        console.warn('[shell] script execution error:', e);
      }
    }
  }

  /* ── Core: fetch + swap ──────────────────────────────────── */

  function navigate(url, push) {
    if (transitioning) return;
    transitioning = true;

    fetch(url, { credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then(function (html) {
        var doc       = new DOMParser().parseFromString(html, 'text/html');
        var newHeader = doc.querySelector('header');
        var newMain   = doc.querySelector('main');

        if (!newHeader || !newMain) throw new Error('content missing');

        // Gather page-specific scripts before DOM adoption
        var pageScripts = collectPageScripts(doc);

        // ── Swap header ──
        var curHeader = document.querySelector('header');
        if (curHeader) {
          curHeader.parentNode.replaceChild(
            document.adoptNode(newHeader), curHeader
          );
        }

        // ── Swap main ──
        var curMain = document.querySelector('main');
        if (curMain) {
          curMain.parentNode.replaceChild(
            document.adoptNode(newMain), curMain
          );
        }

        // ── Update document title ──
        var newTitle = doc.querySelector('title');
        if (newTitle) document.title = newTitle.textContent;

        // ── Update canonical link ──
        var newCanonical = doc.querySelector('link[rel="canonical"]');
        var curCanonical = document.querySelector('link[rel="canonical"]');
        if (newCanonical && curCanonical) {
          curCanonical.setAttribute('href', newCanonical.getAttribute('href'));
        }

        // ── Update structured data ──
        var oldLD = document.querySelectorAll('head script[type="application/ld+json"]');
        for (var i = 0; i < oldLD.length; i++) {
          oldLD[i].parentNode.removeChild(oldLD[i]);
        }
        var newLD = doc.querySelectorAll('script[type="application/ld+json"]');
        for (var j = 0; j < newLD.length; j++) {
          document.head.appendChild(document.adoptNode(newLD[j]));
        }

        // ── Update meta description ──
        var newDesc = doc.querySelector('meta[name="description"]');
        var curDesc = document.querySelector('meta[name="description"]');
        if (newDesc && curDesc) {
          curDesc.setAttribute('content', newDesc.getAttribute('content'));
        }

        // ── Nav active state ──
        updateNavActive(url);

        // ── History ──
        if (push) {
          history.pushState({ shell: true }, '', url);
        }

        // ── Scroll to top ──
        window.scrollTo(0, 0);

        // ── Accessibility: focus the page heading ──
        var heading = document.querySelector('header h1') ||
                      document.querySelector('main h1');
        if (heading) {
          heading.setAttribute('tabindex', '-1');
          heading.focus({ preventScroll: true });
        }

        // ── Execute page-specific scripts ──
        runScripts(pageScripts);

        transitioning = false;
      })
      .catch(function (err) {
        // Graceful fallback: let the browser handle navigation normally
        console.warn('[shell] SPA nav failed, falling back:', err);
        transitioning = false;
        location.href = url;
      });
  }

  /* ── Event binding ───────────────────────────────────────── */

  // Delegated click handler for all internal links
  document.addEventListener('click', function (e) {
    // Modifier keys → let browser handle (new tab, save, etc.)
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (e.defaultPrevented) return;

    var anchor = e.target.closest
      ? e.target.closest('a')
      : closestAnchor(e.target);

    if (!isInternalLink(anchor)) return;

    e.preventDefault();
    navigate(anchor.href, true);
  });

  // Back/forward button support
  window.addEventListener('popstate', function () {
    navigate(location.href, false);
  });

  // Seed history state for the initial page load
  history.replaceState({ shell: true }, '', location.href);

})();
