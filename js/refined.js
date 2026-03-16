/*
  refined.js — Chancellor Edwards
  Toggle for Allure viewing mode (plum palette).
  Persists preference to localStorage and syncs aria-checked state.
*/

(function () {
  'use strict';

  var STORAGE_KEY = 'ce-theme';
  var root        = document.documentElement;
  var toggle      = document.getElementById('moodToggle');

  if (!toggle) return;

  // Restore saved preference before first paint
  var saved = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch (e) {}

  if (saved === 'refined') {
    root.setAttribute('data-theme', 'refined');
    toggle.setAttribute('aria-checked', 'true');
  }

  toggle.addEventListener('click', function () {
    var isRefined = root.getAttribute('data-theme') === 'refined';

    if (isRefined) {
      root.removeAttribute('data-theme');
      toggle.setAttribute('aria-checked', 'false');
      try { localStorage.setItem(STORAGE_KEY, 'default'); } catch (e) {}
    } else {
      root.setAttribute('data-theme', 'refined');
      toggle.setAttribute('aria-checked', 'true');
      try { localStorage.setItem(STORAGE_KEY, 'refined'); } catch (e) {}
    }
  });

})();
