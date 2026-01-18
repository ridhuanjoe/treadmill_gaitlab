// Treadmill Gait Lab (Browser-only)
// Live Camera + Upload Video
// MediaPipe Pose (CDN) + side-view foot strike detection
//
// FIXES INCLUDED:
// 1) Correct constructor: new Pose(...)
// 2) Pinned locateFile to the SAME pose version used in index.html
// 3) stopAll() no longer overwrites error status
//
// Requirements:
// - Must be opened via GitHub Pages (HTTPS).
// - Use Safari/Chrome directly (avoid in-app browser).

const POSE_VERSION = "0.5.1675469404"; // must match index.html script version

const videoEl = document.getElementById("video");
const canvasEl = document.getElementById("overlay");
const ctx = canvasEl.getContext("2d");

const startCamBtn = document.getElementById("startCamBtn");
const stopBtn = document.getElementById("stopBtn");
const resetBtn = document.getElementById("resetBtn");

const videoFileInput = document.getElementById("videoFile");
const processUploadBtn = document.getElementById("processUploadBtn");

const downloadBtn = document.getElementById("downloadBtn");
const tbody = document.getElementById("tbody");

const speedInput = document.getElementById("speed");
const speedUnitSelect = document.getElementById("speedUnit");
const minStrikeMsInput = document.getElementById("minStrikeMs");
const smoothNInput = document.getElementById("smoothN");
const visThreshInput = document.getElementById("visThresh");

const qualityEl = document.getElementById("quality");
const facingEl = document.getElementById("facing");
const lastSideEl = document.getElementById("lastSide");
const lastFreqEl = document.getElementById("lastFreq");
const statusEl = document.getElementById("status");

let pose = null;
let running = false;
let usingUpload = false;

let stream = null;
let uploadedUrl = null;
let rafId = null;

// Export rows
const rows = [];

// Strike detection state
const footState = {
  R: { yHist: [], tLastStrike: null, lastMaxTime: null },
  L: { yHist: [], tLastStrike: null, lastMaxTime: null },
};
let lastAnyStrike = null;
let stepCount = 0;

// Tracking quality
let goodFrames = 0;
let totalFrames = 0;

// MediaPipe landmark indices
const IDX = {
  L_ANKLE: 27,
  R_ANKLE: 28,
  L_HEEL: 29,
  R_HEEL: 30,
};

// ---------------- Utilities ----------------
function setStatus(msg) {
  if (statusEl) statusEl.textContent = `Status: ${msg}`;
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

function nowVideoMs() {
  return videoEl.currentTime * 1000;
}

function setStatusQuality() {
  const q = totalFrames > 0 ? (goodFrames / totalFrames) : 0;
  if (q > 0.75) qualityEl.textContent = "Good";
  else if (q > 0.45) qualityEl.textContent = "Medium";
  else if (totalFrames > 15) qualityEl.textContent = "Poor";
  else qualityEl.textContent = "—";
}

function estimateFacingDirection(landmarks) {
  const leftIdx = [11, 23, 25, 27, 29, 31];
  const rightIdx = [12, 24, 26, 28, 30, 32];

  let l = 0, r = 0;
  for (const i of leftIdx) l += (landmarks[i]?.visibility ?? 0);
  for (const i of rightIdx) r += (landmarks[i]?.visibility ?? 0);

  const diff = l - r;
  if (Math.abs(diff) < 0.35) return "Unknown";
  return diff > 0 ? "Facing Right" : "Facing Left";
}

// --------------- Table + Export ---------------
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

// --------------- Strike Detection ---------------
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

function detectStrike(side, tMs, yPix, minStrikeMs, smoothN) {
  const st = footState[side];
  st.yHist.push(yPix);
  if (st.yHist.length > 60) st.yHist.shift();
  if (st.yHist.length < 5) return false;

  const ySm = movingAverage(st.yHist, smoothN);

  const ySeries = st.yHist.slice();
  ySeries[ySeries.length - 1] = ySm;

  const n = ySeries.length;
  const y2 = ySeries[n - 3];
  const y1 = ySeries[n - 2];
  const y0 = ySeries[n - 1];

  // local MAX in y => foot lowest point (image coords)
  const isLocalMax = (y1 > y2 && y1 > y0);
  if (!isLocalMax) return false;

  if (st.tLastStrike !== null && (tMs - st.tLastStrike) < minStrikeMs) return false;
  if (st.lastMaxTime !== null && (tMs - st.lastMaxTime) < Math.max(120, minStrikeMs * 0.5)) return false;

  st.lastMaxTime = tMs;
  return true;
}

function registerStrike(side, tMs) {
  const vMS = getSpeedMS();
  const st = footState[side];

  // stride
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

  // step
  let stepTimeMs = null, stepLenM = null;
  if (lastAnyStrike !== null && lastAnyStrike.side !== side) {
    stepTimeMs = tMs - lastAnyStrike.tMs;
    const stepTimeSec = stepTimeMs / 1000.0;
    if (stepTimeSec > 0) stepLenM = vMS * stepTimeSec;
  }

  lastAnyStrike = { side, tMs };

  stepCount += 1;
  const label = `${stepCount} – ${side === "R" ? "Right" : "Left"}`;
  addRowToTable({ stepLabel: label, stepTimeMs, stepLenM, strideTimeMs, strideLenM, strideFreqHz });

  lastSideEl.textContent = side === "R" ? "Right" : "Left";
  if (strideFreqHz !== null && isFinite(strideFreqHz)) lastFreqEl.textContent = fmt(strideFreqHz, 3);

  if (stepCount >= 10) stopAll(false);
}

// --------------- Drawing ---------------
function drawResults(results) {
  updateCanvasSize();
  ctx.save();
  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  ctx.drawImage(results.image, 0, 0, canvasEl.width, canvasEl.height);

  if (results.poseLandmarks) {
    drawConnectors(ctx, results.poseLandmarks, POSE_CONNECTIONS, { lineWidth: 3 });
    drawLandmarks(ctx, results.poseLandmarks, { lineWidth: 2, radius: 2 });
  }
  ctx.restore();
}

// --------------- Pose Callback ---------------
async function onPoseResults(results) {
  if (!running) return;

  totalFrames += 1;

  if (results.poseLandmarks && results.poseLandmarks.length > 0) {
    const visThresh = clamp(Number(visThreshInput.value || 0.55), 0, 1);
    const minStrikeMs = Math.max(120, Number(minStrikeMsInput.value || 300));
    const smoothN = Math.max(1, Math.min(15, Number(smoothNInput.value || 5)));

    facingEl.textContent = estimateFacingDirection(results.poseLandmarks);

    const tMs = nowVideoMs();
    const r = getFootY(results.poseLandmarks, "R", visThresh);
    const l = getFootY(results.poseLandmarks, "L", visThresh);

    if (r.ok && l.ok) goodFrames += 1;
    setStatusQuality();

    drawResults(results);

    if (r.ok && detectStrike("R", tMs, r.y, minStrikeMs, smoothN)) registerStrike("R", tMs);
    if (l.ok && detectStrike("L", tMs, l.y, minStrikeMs, smoothN)) registerStrike("L", tMs);
  } else {
    setStatusQuality();
    facingEl.textContent = "—";
  }
}

// --------------- Init MediaPipe Pose ---------------
async function initPose() {
  if (pose) return;

  // ✅ IMPORTANT: With CDN script tags, Pose is a constructor function.
  // Use `new Pose(...)`, NOT `new Pose.Pose(...)`.
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

// --------------- Frame Loop ---------------
async function loopSendFrames() {
  if (!running) return;

  try {
    await pose.send({ image: videoEl });
  } catch (e) {
    console.error(e);
    setStatus(`Pose send failed: ${e?.message || e}`);
    stopAll(false);
    return;
  }

  rafId = requestAnimationFrame(loopSendFrames);
}

function stopAll(setStoppedStatus = true) {
  running = false;

  stopBtn.disabled = true;
  startCamBtn.disabled = false;
  processUploadBtn.disabled = (videoFileInput.files.length === 0);

  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  if (usingUpload) {
    videoEl.pause();
  }

  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }

  if (setStoppedStatus) setStatus("Stopped");
}

function resetAllState() {
  footState.R.yHist = [];
  footState.L.yHist = [];
  footState.R.tLastStrike = null;
  footState.L.tLastStrike = null;
  footState.R.lastMaxTime = null;
  footState.L.lastMaxTime = null;

  lastAnyStrike = null;
  stepCount = 0;

  goodFrames = 0;
  totalFrames = 0;

  qualityEl.textContent = "—";
  facingEl.textContent = "—";
  lastSideEl.textContent = "—";
  lastFreqEl.textContent = "—";

  resetTable();
}

// --------------- UI Handlers ---------------
resetBtn.addEventListener("click", () => {
  resetAllState();
  setStatus("Reset");
});

stopBtn.addEventListener("click", () => stopAll(true));
downloadBtn.addEventListener("click", () => downloadCSV());

videoFileInput.addEventListener("change", () => {
  processUploadBtn.disabled = (videoFileInput.files.length === 0);
});

startCamBtn.addEventListener("click", async () => {
  try {
    await initPose();
    resetAllState();

    usingUpload = false;

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

    running = true;
    startCamBtn.disabled = true;
    stopBtn.disabled = false;
    processUploadBtn.disabled = true;

    setStatus("Live camera running");
    rafId = requestAnimationFrame(loopSendFrames);

  } catch (e) {
    console.error(e);
    setStatus(`Camera failed: ${e?.name || ""} ${e?.message || e}`);
    stopAll(false);
  }
});

processUploadBtn.addEventListener("click", async () => {
  try {
    await initPose();
    resetAllState();

    const file = videoFileInput.files[0];
    if (!file) {
      setStatus("Please choose a video file first.");
      return;
    }

    usingUpload = true;

    // stop camera
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

    running = true;
    startCamBtn.disabled = true;
    stopBtn.disabled = false;
    processUploadBtn.disabled = true;

    setStatus("Processing uploaded video…");
    rafId = requestAnimationFrame(async function uploadLoop() {
      if (!running) return;

      if (videoEl.ended) {
        setStatus("Upload processing finished");
        stopAll(false);
        return;
      }

      try {
        await pose.send({ image: videoEl });
      } catch (e) {
        console.error(e);
        setStatus(`Pose send failed: ${e?.message || e}`);
        stopAll(false);
        return;
      }

      rafId = requestAnimationFrame(uploadLoop);
    });

  } catch (e) {
    console.error(e);
    setStatus(`Upload failed: ${e?.message || e}`);
    stopAll(false);
  }
});

// --------------- Initial ---------------
resetAllState();
setStatus("Ready (open via GitHub Pages HTTPS link)");
