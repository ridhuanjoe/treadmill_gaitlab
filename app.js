// Treadmill Gait Lab (Browser-only)
// Implements:
// 1) More stable timing (upload uses requestVideoFrameCallback timestamps; live uses performance.now)
// 2) Ground line + crosshair + ground calibration button
// 3) Analyze workflow: 10s warm-up -> 5s countdown -> analyze 10 steps (camera stays on)
//
// Amendments in THIS version:
// - Step length now computed reliably in upload + live using per-foot last strike times
// - Step label is "Right" / "Left" (as requested)
// - Everything else unchanged

const POSE_VERSION = "0.5.1675469404";

const videoEl = document.getElementById("video");
const canvasEl = document.getElementById("overlay");
const ctx = canvasEl.getContext("2d");

const startCamBtn = document.getElementById("startCamBtn");
const stopBtn = document.getElementById("stopBtn");
const resetBtn = document.getElementById("resetBtn");

const setGroundBtn = document.getElementById("setGroundBtn");
const analyzeBtn = document.getElementById("analyzeBtn");

const videoFileInput = document.getElementById("videoFile");
const processUploadBtn = document.getElementById("processUploadBtn");

const downloadBtn = document.getElementById("downloadBtn");
const tbody = document.getElementById("tbody");

const speedInput = document.getElementById("speed");
const speedUnitSelect = document.getElementById("speedUnit");
const minStrikeMsInput = document.getElementById("minStrikeMs");
const smoothNInput = document.getElementById("smoothN");
const visThreshInput = document.getElementById("visThresh");
const groundTolPxInput = document.getElementById("groundTolPx");

const qualityEl = document.getElementById("quality");
const facingEl = document.getElementById("facing");
const lastSideEl = document.getElementById("lastSide");
const lastFreqEl = document.getElementById("lastFreq");
const statusEl = document.getElementById("status");
const hudEl = document.getElementById("hud");

let pose = null;

// Mode/state
let streamOn = false;
let runningLoop = false;
let usingUpload = false;
let analyzeState = "idle";

let stream = null;
let uploadedUrl = null;

// Frame/time handling
let rafId = null;
let lastFrameTimeMs = null;
let lastLandmarks = null;

// Ground line
let groundY = null;
let groundCalibrated = false;
let groundCalibrating = false;
let groundSamples = [];

// Export rows
const rows = [];

// Strike detection state
const footState = {
  R: { yHist: [], ySmHist: [], tLastStrike: null, lastMaxTime: null },
  L: { yHist: [], ySmHist: [], tLastStrike: null, lastMaxTime: null },
};

// For reliable STEP TIME: last accepted strike per foot
let lastStrikeTime = { R: null, L: null };

let lastAnyStrike = null; // {side, tMs} (used only as a global refractory reference)
let stepCount = 0;

// Tracking quality
let goodFrames = 0;
let totalFrames = 0;

// MediaPipe landmark indices
const IDX = {
  L_SHOULDER: 11,
  R_SHOULDER: 12,
  L_HIP: 23,
  R_HIP: 24,
  L_KNEE: 25,
  R_KNEE: 26,
  L_ANKLE: 27,
  R_ANKLE: 28,
  L_HEEL: 29,
  R_HEEL: 30,
  L_FOOT: 31,
  R_FOOT: 32,
};

// ---------------- Utilities ----------------
function setStatus(msg) {
  statusEl.textContent = `Status: ${msg}`;
}

function setHUD(msg) {
  hudEl.textContent = msg || "";
}

function getSpeedMS() {
  const v = Number(speedInput.value || 0);
  const unit = speedUnitSelect.value;
  if (!isFinite(v) || v <= 0) return 0;
  return unit === "kmh" ? (v / 3.6) : v;
}

function fmt(x, digits = 3) {
  if (x === null || x === undefined || !isFinite(x)) return "";
  return Number(x).toFixed(digits);
}

function fmtInt(x) {
  if (x === null || x === undefined || !isFinite(x)) return "";
  return Math.round(x).toString();
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function movingAverage(arr, n) {
  if (arr.length === 0) return null;
  const k = Math.min(n, arr.length);
  let s = 0;
  for (let i = arr.length - k; i < arr.length; i++) s += arr[i];
  return s / k;
}

function updateCanvasSize() {
  const w = videoEl.videoWidth || 1280;
  const h = videoEl.videoHeight || 720;
  canvasEl.width = w;
  canvasEl.height = h;
}

function getTimeMs() {
  if (lastFrameTimeMs !== null) return lastFrameTimeMs;
  return videoEl.currentTime * 1000;
}

function setStatusQuality() {
  const q = totalFrames > 0 ? (goodFrames / totalFrames) : 0;
  if (q > 0.75) qualityEl.textContent = "Good";
  else if (q > 0.45) qualityEl.textContent = "Medium";
  else if (totalFrames > 15) qualityEl.textContent = "Poor";
  else qualityEl.textContent = "—";
}

// Facing detection (side view)
function estimateFacingDirection(landmarks) {
  const leftIdx = [IDX.L_SHOULDER, IDX.L_HIP, IDX.L_KNEE, IDX.L_ANKLE, IDX.L_HEEL, IDX.L_FOOT];
  const rightIdx = [IDX.R_SHOULDER, IDX.R_HIP, IDX.R_KNEE, IDX.R_ANKLE, IDX.R_HEEL, IDX.R_FOOT];

  let l = 0, r = 0;
  for (const i of leftIdx) l += (landmarks[i]?.visibility ?? 0);
  for (const i of rightIdx) r += (landmarks[i]?.visibility ?? 0);

  const diff = l - r;
  if (Math.abs(diff) < 0.35) return "Unknown";
  return diff > 0 ? "Facing Right" : "Facing Left";
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const a = arr.slice().sort((x, y) => x - y);
  const idx = Math.floor((p / 100) * (a.length - 1));
  return a[idx];
}

// ---------------- Table + Export ----------------
function addRowToTable(rowObj) {
  rows.push(rowObj);

  const tr = document.createElement("tr");

  const tdStep = document.createElement("td");
  tdStep.textContent = rowObj.stepLabel;

  const tdStepTime = document.createElement("td");
  tdStepTime.textContent = fmtInt(rowObj.stepTimeMs);

  const tdStepLen = document.createElement("td");
  tdStepLen.textContent = fmt(rowObj.stepLenM, 3);

  const tdStrideTime = document.createElement("td");
  tdStrideTime.textContent = fmtInt(rowObj.strideTimeMs);

  const tdStrideLen = document.createElement("td");
  tdStrideLen.textContent = fmt(rowObj.strideLenM, 3);

  const tdStrideFreq = document.createElement("td");
  tdStrideFreq.textContent = fmt(rowObj.strideFreqHz, 3);

  tr.appendChild(tdStep);
  tr.appendChild(tdStepTime);
  tr.appendChild(tdStepLen);
  tr.appendChild(tdStrideTime);
  tr.appendChild(tdStrideLen);
  tr.appendChild(tdStrideFreq);

  tbody.appendChild(tr);
  downloadBtn.disabled = rows.length === 0;
}

function resetTable() {
  rows.length = 0;
  tbody.innerHTML = "";
  downloadBtn.disabled = true;
}

function downloadCSV() {
  if (rows.length === 0) return;

  const header = [
    "Step",
    "Step Time (ms)",
    "Step Length (m)",
    "Stride Time (ms)",
    "Stride Length (m)",
    "Stride Frequency (Hz)"
  ];

  const lines = [header.join(",")];

  for (const r of rows) {
    lines.push([
      `"${r.stepLabel}"`,
      r.stepTimeMs ?? "",
      r.stepLenM ?? "",
      r.strideTimeMs ?? "",
      r.strideLenM ?? "",
      r.strideFreqHz ?? ""
    ].join(","));
  }

  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `treadmill_gait_${new Date().toISOString().slice(0,19).replace(/[:T]/g,"-")}.csv`;
  a.click();
}

// ---------------- Ground line + drawing ----------------
function drawGroundOverlay() {
  if (groundY === null) return;

  ctx.save();

  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(232,236,255,0.85)";
  ctx.beginPath();
  ctx.moveTo(0, groundY);
  ctx.lineTo(canvasEl.width, groundY);
  ctx.stroke();

  const cx = canvasEl.width / 2;
  const cy = groundY;
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(232,236,255,0.65)";

  ctx.beginPath();
  ctx.moveTo(cx - 18, cy);
  ctx.lineTo(cx + 18, cy);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(cx, cy - 18);
  ctx.lineTo(cx, cy + 18);
  ctx.stroke();

  ctx.fillStyle = "rgba(232,236,255,0.9)";
  ctx.font = "16px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillText(groundCalibrated ? "Ground (calibrated)" : "Ground (estimated)", 12, Math.max(22, groundY - 10));

  ctx.restore();
}

function updateEstimatedGroundFromLandmarks(landmarks, visThresh) {
  if (groundCalibrated) return;

  const lh = landmarks[IDX.L_HEEL];
  const rh = landmarks[IDX.R_HEEL];
  const goodL = lh && (lh.visibility ?? 0) >= visThresh;
  const goodR = rh && (rh.visibility ?? 0) >= visThresh;

  if (!goodL && !goodR) return;

  const yL = goodL ? lh.y * canvasEl.height : null;
  const yR = goodR ? rh.y * canvasEl.height : null;

  const y = (yL !== null && yR !== null) ? Math.max(yL, yR) : (yL !== null ? yL : yR);

  if (groundY === null) groundY = y;
  else groundY = 0.9 * groundY + 0.1 * y;
}

// ---------------- Strike Detection ----------------
function getFootY(landmarks, side, visThresh) {
  const aIdx = side === "R" ? IDX.R_ANKLE : IDX.L_ANKLE;
  const hIdx = side === "R" ? IDX.R_HEEL : IDX.L_HEEL;

  const a = landmarks[aIdx];
  const h = landmarks[hIdx];
  if (!a || !h) return { ok: false, y: null };

  const aVis = (a.visibility ?? 0);
  const hVis = (h.visibility ?? 0);
  if (aVis < visThresh || hVis < visThresh) return { ok: false, y: null };

  const yPix = ((a.y + h.y) / 2) * canvasEl.height;
  return { ok: true, y: yPix };
}

function detectStrike(side, tMs, yPix, minStrikeMs, smoothN, groundTolPx) {
  const st = footState[side];

  st.yHist.push(yPix);
  if (st.yHist.length > 80) st.yHist.shift();

  const ySm = movingAverage(st.yHist, smoothN);
  st.ySmHist.push(ySm);
  if (st.ySmHist.length > 80) st.ySmHist.shift();

  if (st.ySmHist.length < 5) return false;

  const n = st.ySmHist.length;
  const y2 = st.ySmHist[n - 3];
  const y1 = st.ySmHist[n - 2];
  const y0 = st.ySmHist[n - 1];

  const isLocalMax = (y1 > y2 && y1 > y0);
  if (!isLocalMax) return false;

  const dyPrev = y1 - y2;
  const dyNext = y0 - y1;
  const hasSignChange = (dyPrev > 0 && dyNext < 0);
  if (!hasSignChange) return false;

  if (groundY !== null) {
    const nearGround = Math.abs(y1 - groundY) <= groundTolPx;
    if (!nearGround) return false;
  }

  if (st.tLastStrike !== null && (tMs - st.tLastStrike) < minStrikeMs) return false;

  if (st.lastMaxTime !== null && (tMs - st.lastMaxTime) < Math.max(120, minStrikeMs * 0.5)) return false;

  st.lastMaxTime = tMs;
  return true;
}

// ---------------- IMPORTANT: UPDATED registerStrike (step time/length fix + Right/Left labels) ----------------
function registerStrike(side, tMs) {
  const vMS = getSpeedMS();
  const st = footState[side];

  // global refractory (avoid double-count in same instant)
  if (lastAnyStrike && (tMs - lastAnyStrike.tMs) < 120) return;

  // ----- STRIDE (same foot) -----
  let strideTimeMs = null, strideLenM = null, strideFreqHz = null;
  if (st.tLastStrike !== null) {
    strideTimeMs = tMs - st.tLastStrike;
    const strideTimeSec = strideTimeMs / 1000.0;
    if (strideTimeSec > 0) {
      strideFreqHz = 1.0 / strideTimeSec;
      strideLenM = vMS * strideTimeSec;
    }
  }
  st.tLastStrike = tMs;

  // ----- STEP (opposite foot) -----
  const opp = (side === "R") ? "L" : "R";
  let stepTimeMs = null, stepLenM = null;

  if (lastStrikeTime[opp] !== null) {
    stepTimeMs = tMs - lastStrikeTime[opp];
    const stepTimeSec = stepTimeMs / 1000.0;
    if (stepTimeSec > 0) stepLenM = vMS * stepTimeSec;
  }

  // update last strike time for this foot
  lastStrikeTime[side] = tMs;

  // keep a reference time for global refractory only
  lastAnyStrike = { side, tMs };

  stepCount += 1;
  const label = (side === "R") ? "Right" : "Left";

  addRowToTable({
    stepLabel: label,
    stepTimeMs,
    stepLenM,
    strideTimeMs,
    strideLenM,
    strideFreqHz
  });

  lastSideEl.textContent = label;
  if (strideFreqHz !== null && isFinite(strideFreqHz)) lastFreqEl.textContent = fmt(strideFreqHz, 3);

  if (stepCount >= 10) {
    if (usingUpload) {
      stopAll(true);
      setStatus("Upload analysis finished (10 steps)");
    } else {
      stopAnalysisOnly();
      setStatus("Analysis finished (10 steps). You can Analyze again.");
    }
  }
}

// ---------------- Drawing ----------------
function drawResults(results) {
  updateCanvasSize();

  ctx.save();
  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

  ctx.drawImage(results.image, 0, 0, canvasEl.width, canvasEl.height);

  if (results.poseLandmarks) {
    drawConnectors(ctx, results.poseLandmarks, POSE_CONNECTIONS, { lineWidth: 3 });
    drawLandmarks(ctx, results.poseLandmarks, { lineWidth: 2, radius: 2 });
  }

  drawGroundOverlay();
  ctx.restore();
}

// ---------------- Pose callback ----------------
async function onPoseResults(results) {
  if (!runningLoop) return;

  totalFrames += 1;

  if (results.poseLandmarks && results.poseLandmarks.length > 0) {
    lastLandmarks = results.poseLandmarks;

    const visThresh = clamp(Number(visThreshInput.value || 0.55), 0, 1);
    const minStrikeMs = Math.max(120, Number(minStrikeMsInput.value || 300));
    const smoothN = Math.max(1, Math.min(15, Number(smoothNInput.value || 5)));
    const groundTolPx = Math.max(5, Math.min(80, Number(groundTolPxInput.value || 18)));

    facingEl.textContent = estimateFacingDirection(results.poseLandmarks);

    updateEstimatedGroundFromLandmarks(results.poseLandmarks, visThresh);

    if (groundCalibrating) {
      const lh = results.poseLandmarks[IDX.L_HEEL];
      const rh = results.poseLandmarks[IDX.R_HEEL];
      const goodL = lh && (lh.visibility ?? 0) >= visThresh;
      const goodR = rh && (rh.visibility ?? 0) >= visThresh;
      if (goodL) groundSamples.push(lh.y * canvasEl.height);
      if (goodR) groundSamples.push(rh.y * canvasEl.height);
    }

    const rOk = (results.poseLandmarks[IDX.R_HEEL]?.visibility ?? 0) >= visThresh &&
                (results.poseLandmarks[IDX.R_ANKLE]?.visibility ?? 0) >= visThresh;
    const lOk = (results.poseLandmarks[IDX.L_HEEL]?.visibility ?? 0) >= visThresh &&
                (results.poseLandmarks[IDX.L_ANKLE]?.visibility ?? 0) >= visThresh;
    if (rOk && lOk) goodFrames += 1;
    setStatusQuality();

    drawResults(results);

    if (analyzeState === "analyzing" || usingUpload) {
      const tMs = getTimeMs();
      const r = getFootY(results.poseLandmarks, "R", visThresh);
      const l = getFootY(results.poseLandmarks, "L", visThresh);

      if (r.ok && detectStrike("R", tMs, r.y, minStrikeMs, smoothN, groundTolPx)) registerStrike("R", tMs);
      if (l.ok && detectStrike("L", tMs, l.y, minStrikeMs, smoothN, groundTolPx)) registerStrike("L", tMs);
    }

  } else {
    setStatusQuality();
    facingEl.textContent = "—";
    drawResults(results);
  }
}

// ---------------- MediaPipe Pose init ----------------
async function initPose() {
  if (pose) return;

  pose = new Pose({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose@${POSE_VERSION}/${file}`
  });

  pose.setOptions({
    modelComplexity: 1,
    smoothLandmarks: true,
    enableSegmentation: false,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
  });

  pose.onResults(onPoseResults);
}

// ---------------- Ground calibration ----------------
async function calibrateGroundLine() {
  if (!streamOn || !runningLoop) {
    setStatus("Start Live Camera first, then set ground line.");
    return;
  }

  groundCalibrating = true;
  groundSamples = [];
  setStatus("Calibrating ground line… keep feet visible (1 second)");
  setHUD("CALIBRATING…");

  await new Promise((resolve) => setTimeout(resolve, 1000));

  groundCalibrating = false;
  setHUD("");

  if (groundSamples.length < 10) {
    setStatus("Ground calibration failed (feet not visible enough). Try again.");
    return;
  }

  const gy = percentile(groundSamples, 90);
  groundY = gy;
  groundCalibrated = true;

  setStatus("Ground line set (calibrated).");
}

// ---------------- Analyze workflow (live) ----------------
async function runAnalyzeWorkflow() {
  if (!streamOn || !runningLoop) {
    setStatus("Start Live Camera first, then press Analyze.");
    return;
  }

  analyzeBtn.disabled = true;
  setGroundBtn.disabled = true;
  processUploadBtn.disabled = true;

  analyzeState = "warmup";
  setStatus("Warm-up: run naturally (10 seconds).");
  setHUD("WARM-UP 10s");
  await sleepWithCountdownHUD(10, "WARM-UP");

  analyzeState = "countdown";
  setStatus("Get ready… analysis begins soon.");
  for (let i = 5; i >= 1; i--) {
    setHUD(`ANALYZE IN ${i}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  setHUD("");

  resetAnalysisMetricsOnly();
  analyzeState = "analyzing";
  setStatus("Analyzing… capturing 10 steps.");
  setHUD("ANALYZING…");
}

async function sleepWithCountdownHUD(seconds, label) {
  for (let s = seconds; s >= 1; s--) {
    setHUD(`${label} ${s}s`);
    await new Promise((r) => setTimeout(r, 1000));
    if (analyzeState !== "warmup") break;
  }
  setHUD("");
}

function resetAnalysisMetricsOnly() {
  footState.R.yHist = [];
  footState.L.yHist = [];
  footState.R.ySmHist = [];
  footState.L.ySmHist = [];
  footState.R.tLastStrike = null;
  footState.L.tLastStrike = null;
  footState.R.lastMaxTime = null;
  footState.L.lastMaxTime = null;

  lastAnyStrike = null;
  lastStrikeTime = { R: null, L: null }; // important for step length

  stepCount = 0;

  lastSideEl.textContent = "—";
  lastFreqEl.textContent = "—";

  resetTable();
}

function stopAnalysisOnly() {
  analyzeState = "idle";
  setHUD("");
  setStatusQuality();

  analyzeBtn.disabled = false;
  setGroundBtn.disabled = false;
  processUploadBtn.disabled = (videoFileInput.files.length === 0);

  setHUD("");
}

// ---------------- Live camera loop ----------------
async function loopLiveFrames() {
  if (!runningLoop) return;

  try {
    lastFrameTimeMs = performance.now();
    await pose.send({ image: videoEl });
  } catch (e) {
    console.error(e);
    setStatus(`Pose error: ${e?.message || e}`);
    stopAll(true);
    return;
  }

  rafId = requestAnimationFrame(loopLiveFrames);
}

// ---------------- Upload processing loop ----------------
function startUploadFrameLoop() {
  const hasRVFC = typeof videoEl.requestVideoFrameCallback === "function";

  const tickRAF = async () => {
    if (!runningLoop) return;

    if (videoEl.ended) {
      setStatus("Upload finished.");
      stopAll(true);
      return;
    }

    lastFrameTimeMs = videoEl.currentTime * 1000;

    try {
      await pose.send({ image: videoEl });
    } catch (e) {
      console.error(e);
      setStatus(`Pose error: ${e?.message || e}`);
      stopAll(true);
      return;
    }

    rafId = requestAnimationFrame(tickRAF);
  };

  if (!hasRVFC) {
    rafId = requestAnimationFrame(tickRAF);
    return;
  }

  const tickRVFC = async (_now, metadata) => {
    if (!runningLoop) return;

    if (videoEl.ended) {
      setStatus("Upload finished.");
      stopAll(true);
      return;
    }

    lastFrameTimeMs = metadata.mediaTime * 1000;

    try {
      await pose.send({ image: videoEl });
    } catch (e) {
      console.error(e);
      setStatus(`Pose error: ${e?.message || e}`);
      stopAll(true);
      return;
    }

    videoEl.requestVideoFrameCallback(tickRVFC);
  };

  videoEl.requestVideoFrameCallback(tickRVFC);
}

// ---------------- Stop / Reset / Export ----------------
function stopAll(setStoppedStatus = true) {
  analyzeState = "idle";
  usingUpload = false;

  runningLoop = false;
  streamOn = false;

  stopBtn.disabled = true;
  startCamBtn.disabled = false;

  analyzeBtn.disabled = true;
  setGroundBtn.disabled = true;

  processUploadBtn.disabled = (videoFileInput.files.length === 0);

  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }

  if (uploadedUrl) {
    URL.revokeObjectURL(uploadedUrl);
    uploadedUrl = null;
  }

  setHUD("");
  if (setStoppedStatus) setStatus("Stopped");
}

function resetAllState() {
  groundY = null;
  groundCalibrated = false;
  groundCalibrating = false;
  groundSamples = [];

  lastLandmarks = null;

  goodFrames = 0;
  totalFrames = 0;
  qualityEl.textContent = "—";
  facingEl.textContent = "—";
  lastSideEl.textContent = "—";
  lastFreqEl.textContent = "—";

  resetAnalysisMetricsOnly();
  setHUD("");
}

// ---------------- Events ----------------
downloadBtn.addEventListener("click", () => downloadCSV());

resetBtn.addEventListener("click", () => {
  resetAllState();
  setStatus("Reset");
});

stopBtn.addEventListener("click", () => stopAll(true));

videoFileInput.addEventListener("change", () => {
  processUploadBtn.disabled = (videoFileInput.files.length === 0);
});

setGroundBtn.addEventListener("click", async () => {
  await calibrateGroundLine();
});

analyzeBtn.addEventListener("click", async () => {
  if (analyzeState !== "idle") return;
  await runAnalyzeWorkflow();
});

// ---------------- Start Live Camera ----------------
startCamBtn.addEventListener("click", async () => {
  try {
    await initPose();
    resetAllState();

    usingUpload = false;
    setHUD("");

    if (uploadedUrl) {
      URL.revokeObjectURL(uploadedUrl);
      uploadedUrl = null;
    }

    videoEl.srcObject = null;
    videoEl.src = "";
    videoEl.muted = true;
    videoEl.playsInline = true;

    setStatus("Requesting camera permission…");

    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    };

    stream = await navigator.mediaDevices.getUserMedia(constraints);
    videoEl.srcObject = stream;

    await videoEl.play();

    streamOn = true;
    runningLoop = true;

    startCamBtn.disabled = true;
    stopBtn.disabled = false;

    setGroundBtn.disabled = false;
    analyzeBtn.disabled = false;

    processUploadBtn.disabled = true;

    setStatus("Live camera running. Set ground line, then Analyze.");
    rafId = requestAnimationFrame(loopLiveFrames);

  } catch (e) {
    console.error(e);
    setStatus(`Camera failed: ${e?.name || ""} ${e?.message || e}`);
    stopAll(false);
  }
});

// ---------------- Process Uploaded Video ----------------
processUploadBtn.addEventListener("click", async () => {
  try {
    await initPose();
    resetAllState();

    const file = videoFileInput.files[0];
    if (!file) {
      setStatus("Choose a video file first.");
      return;
    }

    usingUpload = true;
    analyzeState = "idle";

    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }

    if (uploadedUrl) URL.revokeObjectURL(uploadedUrl);
    uploadedUrl = URL.createObjectURL(file);

    videoEl.srcObject = null;
    videoEl.src = uploadedUrl;
    videoEl.muted = true;
    videoEl.playsInline = true;

    setStatus("Loading uploaded video…");
    await videoEl.play();

    startCamBtn.disabled = true;
    stopBtn.disabled = false;

    setGroundBtn.disabled = true;
    analyzeBtn.disabled = true;

    setStatus("Processing upload… capturing 10 steps.");
    setHUD("UPLOADED VIDEO");

    runningLoop = true;
    streamOn = false;

    startUploadFrameLoop();

  } catch (e) {
    console.error(e);
    setStatus(`Upload failed: ${e?.message || e}`);
    stopAll(false);
  }
});

// ---------------- Initial UI ----------------
function initUI() {
  resetAllState();

  startCamBtn.disabled = false;
  stopBtn.disabled = true;

  setGroundBtn.disabled = true;
  analyzeBtn.disabled = true;

  processUploadBtn.disabled = true;
  downloadBtn.disabled = true;

  setStatus("Ready (open via GitHub Pages HTTPS link)");
}


// ---------------- Table header tooltips (not clipped by scroll container) ----------------
let _tipBubble = null;
let _tipArrow = null;
let _tipHideTimer = null;

function initTableHeaderTooltips() {
  const icons = document.querySelectorAll("#resultsTable thead .info[data-tip]");
  if (!icons.length) return;

  // Create shared tooltip elements once
  _tipBubble = document.createElement("div");
  _tipBubble.className = "tooltip-bubble";
  _tipBubble.setAttribute("role", "tooltip");

  _tipArrow = document.createElement("div");
  _tipArrow.className = "tooltip-arrow";

  document.body.appendChild(_tipBubble);
  document.body.appendChild(_tipArrow);

  const show = (el) => {
    const text = el.getAttribute("data-tip");
    if (!text) return;

    if (_tipHideTimer) {
      clearTimeout(_tipHideTimer);
      _tipHideTimer = null;
    }

    _tipBubble.textContent = text;

    _tipBubble.classList.remove("below", "show");
    _tipArrow.classList.remove("below", "show");

    _tipBubble.style.display = "block";
    _tipArrow.style.display = "block";

    const iconRect = el.getBoundingClientRect();

    // Measure bubble
    _tipBubble.style.left = "0px";
    _tipBubble.style.top = "0px";
    _tipBubble.style.opacity = "0";
    const bubbleRect = _tipBubble.getBoundingClientRect();

    let x = iconRect.left + iconRect.width / 2;
    const halfW = bubbleRect.width / 2;
    x = Math.max(10 + halfW, Math.min(window.innerWidth - 10 - halfW, x));

    const margin = 10;
    const placeAbove = iconRect.top > bubbleRect.height + margin + 10;

    if (placeAbove) {
      const top = iconRect.top - 10; // anchor point above icon
      _tipBubble.style.left = `${x}px`;
      _tipBubble.style.top = `${top}px`;
      _tipBubble.classList.remove("below");

      _tipArrow.style.left = `${x}px`;
      _tipArrow.style.top = `${iconRect.top - 12}px`;
      _tipArrow.classList.remove("below");
    } else {
      const top = iconRect.bottom + 10;
      _tipBubble.style.left = `${x}px`;
      _tipBubble.style.top = `${top}px`;
      _tipBubble.classList.add("below");

      _tipArrow.style.left = `${x}px`;
      _tipArrow.style.top = `${iconRect.bottom + 2}px`;
      _tipArrow.classList.add("below");
    }

    requestAnimationFrame(() => {
      _tipBubble.classList.add("show");
      _tipArrow.classList.add("show");
      _tipBubble.style.opacity = "";
    });
  };

  const hide = () => {
    if (!_tipBubble) return;
    _tipBubble.classList.remove("show");
    _tipArrow.classList.remove("show");
    _tipHideTimer = setTimeout(() => {
      if (_tipBubble) _tipBubble.style.display = "none";
      if (_tipArrow) _tipArrow.style.display = "none";
      _tipHideTimer = null;
    }, 120);
  };

  icons.forEach((el) => {
    el.addEventListener("mouseenter", () => show(el));
    el.addEventListener("mouseleave", hide);
    el.addEventListener("focus", () => show(el));
    el.addEventListener("blur", hide);

    // Mobile: tap toggles
    el.addEventListener("touchstart", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const visible = _tipBubble && _tipBubble.classList.contains("show");
      if (visible) hide();
      else show(el);
    }, { passive: false });
  });

  document.addEventListener("touchstart", hide, { passive: true });
  document.addEventListener("click", hide);
  window.addEventListener("scroll", hide, { passive: true });
  window.addEventListener("resize", hide);
}


initTableHeaderTooltips();

initUI();
