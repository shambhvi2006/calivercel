(function () {
  const CALIB_KEY = "calib_vertical_autohold";
  const COMPAT_KEY = "calibration"; // for pages that read localStorage["calibration"]
  const isMirrored = true;

  // --- DOM helpers
  const $ = (id) => document.getElementById(id);
  const stage = $("stage"), canvas = $("canvas"), ctx = canvas.getContext("2d"), video = $("video");
  const ladderLayer = $("ladderLayer");
  const statusEl = $("status");
  const btnStart = $("btnStart"), btnReset = $("btnReset");

  const kpiLeft = $("kpiLeft"), kpiRight = $("kpiRight"), kpiSaved = $("kpiSaved");
  const kpiHold = $("kpiHold"), kpiTargets = $("kpiTargets"), kpiStatus = $("kpiStatus");
  const sideTimer = $("sideTimer"), sideFill = $("sideFill"), hipTip = $("hipTip");
  const armLabel = $("armLabel"), armDot = $("armDot");
  const saveToast = $("saveToast");
  const setStatus = (s) => { statusEl.textContent = s; kpiStatus.textContent = s; };

  const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(+v) ? +v : 0.5));
  const yAtIndex = (yList, idx) => { const i = Math.max(1, Math.min(yList.length, idx)); return yList[i - 1]; };

  const V2 = {
    ema(prev, next, a = 0.35) { if (!next) return prev; if (!prev) return next; return { x: prev.x + a * (next.x - prev.x), y: prev.y + a * (next.y - prev.y), visibility: next.visibility ?? 1 }; },
    dist(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return Math.hypot(dx, dy); }
  };

  // --- Auto-calibration grid
  const CalibAuto = {
    create({
      count = 8, yTop = 0.12, yBottom = 0.85, leftX = 0.18, rightX = 0.82,
      hitRadius = 0.12, holdSeconds = 5, kFrames = 6, maxSpeedPerSec = 0.60, minVis = 0.55, needsHips = true,
      laneFollow = false, laneAlpha = 0.15, laneClamp = [0.08, 0.92]
    } = {}) {
      const yList = Array.from({ length: count }, (_, i) => yBottom - (i / (count - 1)) * (yBottom - yTop));
      return {
        count, yTop, yBottom, leftX, rightX, hitRadius, yList,
        holdSeconds, kFrames, maxSpeedPerSec, minVis, needsHips,
        laneFollow, laneAlpha, laneClamp,
        step: "left",
        leftActive: null, rightActive: null, leftSaved: null, rightSaved: null,
        _lastTs: null, _sL: null, _sR: null, _kOn: 0, _hold: 0, _candidate: null,
        _rom: { neutralSamples: [], maxReachLeft: 1, maxReachRight: 1 },
        _maxRungL: null, _maxRungR: null, _minYLeft: 1, _minYRight: 1
      };
    },

    update(grid, lm, { isMirrored = true } = {}) {
      if (!lm || !lm[15] || !lm[16]) return this._status(grid, grid.step, 0);

      const hipsOK = ((lm[23]?.visibility ?? 0) >= grid.minVis) && ((lm[24]?.visibility ?? 0) >= grid.minVis);
      if (grid.needsHips && !hipsOK) { grid._candidate = null; grid._kOn = 0; grid._hold = 0; return this._status(grid, grid.step, 0); }
      const yH1 = clamp01(lm[23]?.y), yH2 = clamp01(lm[24]?.y); if (Number.isFinite(yH1) && Number.isFinite(yH2)) grid._rom.neutralSamples.push(Math.max(yH1, yH2));

      const vOK = (pt) => (pt?.visibility ?? 0) >= grid.minVis; if (!vOK(lm[15]) || !vOK(lm[16])) { grid._kOn = 0; grid._hold = 0; return this._status(grid, grid.step, 0); }
      const nrm = (pt) => ({ x: clamp01(isMirrored ? 1 - pt.x : pt.x), y: clamp01(pt.y), visibility: pt.visibility ?? 1 });
      const wL = nrm(lm[15]), wR = nrm(lm[16]);

      const now = performance.now(), dt = grid._lastTs ? (now - grid._lastTs) / 1000 : 0; grid._lastTs = now;
      const prevL = grid._sL, prevR = grid._sR; grid._sL = V2.ema(grid._sL, wL, 0.35); grid._sR = V2.ema(grid._sR, wR, 0.35); const sL = grid._sL || wL, sR = grid._sR || wR;
      const spdL = (prevL && dt > 0) ? V2.dist(prevL, wL) / dt : 0, spdR = (prevR && dt > 0) ? V2.dist(prevR, wR) / dt : 0;

      grid.leftActive = this._hitIndex(grid, sL.x, sL.y, grid.leftX);
      grid.rightActive = this._hitIndex(grid, sR.x, sR.y, grid.rightX);

      if (sL.y < grid._minYLeft) { grid._minYLeft = sL.y; grid._maxRungL = this._nearestRung(grid, sL.y); }
      if (sR.y < grid._minYRight) { grid._minYRight = sR.y; grid._maxRungR = this._nearestRung(grid, sR.y); }

      const side = grid.step;
      const active = side === "left" ? grid.leftActive : grid.rightActive;
      const spd = side === "left" ? spdL : spdR;
      const yHand = side === "left" ? sL.y : sR.y;

      if (!active) { grid._candidate = null; grid._kOn = 0; grid._hold = 0; grid._rom.neutralSamples.push(yHand); return this._status(grid, side, 0); }
      if (grid._candidate !== active) { grid._candidate = active; grid._kOn = 0; grid._hold = 0; }

      const steady = spd <= grid.maxSpeedPerSec; if (steady) grid._kOn++; if (grid._kOn >= grid.kFrames) grid._hold += dt;

      if (grid._hold >= grid.holdSeconds) {
        if (side === "left") grid.leftSaved = grid._candidate; else grid.rightSaved = grid._candidate;
        grid._candidate = null; grid._kOn = 0; grid._hold = 0; grid.step = (side === "left") ? "right" : "done";
        return { ok: true, side, saved: true, progress: 1, countdown: 0, step: grid.step };
      }
      return this._status(grid, side, grid._hold / grid.holdSeconds);
    },

    _hitIndex(grid, x, y, laneX) {
      let best = null, bestD2 = Infinity;
      for (let i = 0; i < grid.count; i++) {
        const yy = grid.yList[i]; const dx = x - laneX, dy = y - yy; const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) { bestD2 = d2; best = i; }
      }
      const hit = Math.sqrt(bestD2) <= grid.hitRadius; return hit ? (best + 1) : null;
    },
    _nearestRung(grid, y) { let best = 1, bestAbs = Infinity; for (let i = 0; i < grid.count; i++) { const d = Math.abs(grid.yList[i] - y); if (d < bestAbs) { bestAbs = d; best = i + 1; } } return best; },
    _status(grid, side, progress) {
      progress = Math.max(0, Math.min(1, progress)); const countdown = Math.max(0, grid.holdSeconds * (1 - progress));
      return { ok: true, side, saved: false, progress, countdown, step: grid.step, leftActive: grid.leftActive, rightActive: grid.rightActive, leftSaved: grid.leftSaved, rightSaved: grid.rightSaved };
    }
  };

  // Public getter (optional)
  window.CalibrationBridge = {
    get() {
      try {
        const raw = sessionStorage.getItem(CALIB_KEY) || localStorage.getItem(CALIB_KEY) || localStorage.getItem(COMPAT_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    }
  };

  let pose = null, latestLm = null, grid = null; let leftDots = [], rightDots = [], axisLeft = null, axisRight = null;
  let running = false, savedOnce = false;

  const defaults = {
    count: 8, yTop: 0.12, yBottom: 0.85,
    leftX: 0.18, rightX: 0.82,
    hitRadius: 0.12, holdSeconds: 5,
    kFrames: 6, maxSpeedPerSec: 0.60, minVis: 0.55, needsHips: true,
    laneFollow: false, laneAlpha: 0.15, laneClamp: [0.08, 0.92]
  };

  // --- Layout & ladder
  function fitCanvas() {
    const r = stage.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(r.width));
    canvas.height = Math.max(1, Math.round(r.height));
    positionLadder();
  }
  window.addEventListener('resize', fitCanvas);

  function buildLadderUI() {
    ladderLayer.innerHTML = ""; leftDots = []; rightDots = []; axisLeft = axisRight = null;
    axisLeft = document.createElement('div'); axisLeft.className = 'axis'; ladderLayer.appendChild(axisLeft);
    axisRight = document.createElement('div'); axisRight.className = 'axis'; ladderLayer.appendChild(axisRight);
    for (let i = 0; i < grid.count; i++) {
      const dL = document.createElement('div'); dL.className = 'dot'; ladderLayer.appendChild(dL); leftDots.push(dL);
      const dR = document.createElement('div'); dR.className = 'dot'; ladderLayer.appendChild(dR); rightDots.push(dR);
    }
    positionLadder();
  }
  function positionLadder() {
    if (!grid) return; const r = stage.getBoundingClientRect(); const toPx = (xN, yN) => ({ x: xN * r.width, y: yN * r.height });
    const pAxisL = toPx(grid.leftX, 0), pAxisR = toPx(grid.rightX, 0);
    axisLeft.style.left = `${pAxisL.x}px`; axisLeft.style.height = `${r.height}px`;
    axisRight.style.left = `${pAxisR.x}px`; axisRight.style.height = `${r.height}px`;
    for (let i = 0; i < grid.count; i++) {
      const y = grid.yList[i]; const pL = toPx(grid.leftX, y), pR = toPx(grid.rightX, y);
      leftDots[i].style.left = `${pL.x}px`; leftDots[i].style.top = `${pL.y}px`;
      rightDots[i].style.left = `${pR.x}px`; rightDots[i].style.top = `${pR.y}px`;
    }
  }
  function updateLadderActive(leftActive, rightActive) {
    leftDots.forEach((d, i) => {
      d.classList.toggle('active-left', leftActive === (i + 1));
      d.classList.toggle('saved', grid.leftSaved === (i + 1));
      d.classList.toggle('maxreach', grid._maxRungL === (i + 1));
    });
    rightDots.forEach((d, i) => {
      d.classList.toggle('active-right', rightActive === (i + 1));
      d.classList.toggle('saved', grid.rightSaved === (i + 1));
      d.classList.toggle('maxreach', grid._maxRungR === (i + 1));
    });
  }

  function toast(msg) {
    const t = saveToast;
    t.textContent = msg; t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 1600);
  }

  function saveCalibration() {
    const neutral = (grid._rom.neutralSamples.length
      ? grid._rom.neutralSamples.reduce((a, b) => a + b, 0) / grid._rom.neutralSamples.length
      : (grid.yBottom ?? 0.85));

    const payload = {
      t: Date.now(), mirror: true,
      count: grid.count, yTop: grid.yTop, yBottom: grid.yBottom,
      leftX: grid.leftX, rightX: grid.rightX, hitRadius: grid.hitRadius,
      leftIndex: grid.leftSaved, rightIndex: grid.rightSaved,
      leftY: yAtIndex(grid.yList, grid.leftSaved), rightY: yAtIndex(grid.yList, grid.rightSaved),
      rom: { neutralY: neutral, maxReachLeftY: grid._minYLeft, maxReachRightY: grid._minYRight },
      version: "ladder-v2"
    };
    try {
      sessionStorage.setItem(CALIB_KEY, JSON.stringify(payload));
      localStorage.setItem(CALIB_KEY, JSON.stringify(payload));
      // compatibility for pages reading "calibration"
      localStorage.setItem(COMPAT_KEY, JSON.stringify(payload));
      toast("✅ Calibration saved.");
    } catch (e) {
      console.warn("Storage failed:", e); toast("⚠️ Couldn’t save to storage.");
    }
    return payload;
  }

  async function start() {
    if (running) return; running = true; btnStart.disabled = true; btnReset.disabled = false;
    sideTimer.textContent = defaults.holdSeconds.toFixed(1) + "s"; sideFill.style.width = "0%";
    setStatus("Starting camera…");

    const tries = [
      { video: { facingMode: { ideal: 'user' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
      { video: { facingMode: 'user' }, audio: false },
      { video: true, audio: false },
    ];
    let stream = null, lastErr = null;
    for (const c of tries) { try { stream = await navigator.mediaDevices.getUserMedia(c); break; } catch (e) { lastErr = e; } }
    if (!stream) { setStatus(`Camera error: ${lastErr?.message || lastErr}`); running = false; btnStart.disabled = false; btnReset.disabled = true; return; }
    video.srcObject = stream;
    await video.play().catch(() => {});

    fitCanvas();

    const PoseCtor =
      (window.Pose && window.Pose.Pose) ? window.Pose.Pose :
        (window.Pose) ? window.Pose :
          (window.pose && window.pose.Pose) ? window.pose.Pose :
            null;

    if (!PoseCtor) { setStatus("Pose constructor not found"); running = false; btnStart.disabled = false; return; }
    const pose = new PoseCtor({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${f}` });
    pose.setOptions({ modelComplexity: 1, smoothLandmarks: true, minDetectionConfidence: 0.6, minTrackingConfidence: 0.6 });
    pose.onResults(({ poseLandmarks }) => { latestLm = poseLandmarks || null; });

    if (typeof Camera === 'function') {
      const cam = new Camera(video, { onFrame: async () => { await pose.send({ image: video }); }, width: canvas.width, height: canvas.height });
      cam.start();
    } else {
      (async function loop() { await pose.send({ image: video }); requestAnimationFrame(loop); })();
    }

    grid = CalibAuto.create({ ...defaults });
    buildLadderUI();
    setStatus("Calibrating LEFT arm — hold a dot 5s (hips must be visible).");
    armLabel.textContent = "LEFT"; armDot.style.background = "#ffd1df";

    requestAnimationFrame(mainLoop);
  }

  function reset() {
    savedOnce = false; grid = CalibAuto.create({ ...defaults }); buildLadderUI();
    sideFill.style.width = "0%"; sideTimer.textContent = grid.holdSeconds.toFixed(1) + "s";
    kpiLeft.textContent = "–"; kpiRight.textContent = "–"; kpiSaved.textContent = "–"; kpiHold.textContent = "0.0s";
    hipTip.textContent = "Make sure your waist (hips) is visible to the camera.";
    armLabel.textContent = "LEFT"; armDot.style.background = "#ffd1df";
    setStatus("Calibration reset.");
  }

  function mainLoop() {
    if (!running) return;

    // draw mirrored video with cover crop
    const w = canvas.width, h = canvas.height;
    if (video.readyState >= 2) {
      const vw = video.videoWidth || 1280;
      const vh = video.videoHeight || 720;
      const scale = Math.max(w / vw, h / vh);
      const sw = w / scale, sh = h / scale;
      const sx = (vw - sw) / 2, sy = (vh - sh) / 2;

      ctx.save();
      ctx.scale(-1, 1);
      ctx.drawImage(video, sx, sy, sw, sh, -w, 0, w, h);
      ctx.restore();
    }

    positionLadder();

    const lm = latestLm;
    if (lm && grid) {
      const r = CalibAuto.update(grid, lm, { isMirrored });
      updateLadderActive(r.leftActive, r.rightActive);

      kpiLeft.textContent = r.leftActive ? String(r.leftActive) : "–";
      kpiRight.textContent = r.rightActive ? String(r.rightActive) : "–";
      kpiSaved.textContent = `${grid.leftSaved ?? "–"} / ${grid.rightSaved ?? "–"}`;
      kpiHold.textContent = `${(grid.holdSeconds * r.progress).toFixed(1)}s`;
      kpiTargets.textContent = `${grid.leftX.toFixed(2)} / ${grid.rightX.toFixed(2)}`;

      const remaining = Math.max(0, grid.holdSeconds * (1 - r.progress));
      sideTimer.textContent = `${remaining.toFixed(1)}s`;
      sideFill.style.width = `${(r.progress * 100).toFixed(1)}%`;

      const hipsOK = ((lm[23]?.visibility ?? 0) >= grid.minVis) && ((lm[24]?.visibility ?? 0) >= grid.minVis);
      hipTip.textContent = hipsOK ? "Hips detected — hold steady on a dot." : "Waist not detected — step back so hips are visible.";

      if (grid.step === "left") { armLabel.textContent = "LEFT"; armDot.style.background = "#ffd1df"; }
      else if (grid.step === "right") { armLabel.textContent = "RIGHT"; armDot.style.background = "#bfe1ff"; }

      if (grid.step === "done") {
  setStatus("Done! Calibration captured.");
  if (!savedOnce) {
    savedOnce = true;
    const payload = saveCalibration();
    console.log("[calibration] saved", payload);

    // get redirect target or default to dashboard
    const next = new URLSearchParams(location.search).get("next") || "exercise.html";


    // redirect after short delay
    // redirect after short delay (navigate parent if inside iframe)
setTimeout(() => {
  if (window.top && window.top !== window) {
    try { window.top.location.assign(next); }
    catch { window.location.assign(next); }
  } else {
    window.location.assign(next);
  }
}, 1000);

  }
}

    }
    requestAnimationFrame(mainLoop);
  }

  btnStart.onclick = () => start().catch(e => { setStatus(`Start failed: ${e?.message || e}`); btnStart.disabled = false; });
  btnReset.onclick = () => reset();

  // Session resume: if you want, auto-start camera on load:
  // start().catch(()=>{});
})();
