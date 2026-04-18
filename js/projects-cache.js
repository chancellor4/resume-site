/*
  projects-cache.js — Chancellor Edwards

  Snapshot-first loader for the Playground.
  The page should never strand the user in skeleton boxes:
  snapshot first, inline fallback second, quiet live refresh third.
*/
(function () {
  'use strict';

  var SNAPSHOT_URL = 'assets/projects.json';
  var SNAPSHOT_INLINE_ID = 'playgroundSnapshotFallback';
  var GITHUB_USER = 'chancellor4';
  var API_BASE = 'https://api.github.com';
  var FETCH_TIMEOUT = 8000;
  var MAX_REPOS = 16;
  var MAX_FILTER_PILLS = 5;
  var FILE_PROTOCOL = location.protocol === 'file:';

  var state = {
    allRepos: [],
    activeLang: 'all',
    activeSort: 'updated',
    fetchedAt: null,
    freshnessTimer: null,
    hasBoundControls: false
  };

  function $(id) { return document.getElementById(id); }
  function show(id) { var el = $(id); if (el) el.hidden = false; }
  function hide(id) { var el = $(id); if (el) el.hidden = true; }

  function esc(str) {
    if (str === null || str === undefined) return '';
    var el = document.createElement('span');
    el.textContent = String(str);
    return el.innerHTML;
  }

  function safeUrl(url) {
    if (!url || typeof url !== 'string') return '';
    var trimmed = url.trim().toLowerCase();
    if (trimmed.indexOf('https://') === 0 || trimmed.indexOf('http://') === 0) return url;
    return '';
  }

  function isRepoArray(data) {
    return Array.isArray(data) &&
      (data.length === 0 || (data[0] && typeof data[0].name === 'string'));
  }

  function normalizeRepo(repo, index) {
    var normalized = repo || {};
    return {
      name: normalized.name || ('Repository ' + (index + 1)),
      description: normalized.description || '',
      html_url: safeUrl(normalized.html_url),
      homepage: safeUrl(normalized.homepage),
      language: normalized.language || '',
      stargazers_count: typeof normalized.stargazers_count === 'number' ? normalized.stargazers_count : 0,
      forks_count: typeof normalized.forks_count === 'number' ? normalized.forks_count : 0,
      topics: Array.isArray(normalized.topics) ? normalized.topics.filter(Boolean) : [],
      updated_at: normalized.updated_at || '',
      fork: !!normalized.fork,
      private: !!normalized.private,
      size: typeof normalized.size === 'number' ? normalized.size : 0
    };
  }

  function normalizeRepos(repos) {
    if (!isRepoArray(repos)) return [];
    return repos.map(normalizeRepo).filter(function (repo) {
      return repo && typeof repo.name === 'string' && repo.name;
    });
  }

  function timeAgo(dateStr) {
    var ts = new Date(dateStr).getTime();
    if (isNaN(ts)) return '';
    var diff = Date.now() - ts;
    if (diff < 0) return 'just now';
    var mins = Math.floor(diff / 60000);
    var hours = Math.floor(diff / 3600000);
    var days = Math.floor(diff / 86400000);
    var weeks = Math.floor(days / 7);
    var months = Math.floor(days / 30);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    if (hours < 24) return hours + 'h ago';
    if (days < 7) return days + 'd ago';
    if (weeks < 5) return weeks + 'w ago';
    return months + 'mo ago';
  }

  var LANG_COLORS = {
    'JavaScript': '#b8834a',
    'TypeScript': '#4f3a25',
    'Python': '#6b5a3e',
    'HTML': '#a06428',
    'CSS': '#8c7558',
    'Java': '#5a3e1b',
    'C#': '#4f3a25',
    'Ruby': '#7a4422',
    'Go': '#5a6e4e',
    'Shell': '#6b5a3e',
    'Swift': '#a06428',
    'Kotlin': '#6b5a3e',
    'Rust': '#5a3e1b',
    'Vue': '#5a6e4e',
    'PHP': '#6b5a3e',
    'Jupyter Notebook': '#8c6538',
    'Dockerfile': '#7a6548',
    'SCSS': '#8c7558',
    'Makefile': '#6b5a3e'
  };

  function langColor(lang) {
    return LANG_COLORS[lang] || '#8c7558';
  }

  function parseInlineSnapshot() {
    var node = $(SNAPSHOT_INLINE_ID);
    if (!node) return [];
    try {
      var parsed = JSON.parse(node.textContent || '{}');
      return normalizeRepos(parsed.repos || []);
    } catch (err) {
      console.warn('[playground] inline snapshot malformed:', err);
      return [];
    }
  }

  function requestJson(url) {
    if (!FILE_PROTOCOL) {
      return fetch(url, { cache: 'no-cache' }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      });
    }

    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.onload = function () {
        if (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch (err) {
            reject(err);
          }
        } else {
          reject(new Error('XHR ' + xhr.status));
        }
      };
      xhr.onerror = function () { reject(new Error('XHR network error')); };
      xhr.send();
    });
  }

  function resetView() {
    show('gh-loading');
    hide('gh-controls');
    hide('gh-repo-list');
    hide('gh-view-all');
    hide('gh-lang-bar-wrap');
    hide('gh-freshness');

    var repoList = $('gh-repo-list');
    if (repoList) repoList.innerHTML = '';

    var langBar = $('gh-lang-bar');
    if (langBar) langBar.innerHTML = '';

    var legend = $('gh-lang-legend');
    if (legend) legend.innerHTML = '';

    var pills = $('gh-filter-pills');
    if (pills) pills.innerHTML = '<button class="gh-pill gh-pill-active" data-lang="all" aria-pressed="true">All</button>';

    var sort = $('gh-sort');
    if (sort) sort.value = 'updated';

    var freshness = $('gh-freshness-text');
    if (freshness) freshness.textContent = '';
  }

  function renderEmptyState(message) {
    clearSkeletonAndLoading();
    show('gh-repo-list');
    hide('gh-view-all');
    hide('gh-controls');

    var container = $('gh-repo-list');
    if (container) {
      container.innerHTML = ''
        + '<article class="gh-empty-card">'
        + '  <h3>No repositories available</h3>'
        + '  <p>' + esc(message) + '</p>'
        + '</article>';
    }

    renderStats([]);
  }

  function clearSkeletonAndLoading() {
    hide('gh-loading');

    var stats = ['stat-repos', 'stat-stars', 'stat-forks', 'stat-languages'];
    for (var i = 0; i < stats.length; i++) {
      var stat = $(stats[i]);
      if (stat) {
        stat.classList.remove('gh-skeleton', 'gh-skeleton-text');
        stat.style.removeProperty('width');
      }
    }
  }

  function renderStats(repos) {
    var ownRepos = repos.filter(function (r) { return r && !r.fork; });
    var totalStars = 0;
    var totalForks = 0;
    var langCounts = {};

    ownRepos.forEach(function (repo) {
      totalStars += repo.stargazers_count || 0;
      totalForks += repo.forks_count || 0;
      if (repo.language) langCounts[repo.language] = (langCounts[repo.language] || 0) + (repo.size || 1);
    });

    var uniqueLangs = Object.keys(langCounts);
    var elRepos = $('stat-repos');
    var elStars = $('stat-stars');
    var elForks = $('stat-forks');
    var elLangs = $('stat-languages');

    if (elRepos) elRepos.textContent = ownRepos.length;
    if (elStars) elStars.textContent = totalStars;
    if (elForks) elForks.textContent = totalForks;
    if (elLangs) elLangs.textContent = uniqueLangs.length;

    [elRepos, elStars, elForks, elLangs].forEach(function (node) {
      if (!node) return;
      node.classList.remove('gh-skeleton', 'gh-skeleton-text');
      node.style.removeProperty('width');
    });

    var barEl = $('gh-lang-bar');
    var legendEl = $('gh-lang-legend');
    if (!barEl || !legendEl) return;

    if (!uniqueLangs.length) {
      barEl.innerHTML = '';
      legendEl.innerHTML = '';
      hide('gh-lang-bar-wrap');
      return;
    }

    var totalSize = 0;
    uniqueLangs.forEach(function (lang) { totalSize += langCounts[lang]; });
    if (!totalSize) {
      hide('gh-lang-bar-wrap');
      return;
    }

    uniqueLangs.sort(function (a, b) {
      return langCounts[b] - langCounts[a];
    });

    barEl.innerHTML = uniqueLangs.map(function (lang) {
      var pct = ((langCounts[lang] / totalSize) * 100).toFixed(1);
      return '<div class="gh-lang-segment" style="width:' + pct + '%;background:' + langColor(lang) + '" title="' + esc(lang) + ' ' + pct + '%"></div>';
    }).join('');

    legendEl.innerHTML = uniqueLangs.slice(0, 6).map(function (lang) {
      var pct = ((langCounts[lang] / totalSize) * 100).toFixed(1);
      return '<span class="gh-lang-legend-item"><span class="gh-lang-dot" style="background:' + langColor(lang) + '"></span>' + esc(lang) + ' <span class="gh-lang-pct">' + pct + '%</span></span>';
    }).join('');

    show('gh-lang-bar-wrap');
  }

  function bindRepoControls() {
    if (state.hasBoundControls) return;
    state.hasBoundControls = true;

    var pillsEl = $('gh-filter-pills');
    if (pillsEl) {
      pillsEl.addEventListener('click', function (e) {
        var btn = e.target.closest && e.target.closest('.gh-pill');
        if (!btn) return;

        state.activeLang = btn.getAttribute('data-lang') || 'all';

        var pills = pillsEl.querySelectorAll('.gh-pill');
        for (var i = 0; i < pills.length; i++) {
          pills[i].classList.remove('gh-pill-active');
          pills[i].setAttribute('aria-pressed', 'false');
        }

        btn.classList.add('gh-pill-active');
        btn.setAttribute('aria-pressed', 'true');
        applyRepoView();
      });
    }

    var sortEl = $('gh-sort');
    if (sortEl) {
      sortEl.addEventListener('change', function (e) {
        state.activeSort = e.target.value || 'updated';
        applyRepoView();
      });
    }

    var refreshBtn = $('gh-refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        refreshLive(true);
      });
    }
  }

  function renderRepoActions(repo) {
    var sourceUrl = safeUrl(repo.html_url);
    var liveUrl = safeUrl(repo.homepage);
    var actions = [];

    if (sourceUrl) {
      actions.push('<a href="' + esc(sourceUrl) + '" class="gh-repo-action gh-repo-action-primary" target="_blank" rel="noopener noreferrer">Source &#8599;</a>');
    }

    if (liveUrl) {
      actions.push('<a href="' + esc(liveUrl) + '" class="gh-repo-action" target="_blank" rel="noopener noreferrer">Live &#8599;</a>');
    }

    if (!actions.length) return '';
    return '<div class="gh-repo-actions">' + actions.join('') + '</div>';
  }

  function renderRepos(repos) {
    state.allRepos = normalizeRepos(repos).filter(function (repo) {
      return !repo.fork && (safeUrl(repo.html_url) || safeUrl(repo.homepage));
    });

    clearSkeletonAndLoading();

    if (!state.allRepos.length) {
      renderEmptyState('The project feed is temporarily unavailable. The Playground shell is still here, but the repository catalog did not return any items.');
      return;
    }

    var langs = {};
    state.allRepos.forEach(function (repo) {
      if (repo.language) langs[repo.language] = (langs[repo.language] || 0) + 1;
    });

    var sortedLangs = Object.keys(langs).sort(function (a, b) {
      return langs[b] - langs[a];
    });

    var pillsEl = $('gh-filter-pills');
    if (pillsEl) {
      pillsEl.innerHTML = '<button class="gh-pill gh-pill-active" data-lang="all" aria-pressed="true">All</button>' +
        sortedLangs.slice(0, MAX_FILTER_PILLS).map(function (lang) {
          return '<button class="gh-pill" data-lang="' + esc(lang) + '" aria-pressed="false">' + esc(lang) + '</button>';
        }).join('');
    }

    show('gh-controls');
    show('gh-repo-list');
    applyRepoView();
  }

  function applyRepoView() {
    var filtered = state.activeLang !== 'all'
      ? state.allRepos.filter(function (repo) { return repo.language === state.activeLang; })
      : state.allRepos.slice();

    if (state.activeSort === 'stars') {
      filtered.sort(function (a, b) { return (b.stargazers_count || 0) - (a.stargazers_count || 0); });
    } else if (state.activeSort === 'name') {
      filtered.sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
    } else {
      filtered.sort(function (a, b) { return new Date(b.updated_at || 0) - new Date(a.updated_at || 0); });
    }

    var display = filtered.slice(0, MAX_REPOS);
    var container = $('gh-repo-list');
    if (!container) return;

    if (!display.length) {
      container.innerHTML = '<article class="gh-empty-card"><h3>No repositories match this view</h3><p>Try another language filter or sort mode.</p></article>';
      hide('gh-view-all');
      return;
    }

    container.innerHTML = display.map(function (repo) {
      var sourceUrl = safeUrl(repo.html_url);
      var liveUrl = safeUrl(repo.homepage);
      var primaryUrl = sourceUrl || liveUrl;
      var lang = repo.language
        ? '<span class="gh-repo-lang"><span class="gh-lang-dot" style="background:' + langColor(repo.language) + '"></span>' + esc(repo.language) + '</span>'
        : '';
      var stars = repo.stargazers_count > 0 ? '<span class="gh-repo-stat">&#9734; ' + repo.stargazers_count + '</span>' : '';
      var forks = repo.forks_count > 0 ? '<span class="gh-repo-stat">&#9094; ' + repo.forks_count + '</span>' : '';
      var topics = repo.topics.length
        ? '<div class="gh-topics">' + repo.topics.slice(0, 4).map(function (topic) {
            return '<span class="gh-topic">' + esc(topic) + '</span>';
          }).join('') + '</div>'
        : '';
      var updated = timeAgo(repo.updated_at);
      var footer = (lang || stars || forks || updated)
        ? '<div class="gh-repo-footer">' + lang + stars + forks + (updated ? '<span class="gh-repo-updated">Updated ' + updated + '</span>' : '') + '</div>'
        : '';
      var title = primaryUrl
        ? '<a href="' + esc(primaryUrl) + '" class="gh-repo-name" target="_blank" rel="noopener noreferrer">' + esc(repo.name) + '</a>'
        : '<span class="gh-repo-name gh-repo-name-static">' + esc(repo.name) + '</span>';
      var cardLink = primaryUrl
        ? '<a href="' + esc(primaryUrl) + '" class="gh-repo-card-link" target="_blank" rel="noopener noreferrer" aria-label="Open ' + esc(repo.name) + '"></a>'
        : '';

      return ''
        + '<article class="gh-repo-card">'
        + cardLink
        + '  <div class="gh-repo-card-header">'
        + title
        + '    <span class="gh-repo-visibility">' + (repo.private ? 'Private' : 'Public') + '</span>'
        + '  </div>'
        + '  <p class="gh-repo-desc">' + (repo.description ? esc(repo.description) : '<span class="gh-no-desc">A quiet repository with no description yet.</span>') + '</p>'
        + topics
        + renderRepoActions(repo)
        + footer
        + '</article>';
    }).join('');

    var viewAll = $('gh-view-all');
    if (viewAll) viewAll.hidden = display.length >= state.allRepos.length;
  }

  function updateFreshnessText(source) {
    if (!state.fetchedAt) return;
    var el = $('gh-freshness-text');
    if (!el) return;

    var sourceLabel = source === 'live'
      ? 'Live GitHub'
      : source === 'inline'
        ? 'Embedded fallback'
        : 'Snapshot';

    el.textContent = sourceLabel + ' · updated ' + timeAgo(state.fetchedAt.toISOString());
  }

  function showFreshness(source) {
    state.fetchedAt = new Date();
    show('gh-freshness');
    updateFreshnessText(source);

    if (state.freshnessTimer) clearInterval(state.freshnessTimer);
    state.freshnessTimer = setInterval(function () {
      updateFreshnessText(source);
    }, 30000);
  }

  function fetchSnapshot() {
    return requestJson(SNAPSHOT_URL).then(function (json) {
      if (!json || !Array.isArray(json.repos)) throw new Error('snapshot malformed');
      var repos = normalizeRepos(json.repos);
      if (!repos.length) throw new Error('snapshot empty');
      return repos;
    });
  }

  function fetchLive() {
    if (FILE_PROTOCOL) return Promise.reject(new Error('live refresh disabled on file://'));

    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = null;
    if (controller) {
      timer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT);
    }

    var opts = {
      headers: {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    };
    if (controller) opts.signal = controller.signal;

    return fetch(API_BASE + '/users/' + GITHUB_USER + '/repos?sort=updated&per_page=100&type=owner', opts)
      .then(function (res) {
        if (timer) clearTimeout(timer);
        if (!res.ok) throw new Error('live HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        var repos = normalizeRepos(data);
        if (!repos.length) throw new Error('live empty');
        return repos;
      })
      .catch(function (err) {
        if (timer) clearTimeout(timer);
        throw err;
      });
  }

  function renderSource(repos, source) {
    renderStats(repos);
    renderRepos(repos);
    showFreshness(source);
  }

  function refreshLive(isManual) {
    return fetchLive()
      .then(function (repos) {
        renderSource(repos, 'live');
      })
      .catch(function (err) {
        if (isManual) {
          console.warn('[playground] live refresh unavailable:', err && err.message);
        } else {
          console.debug('[playground] live refresh skipped:', err && err.message);
        }
      });
  }

  function mount() {
    if (state.freshnessTimer) {
      clearInterval(state.freshnessTimer);
      state.freshnessTimer = null;
    }

    state.allRepos = [];
    state.activeLang = 'all';
    state.activeSort = 'updated';
    state.fetchedAt = null;

    resetView();
    bindRepoControls();

    fetchSnapshot()
      .then(function (repos) {
        renderSource(repos, 'snapshot');
      })
      .catch(function (err) {
        console.warn('[playground] snapshot unavailable:', err && err.message);
        var fallbackRepos = parseInlineSnapshot();
        if (fallbackRepos.length) {
          renderSource(fallbackRepos, 'inline');
        } else {
          renderEmptyState('The committed snapshot and live GitHub feed are both unavailable right now.');
        }
      })
      .then(function () {
        return refreshLive(false);
      });
  }

  window.CE_PLAYGROUND = { mount: mount };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
