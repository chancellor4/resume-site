/*
  refined.js — Chancellor Edwards
  Universal toggle for refined viewing mode + rain atmosphere.

  The rain is a canvas-based particle system that creates the feeling
  of looking through a calm window on a rainy day. Thin translucent
  streaks fall at a gentle angle with varied speeds and lengths,
  layered with a soft mist gradient at the bottom edge.

  Design constraints:
    - Never distract from content (low opacity, pointer-events: none)
    - Respect prefers-reduced-motion
    - Fade in/out gracefully with the theme transition
    - Pause animation loop when not in refined mode (performance)
*/

(function () {
  'use strict';

  var STORAGE_KEY = 'ce-theme';
  var root = document.documentElement;

  /* ── Toggle Logic ──────────────────────────────────────────── */

  var toggle = document.getElementById('moodToggle');
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

  /* ── Rain Animation ────────────────────────────────────────── */

  // Respect reduced motion
  var prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (prefersReducedMotion.matches) return;

  // Create canvas
  var canvas = document.createElement('canvas');
  canvas.id = 'rain-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.appendChild(canvas);

  var ctx = canvas.getContext('2d');
  var W, H;
  var drops = [];
  var mist = [];
  var animId = null;
  var isActive = false;

  // Rain configuration
  var DROP_COUNT = 70;
  var MIST_PARTICLES = 12;
  var WIND_ANGLE = 3;  // degrees from vertical — gentle drift
  var WIND_RAD = WIND_ANGLE * Math.PI / 180;

  // Plum-tinted rain colors — muted, atmospheric
  var RAIN_COLORS = [
    'rgba(123, 94, 123, ',   // plum
    'rgba(160, 140, 160, ',  // light mauve
    'rgba(130, 120, 140, ',  // cool lavender-gray
    'rgba(100, 85, 105, ',   // deep plum-gray
    'rgba(145, 130, 150, ',  // silver-mauve
  ];

  function resize() {
    var dpr = window.devicePixelRatio || 1;
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function createDrop() {
    return {
      x: Math.random() * (W + 60) - 30,
      y: Math.random() * -H,              // start above viewport
      length: 12 + Math.random() * 18,    // 12–30px streaks
      width: 0.6 + Math.random() * 0.8,   // 0.6–1.4px thin
      speed: 1.5 + Math.random() * 2.5,   // gentle fall speed
      opacity: 0.04 + Math.random() * 0.1, // very subtle: 0.04–0.14
      color: RAIN_COLORS[Math.floor(Math.random() * RAIN_COLORS.length)],
      drift: (Math.random() - 0.3) * 0.15  // slight horizontal variation
    };
  }

  function createMistParticle() {
    return {
      x: Math.random() * W,
      y: H - Math.random() * (H * 0.18),  // bottom 18%
      radius: 40 + Math.random() * 80,
      opacity: 0.008 + Math.random() * 0.018,
      dx: (Math.random() - 0.5) * 0.15
    };
  }

  function initParticles() {
    drops = [];
    mist = [];
    for (var i = 0; i < DROP_COUNT; i++) {
      var d = createDrop();
      d.y = Math.random() * H;  // distribute across viewport initially
      drops.push(d);
    }
    for (var j = 0; j < MIST_PARTICLES; j++) {
      mist.push(createMistParticle());
    }
  }

  function drawRain() {
    ctx.clearRect(0, 0, W, H);

    // Draw mist — soft radial gradients near bottom
    for (var m = 0; m < mist.length; m++) {
      var mp = mist[m];
      var grad = ctx.createRadialGradient(mp.x, mp.y, 0, mp.x, mp.y, mp.radius);
      grad.addColorStop(0, 'rgba(200, 185, 200, ' + mp.opacity + ')');
      grad.addColorStop(1, 'rgba(200, 185, 200, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(mp.x - mp.radius, mp.y - mp.radius, mp.radius * 2, mp.radius * 2);

      // Drift mist slowly
      mp.x += mp.dx;
      if (mp.x > W + mp.radius) mp.x = -mp.radius;
      if (mp.x < -mp.radius) mp.x = W + mp.radius;
    }

    // Draw rain streaks
    for (var i = 0; i < drops.length; i++) {
      var d = drops[i];
      var endX = d.x + Math.sin(WIND_RAD) * d.length;
      var endY = d.y + Math.cos(WIND_RAD) * d.length;

      ctx.beginPath();
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(endX, endY);
      ctx.strokeStyle = d.color + d.opacity + ')';
      ctx.lineWidth = d.width;
      ctx.lineCap = 'round';
      ctx.stroke();

      // Move drop
      d.y += d.speed;
      d.x += Math.sin(WIND_RAD) * d.speed + d.drift;

      // Reset when below viewport
      if (d.y > H + d.length) {
        drops[i] = createDrop();
      }
    }
  }

  function loop() {
    if (!isActive) return;
    drawRain();
    animId = requestAnimationFrame(loop);
  }

  function start() {
    if (isActive) return;
    isActive = true;
    resize();
    initParticles();
    loop();
  }

  function stop() {
    isActive = false;
    if (animId) {
      cancelAnimationFrame(animId);
      animId = null;
    }
    // Clear canvas when stopping
    if (ctx) ctx.clearRect(0, 0, W || 0, H || 0);
  }

  // Observe theme changes to start/stop rain
  function checkTheme() {
    if (root.getAttribute('data-theme') === 'refined') {
      start();
    } else {
      stop();
    }
  }

  // Watch for attribute changes on <html>
  var observer = new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      if (mutations[i].attributeName === 'data-theme') {
        checkTheme();
        break;
      }
    }
  });

  observer.observe(root, { attributes: true });

  // Handle resize
  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (isActive) {
        resize();
        initParticles();
      }
    }, 200);
  });

  // Pause when tab not visible (performance)
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      if (isActive) {
        cancelAnimationFrame(animId);
        animId = null;
      }
    } else {
      if (root.getAttribute('data-theme') === 'refined' && isActive) {
        loop();
      }
    }
  });

  // Initial check
  checkTheme();

})();
