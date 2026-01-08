(() => {
  const qs = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const intro = qs("[data-intro]");
  const skipBtn = qs("[data-skip]");
  const restartBtn = qs("[data-restart]");
  const homeVideo = qs("[data-home]");
  const mapVideo = qs("[data-map]");
  const trailerVideo = qs("[data-trailer]");
  const addisonVideo = qs("[data-addison]");
  const trailerCursor = qs("[data-trailer-cursor]");
  const trailerTimeEl = qs("[data-trailer-time]");
  const bgEls = qsa(".bg-slides [data-bg]");
  const bgByScene = new Map(bgEls.map((el) => [el.getAttribute("data-bg"), el]));
  const bgSlidesWrap = qs(".bg-slides");
  const titleLayer = qs('[data-layer="title"]');
  const scrollspace = qs("[data-scrollspace]");
  const epCards = qsa(".epCard");
  const menuToggle = qs("[data-menu-toggle]");
  const menuPanel = qs("[data-menu-panel]");
  const menuJumpBtns = qsa("[data-jump]");
  const sceneEls = qsa("[data-scene]");
  const sceneDefs = [];
  for (const el of sceneEls) {
    const w = Number.parseFloat(el.getAttribute("data-len") || "1");
    sceneDefs.push({ el, w: Number.isFinite(w) && w > 0 ? w : 1 });
  }

  let entered = false;
  let raf = 0;
  let introTimer = 0;
  let introAC = null;
  let lastP = -1;
  let ranges = [];
  let mode = "intro"; // intro | trailer | home
  let cursorRAF = 0;
  let lastMouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  let trailerAC = null;
  let skipArmed = false;
  let overviewBgRange = null; // { start, end }
  let overviewStart = 0;
  const enterThreshold = 0.02; // how far to scroll before overview-1 truly begins (prevents black-at-0)
  let bgSegments = []; // merged [{start,end}] ranges where bg layer should stay up (dip-to-black between fades)
  let addisonAC = null;
  let addisonTriggerAt = null; // progress value where we should trigger the interstitial
  let imperativeRange = null; // { start, end } resume point for post-Addison jump
  let addisonPlayed = false;
  let episodesRange = null; // { start, end }
  let episodesInitialized = false;
  let selectedEp = "1";
  let hoverEp = null;
  let uiDirty = true;
  let sceneStartByName = new Map();

  // --- small math helpers
  const clamp01 = (n) => Math.max(0, Math.min(1, n));
  const smoothstep = (t) => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;

  function range(p, a, b) {
    if (a === b) return 0;
    return clamp01((p - a) / (b - a));
  }

  function inOut(p, aIn, bIn, aOut, bOut) {
    const tIn = smoothstep(range(p, aIn, bIn));
    const tOut = smoothstep(range(p, aOut, bOut));
    return clamp01(tIn * (1 - tOut));
  }

  function applyLayer(el, v, opts = {}) {
    if (!el) return;
    const y0 = opts.y0 ?? 18;
    const s0 = opts.s0 ?? 0.992;

    const y = lerp(y0, 0, v);
    const s = lerp(s0, 1, v);

    el.style.opacity = String(v);
    el.style.transform = `translate3d(0, ${y}px, 0) scale(${s})`;
    el.style.visibility = v <= 0.001 ? "hidden" : "visible";
  }

  function buildRanges() {
    const total = sceneDefs.reduce((sum, s) => sum + s.w, 0) || 1;
    let acc = 0;
    ranges = sceneDefs.map((s) => {
      const start = acc / total;
      acc += s.w;
      const end = acc / total;
      return { el: s.el, start, end };
    });

    const o1 = ranges.find((r) => r.el?.getAttribute?.("data-scene") === "overview-1");
    const o3 = ranges.find((r) => r.el?.getAttribute?.("data-scene") === "overview-3");
    const imperative = ranges.find((r) => r.el?.getAttribute?.("data-scene") === "imperative");
    const episodes = ranges.find((r) => r.el?.getAttribute?.("data-scene") === "episodes");
    overviewBgRange = o1 && o3 ? { start: o1.start, end: o3.end } : null;
    overviewStart = o1?.start ?? 0;
    addisonTriggerAt = o3?.end ?? null;
    imperativeRange = imperative ? { start: imperative.start, end: imperative.end } : null;
    episodesRange = episodes ? { start: episodes.start, end: episodes.end } : null;

    sceneStartByName = new Map();
    for (const r of ranges) {
      const name = r.el?.getAttribute?.("data-scene");
      if (name) sceneStartByName.set(name, r.start);
    }

    // Compute merged segments of scenes that have explicit backgrounds assigned.
    bgSegments = [];
    let cur = null;
    for (const r of ranges) {
      const name = r.el?.getAttribute?.("data-scene");
      if (!name) continue;
      if (!bgByScene.has(name)) continue;
      if (!cur) cur = { start: r.start, end: r.end };
      else if (Math.abs(cur.end - r.start) < 1e-6) cur.end = r.end;
      else {
        bgSegments.push(cur);
        cur = { start: r.start, end: r.end };
      }
    }
    if (cur) bgSegments.push(cur);

    // Size scrollspace based on content length.
    // Keep scroll distance snappy; too much feels like "scrolling forever".
    if (scrollspace) {
      const vh = Math.round(140 + total * 72);
      scrollspace.style.height = `${vh}vh`;
    }
  }

  function visForRange(p, start, end, { holdLast = false } = {}) {
    const span = Math.max(0.0001, end - start);
    const fade = prefersReduced ? span * 0.10 : span * 0.18;
    const aIn = start;
    const bIn = start + fade;
    const aOut = holdLast ? 1.1 : end - fade;
    const bOut = holdLast ? 1.2 : end;
    return inOut(p, aIn, bIn, aOut, bOut);
  }

  function getProgress() {
    const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    return clamp01(window.scrollY / max);
  }

  function setProgress(p) {
    const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    window.scrollTo({ top: clamp01(p) * max, behavior: "auto" });
  }

  function tryPlay(video) {
    if (!video) return;
    const p = video.play?.();
    if (p && typeof p.catch === "function") p.catch(() => {});
  }

  function fmtTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return "--:--";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function setTrailerCursorText() {
    if (!trailerTimeEl || !trailerVideo) return;
    const cur = trailerVideo.currentTime || 0;
    const dur = trailerVideo.duration;
    trailerTimeEl.textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
  }

  function setCursorForVideo(video) {
    if (!trailerTimeEl || !video) return;
    const cur = video.currentTime || 0;
    const dur = video.duration;
    trailerTimeEl.textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
  }

  function cursorLoop() {
    cursorRAF = 0;
    if (mode !== "trailer" && mode !== "addison") return;
    if (mode === "trailer") setTrailerCursorText();
    else if (mode === "addison") setCursorForVideo(addisonVideo);
    if (trailerCursor) {
      trailerCursor.style.transform = `translate3d(${lastMouse.x + 14}px, ${lastMouse.y + 14}px, 0)`;
    }
    cursorRAF = requestAnimationFrame(cursorLoop);
  }

  function startCursorLoop() {
    if (cursorRAF) return;
    cursorRAF = requestAnimationFrame(cursorLoop);
  }

  function stopCursorLoop() {
    if (cursorRAF) cancelAnimationFrame(cursorRAF);
    cursorRAF = 0;
  }

  function render() {
    raf = 0;
    if (!entered) return;

    const p = getProgress();
    if (!uiDirty && Math.abs(p - lastP) < 0.0001) return; // allow hover/click updates without scroll
    lastP = p;
    uiDirty = false;
    const isHomePhase = p < overviewStart + enterThreshold;

    // Home title should ONLY exist at the very start (not behind the overview panels).
    // Fade it out as soon as you begin entering the story.
    const vTitle = clamp01(1 - smoothstep(range(p, overviewStart + enterThreshold * 0.2, overviewStart + enterThreshold)));
    applyLayer(titleLayer, vTitle, { y0: 10, s0: 0.99 });

    // Keep bg layer up (black base) for any segments that have assigned scene backgrounds,
    // preventing the map video from peeking between fades.
    const inBgSegment =
      mode === "home" &&
      !isHomePhase &&
      bgSlidesWrap &&
      bgSegments.length > 0 &&
      bgSegments.some((s) => p >= s.start - 0.002 && p <= s.end + 0.002);
    if (bgSlidesWrap) bgSlidesWrap.style.opacity = inBgSegment ? "1" : "0";

    if (homeVideo) homeVideo.style.opacity = isHomePhase && !inBgSegment ? "0.92" : "0";
    if (mapVideo) mapVideo.style.opacity = !isHomePhase && !inBgSegment ? "0.92" : "0";

    // Addison's Walk interstitial (once): after overview-3 and before imperative.
    if (mode === "home" && !addisonPlayed && addisonTriggerAt != null && imperativeRange != null && p >= addisonTriggerAt) {
      startAddisonScene();
      return;
    }

    // Story panels
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      const holdLast = i === ranges.length - 1;
      const v = visForRange(p, r.start, r.end, { holdLast });
      applyLayer(r.el, v, { y0: 22, s0: 0.992 });

      // Background slide crossfades for specific scenes
      const sceneName = r.el?.getAttribute?.("data-scene");
      if (sceneName) {
        const bg = bgByScene.get(sceneName);
        if (bg) {
          bg.style.opacity = String(v);
          if (bg.tagName === "VIDEO") {
            if (v > 0.05) tryPlay(bg);
            else bg.pause?.();
          }
        }
      }
    }

    // Episodes dock behavior: hover expands + background swaps, auto-open Ep1 on first entry.
    if (episodesRange) {
      const vEp = visForRange(p, episodesRange.start, episodesRange.end, { holdLast: false });
      const inEp = vEp > 0.12;
      if (inEp && !episodesInitialized) {
        episodesInitialized = true;
        selectedEp = "1";
      }
      if (!inEp) hoverEp = null;

      // Locked episode is only used when not hovering any other card.
      const active = hoverEp ?? selectedEp;
      for (const card of epCards) {
        const isActive = card.getAttribute("data-ep") === active && inEp;
        card.classList.toggle("is-active", isActive);
      }

      // Ensure the background layer is visible during Episodes (ep backgrounds are not timeline scenes).
      if (inEp) {
        if (bgSlidesWrap) bgSlidesWrap.style.opacity = "1";
        if (homeVideo) homeVideo.style.opacity = "0";
        if (mapVideo) mapVideo.style.opacity = "0";
      }

      // Background swapping for episodes: use ep1..ep5 backgrounds driven by active episode,
      // but only while we're in the episodes scene.
      for (let i = 1; i <= 5; i++) {
        const key = `ep${i}`;
        const el = bgByScene.get(key);
        if (!el) continue;
        const on = inEp && active === String(i) ? vEp : 0;
        el.style.opacity = String(on);
        if (el.tagName === "VIDEO") {
          if (on > 0.05) tryPlay(el);
          else el.pause?.();
        }
      }
    }

    // Subtle camera drift on the active background to keep it alive.
    const activeBg = isHomePhase ? homeVideo : inBgSegment ? null : mapVideo;
    if (activeBg && !prefersReduced) {
      const drift = (p - 0.5) * 2; // -1..1
      const ty = drift * 10;
      const sc = 1.03 + Math.abs(drift) * 0.015;
      activeBg.style.transform = `translate3d(0, ${ty}px, 0) scale(${sc})`;
    }
  }

  function scheduleRender() {
    if (raf) return;
    raf = requestAnimationFrame(render);
  }

  function teardownHome() {
    window.removeEventListener("scroll", scheduleRender);
    window.removeEventListener("resize", scheduleRender);
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    lastP = -1;
  }

  function enterHome({ instant = false } = {}) {
    if (mode === "home") return;
    mode = "home";
    entered = true;

    if (introAC) introAC.abort();
    clearTimeout(introTimer);

    document.body.classList.add("is-entered");
    document.body.classList.remove("is-trailer");
    document.body.classList.add("is-home");
    document.body.classList.remove("is-addison");
    window.scrollTo({ top: 0, behavior: "auto" });
    if (homeVideo) {
      homeVideo.muted = true;
      homeVideo.loop = true;
      tryPlay(homeVideo);
    }
    if (mapVideo) {
      mapVideo.muted = true;
      mapVideo.loop = true;
      tryPlay(mapVideo);
    }
    buildRanges();
    addisonPlayed = false;
    episodesInitialized = false;
    if (addisonVideo) {
      addisonVideo.pause?.();
      addisonVideo.currentTime = 0;
    }

    if (intro) {
      intro.setAttribute("aria-hidden", "true");
      if (skipBtn) skipBtn.disabled = true;
      if (prefersReduced || instant) {
        intro.hidden = true;
      } else {
        intro.classList.add("is-exiting");
        intro.addEventListener(
          "animationend",
          () => {
            intro.hidden = true;
          },
          { once: true },
        );
      }
    }

    render();
    window.addEventListener("scroll", scheduleRender, { passive: true });
    window.addEventListener("resize", scheduleRender);
  }

  function cleanupTrailerScene() {
    if (trailerAC) trailerAC.abort();
    trailerAC = null;
    stopCursorLoop();
    window.removeEventListener("mousemove", onMouseMove);
    skipArmed = false;
    if (trailerVideo) {
      trailerVideo.pause?.();
      trailerVideo.currentTime = 0;
    }
  }

  function onMouseMove(e) {
    lastMouse = { x: e.clientX, y: e.clientY };
  }

  function cleanupAddisonScene() {
    if (addisonAC) addisonAC.abort();
    addisonAC = null;
    stopCursorLoop();
    window.removeEventListener("mousemove", onMouseMove);
    if (addisonVideo) {
      addisonVideo.pause?.();
      addisonVideo.currentTime = 0;
    }
    document.body.classList.remove("is-addison");
  }

  function startAddisonScene() {
    if (mode === "addison") return;
    if (!addisonVideo) return;
    if (addisonTriggerAt == null || imperativeRange == null) return;
    addisonPlayed = true;

    mode = "addison";
    entered = false;
    teardownHome();

    // Make sure we don't immediately retrigger on resume.
    setProgress(addisonTriggerAt);

    cleanupAddisonScene();
    document.body.classList.add("is-addison");
    document.body.classList.remove("is-home");

    addisonAC = new AbortController();
    const { signal } = addisonAC;

    window.addEventListener("mousemove", onMouseMove, { passive: true, signal });
    startCursorLoop();

    const finish = () => {
      cleanupAddisonScene();
      mode = "home";
      entered = true;
      document.body.classList.add("is-home");
      window.addEventListener("scroll", scheduleRender, { passive: true });
      window.addEventListener("resize", scheduleRender);
      // Jump to imperative start and immediately render the card (avoid any black "gap").
      // Jump *into* the imperative range (past fade-in) so it's visible instantly.
      const span = imperativeRange.end - imperativeRange.start;
      const jumpP = imperativeRange.start + Math.min(span * 0.35, 0.02);
      setProgress(jumpP);
      lastP = -1;
      uiDirty = true;
      requestAnimationFrame(render);
    };

    // Click anywhere to skip.
    window.addEventListener("click", finish, { once: true, signal });

    addisonVideo.loop = false;
    addisonVideo.muted = false;
    addisonVideo.currentTime = 0;
    setCursorForVideo(addisonVideo);
    tryPlay(addisonVideo);
    addisonVideo.addEventListener("loadedmetadata", () => setCursorForVideo(addisonVideo), { once: true, signal });
    addisonVideo.addEventListener("timeupdate", () => setCursorForVideo(addisonVideo), { passive: true, signal });
    addisonVideo.addEventListener("ended", finish, { once: true, signal });
  }

  function startTrailerScene() {
    if (mode === "trailer") return;
    mode = "trailer";
    entered = false;
    teardownHome();

    // Keep intro visible until user clicks Enter (this call is the Enter click).
    if (introAC) introAC.abort();
    clearTimeout(introTimer);

    document.body.classList.add("is-trailer");
    document.body.classList.remove("is-entered");
    document.body.classList.remove("is-home");
    document.body.classList.remove("is-addison");
    window.scrollTo({ top: 0, behavior: "auto" });

    // Hide intro immediately on Enter click.
    if (intro) {
      intro.setAttribute("aria-hidden", "true");
      intro.hidden = true;
    }

    // Setup trailer playback + skip behavior.
    cleanupTrailerScene();
    trailerAC = new AbortController();
    const { signal } = trailerAC;

    window.addEventListener("mousemove", onMouseMove, { passive: true, signal });
    startCursorLoop();
    // Prevent the "Enter" click from immediately triggering skip.
    skipArmed = false;
    window.setTimeout(() => {
      skipArmed = true;
    }, 250);

    if (trailerVideo) {
      trailerVideo.loop = false;
      trailerVideo.muted = false; // user gesture (Enter) should allow audio
      trailerVideo.currentTime = 0;
      setTrailerCursorText();
      tryPlay(trailerVideo);

      trailerVideo.addEventListener(
        "loadedmetadata",
        () => {
          setTrailerCursorText();
        },
        { once: true, signal },
      );
      trailerVideo.addEventListener(
        "timeupdate",
        () => {
          setTrailerCursorText();
        },
        { passive: true, signal },
      );
      trailerVideo.addEventListener(
        "ended",
        () => {
          cleanupTrailerScene();
          enterHome({ instant: true });
        },
        { once: true, signal },
      );
    }

    // Click anywhere to skip.
    const onSkipClick = () => {
      if (!skipArmed) return;
      window.removeEventListener("click", onSkipClick);
      cleanupTrailerScene();
      enterHome({ instant: true });
    };
    window.addEventListener("click", onSkipClick, { signal });
  }

  // --- Menu
  function setMenuOpen(open) {
    if (!menuToggle || !menuPanel) return;
    menuToggle.setAttribute("aria-expanded", String(open));
    menuPanel.hidden = !open;
  }

  menuToggle?.addEventListener("click", () => {
    const isOpen = menuToggle.getAttribute("aria-expanded") === "true";
    setMenuOpen(!isOpen);
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setMenuOpen(false);
  });

  // Close when clicking outside the panel.
  window.addEventListener("click", (e) => {
    if (!menuPanel || menuPanel.hidden) return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (menuPanel.contains(t) || menuToggle?.contains(t)) return;
    setMenuOpen(false);
  });

  function jumpTo(scene) {
    if (mode !== "home") return;
    let targetP = null;
    if (scene === "home") {
      targetP = 0;
    } else if (scene === "addison" && addisonTriggerAt != null) {
      // Jump to just after trigger point so the interstitial runs.
      targetP = addisonTriggerAt + 0.001;
    } else {
      const start = sceneStartByName.get(scene);
      if (start != null) targetP = start + 0.002;
    }

    if (targetP == null) return;

    // If the user uses the menu to jump *past* Addison’s Walk, don't force them to watch it.
    if (!addisonPlayed && addisonTriggerAt != null && targetP >= addisonTriggerAt) {
      addisonPlayed = true;
    }

    setProgress(targetP);
    lastP = -1;
    uiDirty = true;
    setMenuOpen(false);
    requestAnimationFrame(render);
  }

  for (const b of menuJumpBtns) {
    b.addEventListener("click", () => {
      const scene = b.getAttribute("data-jump") || "home";
      jumpTo(scene);
    });
  }

  function resetIntroAnimations() {
    if (!intro) return;
    intro.classList.remove("is-exiting");
    const lines = qsa(".intro__line", intro);
    lines.forEach((el) => {
      // force CSS animation restart
      el.style.animation = "none";
      el.offsetHeight;
      el.style.animation = "";
    });
  }

  function restartIntro() {
    // Re-show intro and re-lock scroll.
    entered = false;
    mode = "intro";
    cleanupTrailerScene();
    teardownHome();
    document.body.classList.remove("is-entered");
    document.body.classList.remove("is-trailer");
    document.body.classList.remove("is-home");
    document.body.classList.remove("is-addison");
    window.scrollTo({ top: 0, behavior: "auto" });
    addisonPlayed = false;

    if (intro) {
      intro.hidden = false;
      intro.removeAttribute("aria-hidden");
      resetIntroAnimations();
    }
    if (skipBtn) skipBtn.disabled = false;

    // Stop any pending render loop.
    if (raf) cancelAnimationFrame(raf);
    raf = 0;

    // Remove listeners (safe even if not added).
    window.removeEventListener("scroll", scheduleRender);
    window.removeEventListener("resize", scheduleRender);

    bindSkip();
  }

  // --- Intro behavior (user-driven via Enter button)
  function bindSkip() {
    if (introAC) introAC.abort();
    introAC = new AbortController();

    const skip = () => startTrailerScene();
    if (skipBtn) skipBtn.onclick = skip;
  }

  // Episodes dock interactions
  for (const card of epCards) {
    const ep = card.getAttribute("data-ep") || "1";
    card.addEventListener("mouseenter", () => {
      hoverEp = ep;
      uiDirty = true;
      scheduleRender();
    });
    card.addEventListener("mouseleave", () => {
      hoverEp = null;
      uiDirty = true;
      scheduleRender();
    });
    card.addEventListener("focus", () => {
      hoverEp = ep;
      uiDirty = true;
      scheduleRender();
    });
    card.addEventListener("blur", () => {
      hoverEp = null;
      uiDirty = true;
      scheduleRender();
    });
    card.addEventListener("click", () => {
      selectedEp = ep;
      uiDirty = true;
      scheduleRender();
    });
  }

  restartBtn?.addEventListener("click", restartIntro);

  bindSkip();
  // Render once so the initial layer states are consistent (even before entering).
  scheduleRender();
})();


