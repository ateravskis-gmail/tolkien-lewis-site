(() => {
  const qs = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const isCoarsePointer =
    window.matchMedia?.("(pointer: coarse)").matches ||
    window.matchMedia?.("(hover: none)").matches ||
    "ontouchstart" in window;

  const intro = qs("[data-intro]");
  const skipBtn = qs("[data-skip]");
  const restartBtn = qs("[data-restart]");
  const homeVideo = qs("[data-home]");
  const mapVideo = qs("[data-map]");
  const trailerVideo = qs("[data-trailer]");
  const addisonVideo = qs("[data-addison]");
  const trailerCursor = qs("[data-trailer-cursor]");
  const trailerTimeEl = qs("[data-trailer-time]");
  const trailerTipEl = qs(".trailer-cursor__tip");
  const bgEls = qsa(".bg-slides [data-bg]");
  const bgByScene = new Map(bgEls.map((el) => [el.getAttribute("data-bg"), el]));
  const bgSlidesWrap = qs(".bg-slides");
  const titleLayer = qs('[data-layer="title"]');
  const scrollspace = qs("[data-scrollspace]");
  const epCards = qsa(".epCard");
  const roadmap = qs("[data-roadmap]");
  const roadmapJumpBtns = qsa("[data-roadmap-jump]");
  const epChips = qsa("[data-ep-chip]");
  const epSelected = qs("[data-ep-selected]");
  const epSelectedTag = qs("[data-ep-selected-tag]");
  const epSelectedTitle = qs("[data-ep-selected-title]");
  const epSelectedYears = qs("[data-ep-selected-years]");
  const epSelectedBody = qs("[data-ep-selected-body]");
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
  let activeRoadmapScene = null;
  let firstBgRange = null;
  let snapPoints = [];
  let snapTargetIndex = 0;
  let snapAnimating = false;
  let snapRAF = 0;
  let snapSettleTimer = 0;
  let wheelAccum = 0;
  let wheelResetTimer = 0;
  let wheelLock = false;
  let touchStart = null;
  let touchLast = null;
  let scrollAC = null;
  let skipLockTimer = 0;

  function applySkipLock(ms) {
    window.clearTimeout(skipLockTimer);
    document.body.classList.add("is-skip-lock");
    skipLockTimer = window.setTimeout(() => {
      document.body.classList.remove("is-skip-lock");
    }, ms);
  }

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

    rebuildSnapPoints();

    // Compute merged segments of scenes that have explicit backgrounds assigned.
    firstBgRange = null;
    bgSegments = [];
    let cur = null;
    for (const r of ranges) {
      const name = r.el?.getAttribute?.("data-scene");
      if (!name) continue;
      if (!bgByScene.has(name)) continue;
      if (!firstBgRange) firstBgRange = r;
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

  function canSnapScroll() {
    return mode === "home" && entered && !document.body.classList.contains("is-addison");
  }

  function snapPointForRange(r, scene) {
    const span = Math.max(0.0001, r.end - r.start);
    const fade = prefersReduced ? span * 0.1 : span * 0.18;
    // Land past the fade-in window so the panel is fully visible at each stop.
    // (Episodes is a longer scene; a hard cap here caused snapping before fade-in finished.)
    const bump = Math.min(span * 0.35, fade * 1.25);
    const extra = scene === "overview-1" ? Math.min(span * 0.22, 0.028) : 0;
    return Math.min(r.end - 0.001, r.start + bump + extra);
  }

  function rebuildSnapPoints() {
    snapPoints = [{ p: 0, scene: "home" }];
    for (const r of ranges) {
      const scene = r.el?.getAttribute?.("data-scene");
      if (!scene) continue;
      snapPoints.push({ p: snapPointForRange(r, scene), scene });
    }
    snapTargetIndex = findNearestSnapIndex(getProgress());
  }

  function findNearestSnapIndex(p) {
    if (!snapPoints.length) return 0;
    let best = 0;
    let bestDist = Math.abs(snapPoints[0].p - p);
    for (let i = 1; i < snapPoints.length; i++) {
      const d = Math.abs(snapPoints[i].p - p);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  }

  function findDirectionalSnapIndex(p, dir) {
    const eps = 0.0005;
    if (dir > 0) {
      for (let i = 0; i < snapPoints.length; i++) {
        if (snapPoints[i].p > p + eps) return i;
      }
      return snapPoints.length - 1;
    }
    if (dir < 0) {
      for (let i = snapPoints.length - 1; i >= 0; i--) {
        if (snapPoints[i].p < p - eps) return i;
      }
      return 0;
    }
    return findNearestSnapIndex(p);
  }

  function startSnapTo(targetP, { duration } = {}) {
    if (!canSnapScroll()) return;
    if (snapRAF) cancelAnimationFrame(snapRAF);
    const startP = getProgress();
    const endP = clamp01(targetP);
    const dur = duration ?? (prefersReduced ? 0 : 520);
    if (!Number.isFinite(endP)) return;
    if (Math.abs(endP - startP) < 0.0005 || dur <= 0) {
      snapAnimating = false;
      snapRAF = 0;
      wheelLock = false;
      setProgress(endP);
      lastP = -1;
      uiDirty = true;
      requestAnimationFrame(render);
      return;
    }
    snapAnimating = true;
    const startTime = performance.now();
    const tick = (now) => {
      const t = clamp01((now - startTime) / dur);
      const eased = smoothstep(t);
      setProgress(lerp(startP, endP, eased));
      if (t < 1) {
        snapRAF = requestAnimationFrame(tick);
      } else {
        snapAnimating = false;
        snapRAF = 0;
        wheelLock = false;
        lastP = -1;
        uiDirty = true;
        requestAnimationFrame(render);
      }
    };
    snapRAF = requestAnimationFrame(tick);
  }

  function snapToIndex(idx) {
    if (!snapPoints.length) return;
    const clamped = Math.max(0, Math.min(snapPoints.length - 1, idx));
    snapTargetIndex = clamped;
    startSnapTo(snapPoints[clamped].p);
  }

  function snapByDirection(dir) {
    if (!snapPoints.length || !canSnapScroll()) return;
    const nextIndex = snapAnimating
      ? Math.max(0, Math.min(snapPoints.length - 1, snapTargetIndex + (dir > 0 ? 1 : -1)))
      : findDirectionalSnapIndex(getProgress(), dir);
    snapToIndex(nextIndex);
  }

  function snapToNearest() {
    if (!snapPoints.length || !canSnapScroll()) return;
    snapToIndex(findNearestSnapIndex(getProgress()));
  }

  function onWheelSnap(e) {
    if (!canSnapScroll() || !snapPoints.length) return;
    if (e.ctrlKey) return;
    if (snapAnimating || wheelLock) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    if (!Number.isFinite(delta) || delta === 0) return;
    wheelAccum += delta;
    window.clearTimeout(wheelResetTimer);
    wheelResetTimer = window.setTimeout(() => {
      wheelAccum = 0;
    }, 120);
    const threshold = 28;
    if (Math.abs(wheelAccum) >= threshold) {
      const dir = wheelAccum > 0 ? 1 : -1;
      wheelAccum = 0;
      wheelLock = true;
      snapByDirection(dir);
    }
  }

  function onScrollSettle() {
    if (!canSnapScroll() || snapAnimating) return;
    window.clearTimeout(snapSettleTimer);
    snapSettleTimer = window.setTimeout(() => {
      snapToNearest();
    }, 140);
  }

  function onTouchStartSnap(e) {
    if (!canSnapScroll() || !e.touches || e.touches.length !== 1) return;
    const t = e.touches[0];
    touchStart = { x: t.clientX, y: t.clientY };
    touchLast = { x: t.clientX, y: t.clientY };
  }

  function onTouchMoveSnap(e) {
    if (!canSnapScroll() || !touchStart || !e.touches || e.touches.length !== 1) return;
    const t = e.touches[0];
    touchLast = { x: t.clientX, y: t.clientY };
    const dx = touchLast.x - touchStart.x;
    const dy = touchLast.y - touchStart.y;
    if (Math.abs(dy) >= Math.abs(dx)) {
      e.preventDefault();
    }
  }

  function onTouchEndSnap() {
    if (!canSnapScroll() || !touchStart || !touchLast) return;
    const dx = touchLast.x - touchStart.x;
    const dy = touchLast.y - touchStart.y;
    touchStart = null;
    touchLast = null;
    if (Math.abs(dy) < Math.abs(dx)) return;
    if (Math.abs(dy) < 12) return;
    const dir = dy > 0 ? -1 : 1;
    snapByDirection(dir);
  }

  function bindScrollSnapping() {
    if (scrollAC) scrollAC.abort();
    scrollAC = new AbortController();
    const { signal } = scrollAC;
    window.addEventListener("wheel", onWheelSnap, { passive: false, signal });
    window.addEventListener("touchstart", onTouchStartSnap, { passive: true, signal });
    window.addEventListener("touchmove", onTouchMoveSnap, { passive: false, signal });
    window.addEventListener("touchend", onTouchEndSnap, { passive: true, signal });
    window.addEventListener("touchcancel", onTouchEndSnap, { passive: true, signal });
    if (!isCoarsePointer) {
      window.addEventListener("scroll", onScrollSettle, { passive: true, signal });
    }
  }

  function unbindScrollSnapping() {
    if (scrollAC) scrollAC.abort();
    scrollAC = null;
    if (snapRAF) cancelAnimationFrame(snapRAF);
    snapRAF = 0;
    snapAnimating = false;
    window.clearTimeout(snapSettleTimer);
    window.clearTimeout(wheelResetTimer);
    snapSettleTimer = 0;
    wheelResetTimer = 0;
    wheelAccum = 0;
    touchStart = null;
    touchLast = null;
  }

  function tryPlay(video) {
    if (!video) return;
    const p = video.play?.();
    if (p && typeof p.catch === "function") p.catch(() => {});
  }

  function onFirstUserGesture(fn, { signal } = {}) {
    // iOS/Safari can be finicky with "click" on <video>. Use pointer/touch in capture phase.
    // Ensure we only run once even if multiple event types fire (touchstart -> click).
    let fired = false;
    const once = (e) => {
      if (fired) return;
      if (!e?.isTrusted) return;
      fired = true;
      fn(e);
    };

    const opts = (extra = {}) => ({ capture: true, passive: true, signal, ...extra });
    window.addEventListener("pointerdown", once, opts());
    window.addEventListener("touchstart", once, opts());
    window.addEventListener("click", once, opts());
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Escape" && e.key !== "Enter" && e.key !== " ") return;
        once(e);
      },
      { capture: true, signal },
    );
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
    if (window.scrollY > 18) document.body.classList.add("has-scrolled");

    // Home title should ONLY exist at the very start (not behind the overview panels).
    // Fade it out as soon as you begin entering the story.
    const vTitle = clamp01(1 - smoothstep(range(p, overviewStart + enterThreshold * 0.2, overviewStart + enterThreshold)));
    applyLayer(titleLayer, vTitle, { y0: 10, s0: 0.99 });

    // Keep bg layer up (black base) for any segments that have assigned scene backgrounds,
    // preventing the map video from peeking between fades.
    const inEpisodesSegment =
      mode === "home" &&
      episodesRange &&
      // Hold the bg layer slightly before/after to cover fade edges.
      p >= episodesRange.start - 0.01 &&
      p <= episodesRange.end + 0.01;

    const inBgSegment =
      mode === "home" &&
      !isHomePhase &&
      bgSlidesWrap &&
      bgSegments.length > 0 &&
      bgSegments.some((s) => p >= s.start - 0.002 && p <= s.end + 0.002);
    let bgLayerOpacity = inEpisodesSegment || inBgSegment ? 1 : 0;
    let firstBgV = 0;

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
          if (firstBgRange === r) firstBgV = v;
          if (bg.tagName === "VIDEO") {
            if (v > 0.05) tryPlay(bg);
            else bg.pause?.();
          }
        }
      }
    }

    if (firstBgRange) {
      const span = Math.max(0.0001, firstBgRange.end - firstBgRange.start);
      const fade = prefersReduced ? span * 0.1 : span * 0.18;
      const fadeEnd = Math.max(firstBgRange.start + fade * 1.05, overviewStart + enterThreshold);
      if (p <= fadeEnd) {
        bgLayerOpacity = firstBgV;
      }
    }

    if (bgSlidesWrap) bgSlidesWrap.style.opacity = String(clamp01(bgLayerOpacity));
    const bgFade = clamp01(bgLayerOpacity);
    if (homeVideo) homeVideo.style.opacity = isHomePhase ? String(0.92 * (1 - bgFade)) : "0";
    if (mapVideo) mapVideo.style.opacity = !isHomePhase ? String(0.92 * (1 - bgFade)) : "0";

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

      // Mobile episodes: render selected episode into the dedicated panel + highlight chips.
      if (inEp && epSelected && epSelectedTitle && epSelectedBody) {
        const src = epCards.find((c) => c.getAttribute("data-ep") === selectedEp);
        if (src) {
          const tag = qs(".epCard__tag", src)?.textContent?.trim() || `EPISODE ${selectedEp}`;
          const title = qs(".epCard__title", src)?.textContent?.trim() || "";
          const years = qs(".epCard__years", src)?.textContent?.trim() || "";
          const body = qs(".epCard__body", src)?.textContent?.trim() || "";
          if (epSelectedTag) epSelectedTag.textContent = tag;
          epSelectedTitle.textContent = title;
          if (epSelectedYears) epSelectedYears.textContent = years;
          epSelectedBody.textContent = body;
        }
        for (const chip of epChips) {
          const ep = chip.getAttribute("data-ep-chip") || "1";
          const isOn = ep === selectedEp;
          chip.classList.toggle("is-active", isOn);
          if (isOn) chip.setAttribute("aria-current", "true");
          else chip.removeAttribute("aria-current");
        }
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

    // Roadmap active scene (right-side dock)
    if (roadmap) {
      let sceneName = "home";
      if (!isHomePhase) {
        const r = ranges.find((rr) => p >= rr.start && p < rr.end) || ranges[ranges.length - 1];
        sceneName = r?.el?.getAttribute?.("data-scene") || "home";
      }
      if (sceneName !== activeRoadmapScene) {
        activeRoadmapScene = sceneName;
        const btns = roadmapJumpBtns.length ? roadmapJumpBtns : qsa("[data-roadmap-jump]");
        for (const b of btns) {
          const isActive = (b.getAttribute("data-roadmap-jump") || "home") === sceneName;
          b.classList.toggle("is-active", isActive);
          if (isActive) b.setAttribute("aria-current", "location");
          else b.removeAttribute("aria-current");
        }
      }
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
    unbindScrollSnapping();
  }

  function enterHome({ instant = false, suppressSnapMs = 0 } = {}) {
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
    if (suppressSnapMs > 0 && isCoarsePointer) {
      applySkipLock(suppressSnapMs);
      window.setTimeout(() => {
        bindScrollSnapping();
      }, suppressSnapMs);
    } else {
      bindScrollSnapping();
    }
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
    // Nudge forward so we don't land on a black edge frame.
    setProgress(addisonTriggerAt + 0.001);

    cleanupAddisonScene();
    document.body.classList.add("is-addison");
    document.body.classList.remove("is-home");

    addisonAC = new AbortController();
    const { signal } = addisonAC;

    window.addEventListener("mousemove", onMouseMove, { passive: true, signal });
    startCursorLoop();

    const finish = (opts = {}) => {
      const fromGesture = opts === true || opts?.fromGesture === true;
      cleanupAddisonScene();
      mode = "home";
      entered = true;
      document.body.classList.add("is-home");
      window.addEventListener("scroll", scheduleRender, { passive: true });
      window.addEventListener("resize", scheduleRender);
      if (fromGesture && isCoarsePointer) {
        applySkipLock(450);
        window.setTimeout(() => {
          bindScrollSnapping();
        }, 450);
      } else {
        bindScrollSnapping();
      }
      // Jump to imperative start and immediately render the card (avoid any black "gap").
      // Jump *into* the imperative range (past fade-in) so it's visible instantly.
      const span = imperativeRange.end - imperativeRange.start;
      const fade = prefersReduced ? span * 0.1 : span * 0.18;
      const jumpP = imperativeRange.start + Math.min(span * 0.35, fade * 1.25);
      setProgress(jumpP);
      lastP = -1;
      uiDirty = true;
      requestAnimationFrame(render);
    };

    addisonVideo.loop = false;
    // Start muted by default; we'll attempt to enable audio on a user gesture.
    addisonVideo.muted = true;
    addisonVideo.volume = 0;
    addisonVideo.currentTime = 0;
    setCursorForVideo(addisonVideo);

    // Mobile browsers (especially iOS Safari) will not autoplay *unmuted* video without a user gesture.
    // To avoid stalling on a black frame, autoplay muted immediately, then use the first tap to enable audio.
    let started = false;
    let hasAudio = false;
    let skipArmedLocal = false;
    const armSkip = () => {
      skipArmedLocal = false;
      window.setTimeout(() => {
        skipArmedLocal = true;
      }, 450);
    };

    const startMutedAutoplay = () => {
      if (started) return;
      started = true;
      // Ensure muted autoplay is allowed.
      addisonVideo.muted = true;
      addisonVideo.volume = 0;
      addisonVideo.setAttribute("muted", "");
      tryPlay(addisonVideo);
      armSkip();
      if (trailerTipEl && isCoarsePointer) trailerTipEl.textContent = "Tap for Sound";
    };

    const enableAudio = () => {
      if (!started) return;
      if (hasAudio) return;
      // Attempt to unmute within a user-gesture handler.
      addisonVideo.muted = false;
      addisonVideo.volume = 1;
      const p = addisonVideo.play?.();
      if (p && typeof p.catch === "function") {
        p.catch(() => {
          // If the browser still blocks audio, stay muted.
          addisonVideo.muted = true;
          addisonVideo.volume = 0;
          hasAudio = false;
          if (trailerTipEl && isCoarsePointer) trailerTipEl.textContent = "Tap for Sound";
        });
      }
      hasAudio = true;
      armSkip();
      if (trailerTipEl && isCoarsePointer) trailerTipEl.textContent = "Tap to Skip";
    };

    const startPlaybackWithAudio = () => {
      if (started) return;
      started = true;
      armSkip();
      if (trailerTipEl && isCoarsePointer) trailerTipEl.textContent = "Tap to Skip";
      addisonVideo.muted = false;
      addisonVideo.volume = 1;
      const p = addisonVideo.play?.();
      if (p && typeof p.catch === "function") {
        p.catch(() => {
          // If the browser still blocks playback, allow the user to try again.
          started = false;
          skipArmedLocal = false;
          if (trailerTipEl && isCoarsePointer) trailerTipEl.textContent = "Tap to Play";
        });
      }
      hasAudio = true;
    };

    const onSkip = (e) => {
      if (!e?.isTrusted) return;
      if (!started) return;
      // If we're autoplaying muted, first tap should enable audio (not skip).
      if (isCoarsePointer && !hasAudio) {
        enableAudio();
        return;
      }
      if (!skipArmedLocal) return;
      finish({ fromGesture: true });
    };

    if (isCoarsePointer) {
      // Autoplay muted immediately to avoid a black stall, then use tap to enable audio.
      startMutedAutoplay();
      if (trailerTipEl) trailerTipEl.textContent = "Tap for Sound";
      // If autoplay failed for any reason, allow first gesture to start playback with audio.
      onFirstUserGesture(() => {
        if (!started) startPlaybackWithAudio();
        else enableAudio();
      }, { signal });
      window.addEventListener("pointerdown", onSkip, { capture: true, passive: true, signal });
      window.addEventListener("touchstart", onSkip, { capture: true, passive: true, signal });
    } else {
      // Desktop: attempt autoplay with audio; if blocked, fall back to muted autoplay
      // so we don't stall on a black screen until the next gesture.
      if (trailerTipEl) trailerTipEl.textContent = "Click to Skip";
      const p = addisonVideo.play?.();
      if (p && typeof p.catch === "function") {
        p.catch(() => {
          addisonVideo.muted = true;
          tryPlay(addisonVideo);
        });
      }
      onFirstUserGesture(finish, { signal });
    }

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

    // Tap/click anywhere to skip (mobile-friendly).
    const onSkip = (e) => {
      if (!skipArmed) return;
      cleanupTrailerScene();
      // On touch devices, a swipe can register as both "gesture" and "scroll".
      // Delay snap binding and keep scroll locked briefly so we don't skip + scroll past the next scene.
      const suppressSnapMs = isCoarsePointer ? 450 : 0;
      enterHome({ instant: true, suppressSnapMs });
    };
    onFirstUserGesture(onSkip, { signal });
  }

  function jumpTo(scene) {
    if (mode !== "home") return;
    let targetP = null;
    if (scene === "home") {
      targetP = 0;
    } else if (scene === "addison" && addisonTriggerAt != null) {
      // Jump to just after trigger point so the interstitial runs.
      targetP = addisonTriggerAt + 0.001;
    } else {
      // Jump *into* the scene (past fade-in) so the target panel is fully visible
      // rather than landing on the black/transition edge.
      const r = ranges.find((rr) => rr.el?.getAttribute?.("data-scene") === scene);
      if (r) {
        const span = Math.max(0.0001, r.end - r.start);
        const fade = (prefersReduced ? span * 0.10 : span * 0.18);
        const bump = Math.min(span * 0.35, fade * 1.25);
        targetP = Math.min(r.end - 0.001, r.start + bump);
      } else {
        const start = sceneStartByName.get(scene);
        if (start != null) targetP = start + 0.01;
      }
    }

    if (targetP == null) return;

    // If the user uses the menu to jump *past* Addison’s Walk, don't force them to watch it.
    if (!addisonPlayed && addisonTriggerAt != null && targetP >= addisonTriggerAt) {
      addisonPlayed = true;
    }

    setProgress(targetP);
    lastP = -1;
    uiDirty = true;
    requestAnimationFrame(render);
  }

  for (const b of roadmapJumpBtns) {
    b.addEventListener("click", () => {
      const scene = b.getAttribute("data-roadmap-jump") || "home";
      jumpTo(scene);
      // Clicking focuses the button; that keeps :focus-within on the dock, so labels stay open.
      // Blur on pointer/click so labels collapse again (keyboard users still get focus behavior).
      b.blur?.();
    });
  }

  // Apple Dock-ish magnify on pointer move (desktop only, reduced-motion safe).
  if (roadmap && !prefersReduced && !isCoarsePointer) {
    const items = roadmapJumpBtns.length ? roadmapJumpBtns : qsa("[data-roadmap-jump]", roadmap);
    const reset = () => items.forEach((el) => el.style.setProperty("--mag", "1"));
    roadmap.addEventListener("pointerleave", reset);
    roadmap.addEventListener("pointermove", (e) => {
      const y = e.clientY;
      const sigma = 62; // px
      for (const el of items) {
        const r = el.getBoundingClientRect();
        const cy = r.top + r.height / 2;
        const d = Math.abs(y - cy);
        const bump = Math.exp(-(d * d) / (2 * sigma * sigma)); // 0..1
        const mag = 1 + bump * 0.72;
        el.style.setProperty("--mag", mag.toFixed(3));
      }
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

  for (const chip of epChips) {
    const ep = chip.getAttribute("data-ep-chip") || "1";
    chip.addEventListener("click", () => {
      selectedEp = ep;
      uiDirty = true;
      scheduleRender();
      chip.blur?.();
    });
  }

  restartBtn?.addEventListener("click", restartIntro);

  bindSkip();
  // Render once so the initial layer states are consistent (even before entering).
  scheduleRender();

  // UI copy tweaks for touch devices.
  if (trailerTipEl && isCoarsePointer) trailerTipEl.textContent = "Tap to Skip";
})();


