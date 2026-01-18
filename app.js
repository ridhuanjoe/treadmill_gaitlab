// Treadmill Gait Lab (Browser-only)
// Implements:
// 1) More stable timing (upload uses requestVideoFrameCallback timestamps; live uses performance.now)
// 2) Ground line + crosshair + ground calibration button
// 3) Analyze workflow: 10s warm-up -> 5s countdown -> analyze 10 steps (camera stays on)
//
// Notes:
// - Side view, one runner.
// - Lengths are treadmill-derived: speed (m/s) * time (sec).
// - Strike detection: local MAX in foot vertical position + velocity sign change,
//   plus optional "near ground" gate for consistency.

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
// - streamOn: camera active
// - runningLoop: pose loop active
// - analyzeState: "idle" | "warmup" | "countdown" | "analyzing"
let streamOn = false;
let runningLoop = false;
let usingUpload = false;
let analyzeState = "idle";

let stream = null;
let uploadedUrl = null;

// Frame/time handling
let rafId = null;
let lastFrameTimeMs = null; // set by live (performance.now) or upload (requestVideoFrameCallback metadata)
let lastLandmarks = null;   // last pose landmarks (for ground calibration)

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

let lastAnyStrike = null; // {side, tMs}
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
  // Use lastFrameTimeMs if available (upload) else fallback
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

  // Ground line
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(232,236,255,0.85)";
  ctx.beginPath();
  ctx.moveTo(0, groundY);
  ctx.lineTo(canvasEl.width, groundY);
  ctx.stroke();

  // Crosshair at center
  const cx = canvasEl.width / 2;
  const cy = groundY;
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(232,236,255,0.65)";

  ctx.beginPath();
  ctx.moveTo(cx - 18, cy);
  ctx.lineTo(cx + 18, cy
