import * as THREE from "three";
import { ARButton } from "three/addons/webxr/ARButton.js";

const statusEl = document.getElementById("status");
const recipeOptionsEl = document.getElementById("recipeOptions");
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
  recipe: "pasta",
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
let hasReceivedGeminiTranscript = false;
let selectedRecipeId = "pasta";
const recipeCatalog = new Map();
let latestProgressForAr = defaultProgress;
let arHudPanel = null;
let arTranscriptPanel = null;

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
  geminiClient.startSession({ recipe: selectedRecipeId });
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
    setRecipeControlsEnabled(true);
    setStatus("Start timed out. Retry session startup.", "error");
    if (geminiClient.isConnected()) geminiClient.disconnect();
  }, 12000);
}

function updateTranscriptView() {
  transcriptCurrentEl.textContent =
    currentGeminiTranscript ||
    (hasReceivedGeminiTranscript ? "" : "Waiting for AI transcript...");
  transcriptHistoryEl.textContent = transcriptHistory.join(" ");
  drawArTranscriptPanel();
}

function appendGeminiTranscript(textChunk) {
  if (textChunk && textChunk.trim()) {
    hasReceivedGeminiTranscript = true;
  }
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

function buildWaitingProgress(steps, recipeId = selectedRecipeId) {
  return {
    updated_at: null,
    recipe: recipeId,
    steps: (steps || []).map((text, index) => ({
      step: index + 1,
      text,
      status: "wait",
    })),
  };
}

function setRecipeControlsEnabled(enabled) {
  const inputs = recipeOptionsEl.querySelectorAll('input[name="recipeChoice"]');
  for (const input of inputs) {
    input.disabled = !enabled;
  }
}

function applySelectedRecipe(recipeId) {
  if (!recipeCatalog.has(recipeId)) return;
  selectedRecipeId = recipeId;
  const inputs = recipeOptionsEl.querySelectorAll('input[name="recipeChoice"]');
  for (const input of inputs) {
    input.checked = input.value === recipeId;
  }
  const entry = recipeCatalog.get(recipeId);
  if (entry && Array.isArray(entry.steps)) {
    renderProgress(buildWaitingProgress(entry.steps, recipeId));
  }
}

function createArTextPanel({
  width,
  height,
  scaleX,
  scaleY,
  background = "rgba(7, 12, 22, 0.82)",
  border = "rgba(255, 255, 255, 0.3)",
  textColor = "#f8fbff",
}) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(scaleX, scaleY, 1);
  sprite.renderOrder = 999;

  return { canvas, ctx, texture, sprite, background, border, textColor };
}

function drawPanelBackground(panel) {
  const { ctx, canvas, background, border } = panel;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = border;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
}

function wrapTextLines(ctx, text, maxWidth) {
  if (!text) return [""];
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawArProgressPanel(progress) {
  if (!arHudPanel) return;
  const panel = arHudPanel;
  drawPanelBackground(panel);
  const { ctx, canvas, textColor, texture } = panel;
  const padX = 18;
  const maxWidth = canvas.width - padX * 2;
  let y = 34;

  ctx.fillStyle = textColor;
  ctx.font = "bold 28px sans-serif";
  const heading = progress && progress.recipe ? `HUD: ${String(progress.recipe).toUpperCase()}` : "HUD";
  ctx.fillText(heading, padX, y);
  y += 32;

  ctx.font = "18px sans-serif";
  ctx.fillStyle = "rgba(242, 245, 251, 0.78)";
  ctx.fillText(formatUpdatedTime(progress && progress.updated_at), padX, y);
  y += 28;

  ctx.fillStyle = textColor;
  ctx.font = "20px sans-serif";
  const steps = progress && Array.isArray(progress.steps) ? progress.steps : [];
  for (const step of steps.slice(0, 5)) {
    const icon = step.status === "done" ? "[x]" : step.status === "in_progress" ? "[>]" : "[ ]";
    const lineText = `${icon} ${step.step}. ${step.text}`;
    const wrapped = wrapTextLines(ctx, lineText, maxWidth);
    for (const line of wrapped.slice(0, 2)) {
      ctx.fillText(line, padX, y);
      y += 24;
    }
    y += 6;
    if (y > canvas.height - 20) break;
  }

  texture.needsUpdate = true;
}

function drawArTranscriptPanel() {
  if (!arTranscriptPanel) return;
  const panel = arTranscriptPanel;
  drawPanelBackground(panel);
  const { ctx, canvas, textColor, texture } = panel;
  const padX = 20;
  const maxWidth = canvas.width - padX * 2;
  let y = 36;

  ctx.fillStyle = "rgba(242, 245, 251, 0.72)";
  ctx.font = "18px sans-serif";
  const historyText = transcriptHistory.join(" ");
  const historyLines = wrapTextLines(ctx, historyText, maxWidth).slice(-2);
  for (const line of historyLines) {
    ctx.fillText(line, padX, y);
    y += 22;
  }

  y += 6;
  ctx.fillStyle = textColor;
  ctx.font = "bold 26px sans-serif";
  const currentText =
    currentGeminiTranscript ||
    (hasReceivedGeminiTranscript ? "" : "Waiting for AI transcript...");
  const currentLines = currentText
    ? wrapTextLines(ctx, currentText, maxWidth).slice(0, 2)
    : [];
  for (const line of currentLines) {
    ctx.fillText(line, padX, y);
    y += 30;
  }

  texture.needsUpdate = true;
}

function createArOverlayPanels() {
  if (!camera || arHudPanel || arTranscriptPanel) return;

  arHudPanel = createArTextPanel({
    width: 900,
    height: 620,
    scaleX: 0.56,
    scaleY: 0.38,
    background: "rgba(10, 16, 28, 0.82)",
  });
  arHudPanel.sprite.position.set(-0.34, 0.22, -0.95);
  camera.add(arHudPanel.sprite);

  arTranscriptPanel = createArTextPanel({
    width: 1280,
    height: 260,
    scaleX: 0.88,
    scaleY: 0.18,
    background: "rgba(8, 12, 20, 0.78)",
  });
  arTranscriptPanel.sprite.position.set(0, -0.34, -1.0);
  camera.add(arTranscriptPanel.sprite);

  drawArProgressPanel(latestProgressForAr);
  drawArTranscriptPanel();
}

function renderProgress(progress) {
  if (!progress || !Array.isArray(progress.steps)) return;
  latestProgressForAr = progress;
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
  drawArProgressPanel(progress);
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

async function loadRecipeCatalog() {
  try {
    const listRes = await fetch("/api/knowledge", { cache: "no-store" });
    if (!listRes.ok) {
      throw new Error(`Knowledge list request failed (${listRes.status})`);
    }
    const listPayload = await listRes.json();
    const recipes = Array.isArray(listPayload.recipes) ? listPayload.recipes : [];
    recipeOptionsEl.innerHTML = "";

    for (const recipe of recipes) {
      if (!recipe || typeof recipe.id !== "string") continue;
      const detailRes = await fetch(`/api/knowledge/${encodeURIComponent(recipe.id)}`, {
        cache: "no-store",
      });
      if (!detailRes.ok) continue;
      const detail = await detailRes.json();
      recipeCatalog.set(recipe.id, detail);

      const optionWrap = document.createElement("label");
      optionWrap.className = "recipe-option";

      const input = document.createElement("input");
      input.type = "radio";
      input.name = "recipeChoice";
      input.value = recipe.id;
      input.addEventListener("change", () => {
        if (sessionConnectRequested || modelSessionActive) return;
        if (!input.checked) return;
        applySelectedRecipe(input.value);
      });

      const text = document.createElement("span");
      text.className = "recipe-option-text";
      text.textContent = detail.title || recipe.title || recipe.id;

      optionWrap.appendChild(input);
      optionWrap.appendChild(text);
      recipeOptionsEl.appendChild(optionWrap);
    }

    const initialRecipeId = recipeCatalog.has("pasta")
      ? "pasta"
      : recipeCatalog.keys().next().value || "pasta";
    applySelectedRecipe(initialRecipeId);
  } catch (error) {
    console.error("Failed to load recipe catalog:", error);
    recipeCatalog.clear();
    recipeOptionsEl.innerHTML = "";
    recipeCatalog.set("pasta", {
      id: "pasta",
      title: "Pasta",
      steps: defaultProgress.steps.map((step) => step.text),
    });
    const fallbackWrap = document.createElement("label");
    fallbackWrap.className = "recipe-option";
    const fallbackInput = document.createElement("input");
    fallbackInput.type = "radio";
    fallbackInput.name = "recipeChoice";
    fallbackInput.value = "pasta";
    fallbackInput.checked = true;
    fallbackInput.addEventListener("change", () => {
      if (sessionConnectRequested || modelSessionActive) return;
      if (!fallbackInput.checked) return;
      applySelectedRecipe("pasta");
    });
    const fallbackText = document.createElement("span");
    fallbackText.className = "recipe-option-text";
    fallbackText.textContent = "Pasta";
    fallbackWrap.appendChild(fallbackInput);
    fallbackWrap.appendChild(fallbackText);
    recipeOptionsEl.appendChild(fallbackWrap);
    selectedRecipeId = "pasta";
    applySelectedRecipe("pasta");
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
    setRecipeControlsEnabled(false);
    setStatus("Connected", "connected");
    loadProgress();
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
    setRecipeControlsEnabled(true);
    startSessionBtn.disabled = false;
    startSessionBtn.textContent = "Start Session";
    setStatus("Disconnected", "disconnected");
  },
  onError: () => {
    clearStartupTimeout();
    clearStartSessionRetry();
    stopMicCapture();
    stopCameraFeed();
    setRecipeControlsEnabled(true);
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
  scene.add(camera);
  createArOverlayPanels();

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
  setRecipeControlsEnabled(false);
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
  await loadRecipeCatalog();
  setupThreeScene();
  xrReady = await ensureArSupport();
  if (!xrReady) {
    setStatus("Disconnected (AR unsupported on this device/browser)", "error");
    return;
  }
  setStatus("Disconnected", "disconnected");
}

bootstrap();
