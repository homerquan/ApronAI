import * as THREE from "https://unpkg.com/three@0.164.1/build/three.module.js";
import { ARButton } from "https://unpkg.com/three@0.164.1/examples/jsm/webxr/ARButton.js";

const statusEl = document.getElementById("status");
const startSessionBtn = document.getElementById("startSessionBtn");
const arButtonSlot = document.getElementById("arButtonSlot");
const micFeedStatusEl = document.getElementById("micFeedStatus");
const cameraFeedStatusEl = document.getElementById("cameraFeedStatus");
const progressUpdatedEl = document.getElementById("progress-updated");
const progressListEl = document.getElementById("progress-list");
const transcriptHistoryEl = document.getElementById("transcript-history");
const transcriptCurrentEl = document.getElementById("transcript-current");
const xrContainer = document.getElementById("xr-container");
const cameraSource = document.getElementById("camera-source");
const cameraCanvas = document.getElementById("camera-canvas");

const defaultProgress = {
  updated_at: null,
  steps: [
    { step: 1, text: "Bring a pot of water to a rolling boil.", status: "wait" },
    { step: 2, text: "Add salt, then add pasta.", status: "wait" },
    { step: 3, text: "Stir and cook until al dente.", status: "wait" },
    { step: 4, text: "Reserve a little pasta water, then drain.", status: "wait" },
    { step: 5, text: "Combine with sauce and finish for 1-2 minutes.", status: "wait" },
  ],
};

const mediaHandler = new MediaHandler();

let modelSessionActive = false;
let sessionConnectRequested = false;
let startupTimeoutId = null;
let startSessionRetryId = null;
let micCaptureActive = false;

let cameraFeedStream = null;
let cameraFeedInterval = null;

let renderer = null;
let scene = null;
let camera = null;
let arLaunchButton = null;
let xrReady = false;
let currentGeminiTranscript = "";
const transcriptHistory = [];

function setStatus(text, kind = "disconnected") {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

function clearStartupTimeout() {
  if (startupTimeoutId) {
    clearTimeout(startupTimeoutId);
    startupTimeoutId = null;
  }
}

function clearStartSessionRetry() {
  if (startSessionRetryId) {
    clearInterval(startSessionRetryId);
    startSessionRetryId = null;
  }
}

function sendStartSessionSignal() {
  if (!sessionConnectRequested || modelSessionActive) return;
  if (!geminiClient.isConnected()) return;
  geminiClient.startSession();
}

function beginStartSessionHandshake() {
  clearStartSessionRetry();
  sendStartSessionSignal();
  startSessionRetryId = setInterval(sendStartSessionSignal, 1000);
}

function armStartupTimeout() {
  clearStartupTimeout();
  startupTimeoutId = setTimeout(() => {
    if (modelSessionActive) return;
    sessionConnectRequested = false;
    clearStartSessionRetry();
    startSessionBtn.disabled = false;
    startSessionBtn.textContent = "Start Session";
    setStatus("Start timed out. Retry session startup.", "error");
    if (geminiClient.isConnected()) geminiClient.disconnect();
  }, 12000);
}

function updateTranscriptView() {
  transcriptCurrentEl.textContent =
    currentGeminiTranscript || "Waiting for AI transcript...";
  transcriptHistoryEl.textContent = transcriptHistory.join(" ");
}

function appendGeminiTranscript(textChunk) {
  currentGeminiTranscript += textChunk;
  updateTranscriptView();
}

function finalizeGeminiTranscript() {
  const line = currentGeminiTranscript.trim();
  if (!line) return;
  transcriptHistory.push(line);
  if (transcriptHistory.length > 2) {
    transcriptHistory.shift();
  }
  currentGeminiTranscript = "";
  updateTranscriptView();
}

function formatUpdatedTime(unixTs) {
  if (!unixTs) return "Not started yet";
  return `Updated ${new Date(unixTs * 1000).toLocaleTimeString()}`;
}

function renderProgress(progress) {
  if (!progress || !Array.isArray(progress.steps)) return;
  progressListEl.innerHTML = "";
  for (const step of progress.steps) {
    const row = document.createElement("div");
    row.className = `progress-item ${step.status}`;

    const text = document.createElement("div");
    text.className = "progress-step";
    text.textContent = `Step ${step.step}: ${step.text}`;

    const state = document.createElement("div");
    state.className = "progress-state";
    state.textContent = step.status === "in_progress" ? "IN PROGRESS" : step.status.toUpperCase();

    row.appendChild(text);
    row.appendChild(state);
    progressListEl.appendChild(row);
  }

  progressUpdatedEl.textContent = formatUpdatedTime(progress.updated_at);
}

async function loadProgress() {
  try {
    const res = await fetch("/api/progress", { cache: "no-store" });
    if (!res.ok) return;
    const payload = await res.json();
    renderProgress(payload);
  } catch (error) {
    console.error("Failed to load progress:", error);
  }
}

function handleJsonMessage(msg) {
  if (msg.type === "ready") {
    if (sessionConnectRequested && !modelSessionActive) {
      sendStartSessionSignal();
      setStatus("Connected (starting model session...)", "connected");
    } else {
      setStatus("Connected (ready)", "connected");
    }
    return;
  }

  if (msg.type === "session_started") {
    clearStartupTimeout();
    clearStartSessionRetry();
    modelSessionActive = true;
    sessionConnectRequested = false;
    startSessionBtn.textContent = "Session Running";
    startSessionBtn.disabled = true;
    setStatus("Connected", "connected");
    loadProgress();
    geminiClient.sendText(
      "System: You are an AR pasta-cooking coach. Keep instructions concise and step-focused."
    );
    return;
  }

  if (msg.type === "progress" && msg.progress) {
    renderProgress(msg.progress);
    return;
  }

  if (msg.type === "session_restarting") {
    const mode = msg.resuming ? "resuming context" : "starting fresh context";
    setStatus(`Connected (restarting model session, ${mode})`, "connected");
    return;
  }

  if (msg.type === "error") {
    setStatus("Connected (recovering from model error...)", "connected");
    currentGeminiTranscript = `[error] ${msg.error || "unknown error"}`;
    updateTranscriptView();
    return;
  }

  if (msg.type === "turn_complete") {
    finalizeGeminiTranscript();
    return;
  }

  if (msg.type === "gemini" && msg.text) {
    appendGeminiTranscript(msg.text);
  }
}

const geminiClient = new GeminiClient({
  onOpen: () => {
    setStatus("Connected (starting model session...)", "connected");
    if (sessionConnectRequested) {
      beginStartSessionHandshake();
    }
  },
  onMessage: (event) => {
    if (typeof event.data === "string") {
      try {
        const payload = JSON.parse(event.data);
        handleJsonMessage(payload);
      } catch (error) {
        console.error("JSON parse error:", error);
      }
      return;
    }

    mediaHandler.playAudio(event.data);
  },
  onClose: () => {
    clearStartupTimeout();
    clearStartSessionRetry();
    modelSessionActive = false;
    sessionConnectRequested = false;
    stopMicCapture();
    stopCameraFeed();
    startSessionBtn.disabled = false;
    startSessionBtn.textContent = "Start Session";
    setStatus("Disconnected", "disconnected");
  },
  onError: () => {
    clearStartupTimeout();
    clearStartSessionRetry();
    stopMicCapture();
    stopCameraFeed();
    setStatus("Connection Error", "error");
    startSessionBtn.disabled = false;
    startSessionBtn.textContent = "Start Session";
  },
});

function setupThreeScene() {
  if (renderer) return;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(xrContainer.clientWidth, xrContainer.clientHeight);
  renderer.xr.enabled = true;
  xrContainer.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(
    60,
    xrContainer.clientWidth / xrContainer.clientHeight,
    0.01,
    20
  );

  const light = new THREE.HemisphereLight(0xffffff, 0x667788, 1.2);
  scene.add(light);

  // Minimal anchor marker so the AR scene is not empty.
  const marker = new THREE.Mesh(
    new THREE.RingGeometry(0.06, 0.08, 32),
    new THREE.MeshBasicMaterial({ color: 0x28c0a8, transparent: true, opacity: 0.8 })
  );
  marker.rotation.x = -Math.PI / 2;
  marker.position.set(0, -0.2, -0.6);
  scene.add(marker);

  arLaunchButton = ARButton.createButton(renderer, {
    optionalFeatures: ["dom-overlay"],
    domOverlay: { root: document.body },
  });
  arLaunchButton.classList.add("btn", "ar-native-btn");
  arLaunchButton.style.position = "static";
  arLaunchButton.style.bottom = "auto";
  arLaunchButton.style.left = "auto";
  arLaunchButton.style.transform = "none";
  arLaunchButton.style.margin = "0";
  arLaunchButton.style.width = "100%";
  arButtonSlot.innerHTML = "";
  arButtonSlot.appendChild(arLaunchButton);

  renderer.xr.addEventListener("sessionstart", () => {
    setStatus("Connected (AR active)", "connected");
  });
  renderer.xr.addEventListener("sessionend", () => {
    setStatus(modelSessionActive ? "Connected" : "Connected (ready)", "connected");
  });

  renderer.setAnimationLoop(() => {
    renderer.render(scene, camera);
  });

  window.addEventListener("resize", () => {
    if (!renderer || !camera) return;
    const width = xrContainer.clientWidth;
    const height = xrContainer.clientHeight;
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  });
}

async function ensureArSupport() {
  if (!navigator.xr || !navigator.xr.isSessionSupported) return false;
  try {
    return await navigator.xr.isSessionSupported("immersive-ar");
  } catch (error) {
    console.warn("XR support check failed:", error);
    return false;
  }
}

function stopCameraFeed() {
  if (cameraFeedInterval) {
    clearInterval(cameraFeedInterval);
    cameraFeedInterval = null;
  }
  if (cameraFeedStream) {
    cameraFeedStream.getTracks().forEach((track) => track.stop());
    cameraFeedStream = null;
  }
  cameraSource.srcObject = null;
  cameraFeedStatusEl.textContent = "Camera feed to backend: inactive";
}

async function startMicCapture() {
  if (micCaptureActive || mediaHandler.isRecording) {
    micCaptureActive = true;
    micFeedStatusEl.textContent = "Mic to backend: active";
    return true;
  }

  try {
    await mediaHandler.startAudio((data) => {
      if (geminiClient.isConnected()) {
        geminiClient.send(data);
      }
    });
    micCaptureActive = true;
    micFeedStatusEl.textContent = "Mic to backend: active";
    return true;
  } catch (error) {
    console.error("Mic capture start failed:", error);
    micCaptureActive = false;
    micFeedStatusEl.textContent = "Mic to backend: unavailable";
    return false;
  }
}

function stopMicCapture() {
  if (mediaHandler.isRecording) {
    mediaHandler.stopAudio();
  }
  micCaptureActive = false;
  micFeedStatusEl.textContent = "Mic to backend: inactive";
}

function sendCameraFrameToBackend() {
  if (!cameraFeedStream || !geminiClient.isConnected()) return;

  const width = 640;
  const height = 480;
  cameraCanvas.width = width;
  cameraCanvas.height = height;
  const ctx = cameraCanvas.getContext("2d");
  ctx.drawImage(cameraSource, 0, 0, width, height);

  const base64 = cameraCanvas.toDataURL("image/jpeg", 0.7).split(",")[1];
  geminiClient.sendImage(base64);
}

async function startCameraFeed() {
  if (cameraFeedStream) return true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" } },
    });
    cameraFeedStream = stream;
    cameraSource.srcObject = stream;
    await cameraSource.play().catch(() => {});

    cameraFeedInterval = setInterval(sendCameraFrameToBackend, 1000);
    cameraFeedStatusEl.textContent =
      "Camera feed to backend: active (1 fps side stream)";
    return true;
  } catch (error) {
    console.error("Camera feed start failed:", error);
    cameraFeedStatusEl.textContent =
      "Camera feed unavailable (device may reserve camera for AR passthrough).";
    return false;
  }
}

startSessionBtn.onclick = async () => {
  if (sessionConnectRequested || modelSessionActive) return;

  startSessionBtn.disabled = true;
  startSessionBtn.textContent = "Starting...";
  setStatus("Preparing mic and camera...", "disconnected");
  await Promise.allSettled([startMicCapture(), startCameraFeed()]);

  sessionConnectRequested = true;
  setStatus("Connecting...", "disconnected");
  armStartupTimeout();

  if (!geminiClient.isConnected()) {
    geminiClient.connect();
  } else {
    beginStartSessionHandshake();
  }
};

async function bootstrap() {
  renderProgress(defaultProgress);
  updateTranscriptView();
  await loadProgress();
  setupThreeScene();
  xrReady = await ensureArSupport();
  if (!xrReady) {
    setStatus("Disconnected (AR unsupported on this device/browser)", "error");
    return;
  }
  setStatus("Disconnected", "disconnected");
}

bootstrap();
