// --- Main Application Logic ---

const statusDiv = document.getElementById("status");
const authSection = document.getElementById("auth-section");
const appSection = document.getElementById("app-section");
const sessionEndSection = document.getElementById("session-end-section");
const restartBtn = document.getElementById("restartBtn");
const micBtn = document.getElementById("micBtn");
const cameraBtn = document.getElementById("cameraBtn");
const backCameraBtn = document.getElementById("backCameraBtn");
const screenBtn = document.getElementById("screenBtn");
const disconnectBtn = document.getElementById("disconnectBtn");
const textInput = document.getElementById("textInput");
const sendBtn = document.getElementById("sendBtn");
const videoPreview = document.getElementById("video-preview");
const videoPlaceholder = document.getElementById("video-placeholder");
const connectBtn = document.getElementById("connectBtn");
const startSessionBtn = document.getElementById("startSessionBtn");
const permissionModal = document.getElementById("permissionModal");
const permissionAllowBtn = document.getElementById("permissionAllowBtn");
const permissionSkipBtn = document.getElementById("permissionSkipBtn");
const permissionStatus = document.getElementById("permissionStatus");
const chatLog = document.getElementById("chat-log");
const progressList = document.getElementById("progress-list");
const progressUpdated = document.getElementById("progress-updated");
const mobileNav = document.getElementById("mobileNav");
const mobileTabs = document.querySelectorAll(".mobile-tab");
const mobilePanels = document.querySelectorAll("[data-mobile-panel]");
const toggleFeaturesBtn = document.getElementById("toggleFeaturesBtn");
const featureDetails = document.getElementById("featureDetails");

let currentGeminiMessageDiv = null;
let currentUserMessageDiv = null;
let preferredCameraFacingMode = "user";
let activeMobilePanel = "camera";
let sessionConnectRequested = false;
let modelSessionActive = false;
let startupTimeoutId = null;
let permissionPromptCompleted = false;
let startSessionRetryId = null;
let startSessionAttemptCount = 0;

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
  startSessionAttemptCount = 0;
}

function sendStartSessionSignal() {
  if (!sessionConnectRequested || modelSessionActive) {
    return;
  }
  if (!geminiClient.isConnected()) {
    return;
  }
  startSessionAttemptCount += 1;
  geminiClient.startSession();
}

function beginStartSessionHandshake() {
  clearStartSessionRetry();
  sendStartSessionSignal();
  startSessionRetryId = setInterval(() => {
    sendStartSessionSignal();
  }, 1000);
}

function armStartupTimeout() {
  clearStartupTimeout();
  startupTimeoutId = setTimeout(() => {
    if (modelSessionActive) {
      return;
    }
    sessionConnectRequested = false;
    startSessionBtn.disabled = false;
    startSessionBtn.textContent = "Start Session";
    statusDiv.textContent =
      "Start timed out. Trust the HTTPS cert for this IP, then retry.";
    statusDiv.className = "status error";
    clearStartSessionRetry();
    if (geminiClient.isConnected()) {
      geminiClient.disconnect();
    }
  }, 12000);
}

function showPermissionModal() {
  permissionStatus.textContent = "";
  permissionModal.classList.remove("hidden");
}

function hidePermissionModal() {
  permissionModal.classList.add("hidden");
}

function setPermissionStatus(message) {
  permissionStatus.textContent = message || "";
}

function sendCameraFrame(base64Data) {
  if (geminiClient.isConnected()) {
    geminiClient.sendImage(base64Data);
  }
}

function isMobileViewport() {
  return window.matchMedia("(max-width: 768px)").matches;
}

function setMobilePanel(panelName) {
  activeMobilePanel = panelName;
  const mobile = isMobileViewport();

  for (const panel of mobilePanels) {
    if (!mobile) {
      panel.classList.remove("mobile-panel-hidden");
      continue;
    }
    const name = panel.getAttribute("data-mobile-panel");
    panel.classList.toggle("mobile-panel-hidden", name !== panelName);
  }

  for (const tab of mobileTabs) {
    tab.classList.toggle("active", tab.getAttribute("data-panel") === panelName);
  }
}

function updateMobileLayout() {
  const mobile = isMobileViewport();

  mobileNav.classList.toggle("hidden", !mobile);
  toggleFeaturesBtn.classList.toggle("hidden", !mobile);

  if (mobile) {
    if (!toggleFeaturesBtn.dataset.ready) {
      featureDetails.classList.add("hidden");
      toggleFeaturesBtn.textContent = "Show Features";
      toggleFeaturesBtn.dataset.ready = "1";
    }
    setMobilePanel(activeMobilePanel);
  } else {
    featureDetails.classList.remove("hidden");
    toggleFeaturesBtn.textContent = "Show Features";
    for (const panel of mobilePanels) {
      panel.classList.remove("mobile-panel-hidden");
    }
  }
}
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
const geminiClient = new GeminiClient({
  onOpen: () => {
    statusDiv.textContent = "Connected (starting model session...)";
    statusDiv.className = "status connected";
    if (sessionConnectRequested) {
      beginStartSessionHandshake();
    }
  },
  onMessage: (event) => {
    if (typeof event.data === "string") {
      try {
        const msg = JSON.parse(event.data);
        handleJsonMessage(msg);
      } catch (e) {
        console.error("Parse error:", e);
      }
    } else {
      mediaHandler.playAudio(event.data);
    }
  },
  onClose: (e) => {
    console.log("WS Closed:", e);
    clearStartupTimeout();
    clearStartSessionRetry();
    sessionConnectRequested = false;
    modelSessionActive = false;
    startSessionBtn.textContent = "Start Session";
    startSessionBtn.disabled = false;
    statusDiv.textContent = "Disconnected";
    statusDiv.className = "status disconnected";
    showSessionEnd();
  },
  onError: (e) => {
    console.error("WS Error:", e);
    clearStartupTimeout();
    clearStartSessionRetry();
    sessionConnectRequested = false;
    startSessionBtn.textContent = "Start Session";
    startSessionBtn.disabled = false;
    statusDiv.textContent = "Connection Error";
    statusDiv.className = "status error";
  },
});

function startModelSessionUI() {
  clearStartupTimeout();
  clearStartSessionRetry();
  modelSessionActive = true;
  sessionConnectRequested = false;
  startSessionBtn.textContent = "Session Running";
  startSessionBtn.disabled = true;
  statusDiv.textContent = "Connected";
  statusDiv.className = "status connected";
  loadProgress();

  // Send hidden instruction after the model session starts.
  geminiClient.sendText(
    `System: You are an AI assistant that teaches users how to cook pasta. Provide practical, step-by-step guidance with clear timings.`
  );
}

function handleJsonMessage(msg) {
  if (msg.type === "ready") {
    if (!sessionConnectRequested && !modelSessionActive) {
      statusDiv.textContent = "Connected (ready to start)";
      statusDiv.className = "status connected";
      startSessionBtn.disabled = false;
      startSessionBtn.textContent = "Start Session";
    } else if (sessionConnectRequested && !modelSessionActive) {
      // On some mobile stacks, first control frame may be delayed/dropped.
      sendStartSessionSignal();
    }
  } else if (msg.type === "session_started") {
    startModelSessionUI();
  } else if (msg.type === "interrupted") {
    mediaHandler.stopAudioPlayback();
    currentGeminiMessageDiv = null;
    currentUserMessageDiv = null;
  } else if (msg.type === "progress" && msg.progress) {
    renderProgress(msg.progress);
  } else if (msg.type === "session_restarting") {
    const mode = msg.resuming ? "resuming context" : "starting fresh context";
    statusDiv.textContent = `Connected (restarting model session, ${mode})`;
    statusDiv.className = "status connected";
  } else if (msg.type === "error") {
    statusDiv.textContent = "Connected (recovering from model session error...)";
    statusDiv.className = "status connected";
  } else if (msg.type === "turn_complete") {
    currentGeminiMessageDiv = null;
    currentUserMessageDiv = null;
  } else if (msg.type === "user") {
    statusDiv.textContent = "Connected";
    statusDiv.className = "status connected";
    if (currentUserMessageDiv) {
      currentUserMessageDiv.textContent += msg.text;
      chatLog.scrollTop = chatLog.scrollHeight;
    } else {
      currentUserMessageDiv = appendMessage("user", msg.text);
    }
  } else if (msg.type === "gemini") {
    statusDiv.textContent = "Connected";
    statusDiv.className = "status connected";
    if (currentGeminiMessageDiv) {
      currentGeminiMessageDiv.textContent += msg.text;
      chatLog.scrollTop = chatLog.scrollHeight;
    } else {
      currentGeminiMessageDiv = appendMessage("gemini", msg.text);
    }
  }
}

function formatStatus(status) {
  if (status === "in_progress") return "in progress";
  return status;
}

function formatUpdatedTime(unixTs) {
  if (!unixTs) return "Not started yet";
  const date = new Date(unixTs * 1000);
  return `Updated ${date.toLocaleTimeString()}`;
}

function renderProgress(progress) {
  if (!progress || !Array.isArray(progress.steps)) return;
  progressList.innerHTML = "";

  for (const step of progress.steps) {
    const row = document.createElement("div");
    row.className = `progress-item ${step.status}`;

    const stepText = document.createElement("div");
    stepText.className = "progress-step-text";
    stepText.textContent = `Step ${step.step}: ${step.text}`;

    const status = document.createElement("div");
    status.className = `progress-status ${step.status}`;
    status.textContent = formatStatus(step.status);

    row.appendChild(stepText);
    row.appendChild(status);
    progressList.appendChild(row);
  }

  progressUpdated.textContent = formatUpdatedTime(progress.updated_at);
}

async function loadProgress() {
  try {
    const response = await fetch("/api/progress", { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json();
    renderProgress(payload);
  } catch (error) {
    console.error("Failed to load progress:", error);
  }
}

renderProgress(defaultProgress);

for (const tab of mobileTabs) {
  tab.addEventListener("click", () => {
    setMobilePanel(tab.getAttribute("data-panel"));
  });
}

toggleFeaturesBtn.onclick = () => {
  if (!isMobileViewport()) return;
  const isHidden = featureDetails.classList.toggle("hidden");
  toggleFeaturesBtn.textContent = isHidden ? "Show Features" : "Hide Features";
};

window.addEventListener("resize", updateMobileLayout);
updateMobileLayout();

function appendMessage(type, text) {
  const msgDiv = document.createElement("div");
  msgDiv.className = `message ${type}`;
  msgDiv.textContent = text;
  chatLog.appendChild(msgDiv);
  chatLog.scrollTop = chatLog.scrollHeight;
  return msgDiv;
}

// Landing page: only open app UI, do not start model session.
connectBtn.onclick = () => {
  authSection.classList.add("hidden");
  appSection.classList.remove("hidden");
  sessionEndSection.classList.add("hidden");
  setMobilePanel("camera");
  statusDiv.textContent = "Ready (click Start Session)";
  statusDiv.className = "status disconnected";
  startSessionBtn.disabled = false;
  startSessionBtn.textContent = "Start Session";
};

async function beginSessionStartup() {
  if (sessionConnectRequested || modelSessionActive) {
    return;
  }

  statusDiv.textContent = "Connecting...";
  statusDiv.className = "status disconnected";
  startSessionBtn.disabled = true;
  startSessionBtn.textContent = "Starting...";
  sessionConnectRequested = true;
  armStartupTimeout();

  try {
    // Keep audio warm-up best effort, but do not block startup.
    mediaHandler.initializeAudio().catch((error) => {
      console.warn("Audio initialization failed during startup:", error);
    });
    if (!geminiClient.isConnected()) {
      geminiClient.connect();
    } else {
      beginStartSessionHandshake();
    }
  } catch (error) {
    clearStartupTimeout();
    console.error("Connection error:", error);
    statusDiv.textContent = "Connection Failed: " + error.message;
    statusDiv.className = "status error";
    sessionConnectRequested = false;
    startSessionBtn.disabled = false;
    startSessionBtn.textContent = "Start Session";
  }
}

// App page: this starts the online Gemini session.
startSessionBtn.onclick = async () => {
  if (!permissionPromptCompleted) {
    showPermissionModal();
    return;
  }
  await beginSessionStartup();
};

permissionAllowBtn.onclick = async () => {
  permissionAllowBtn.disabled = true;
  permissionSkipBtn.disabled = true;
  setPermissionStatus("Requesting microphone permission...");
  try {
    await mediaHandler.initializeAudio();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("Browser does not support microphone capture");
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    permissionPromptCompleted = true;
    setPermissionStatus("Audio and microphone are enabled.");
    hidePermissionModal();
    await beginSessionStartup();
  } catch (error) {
    console.error("Permission step failed:", error);
    setPermissionStatus(
      "Mic permission was not granted. You can continue without microphone."
    );
  } finally {
    permissionAllowBtn.disabled = false;
    permissionSkipBtn.disabled = false;
  }
};

permissionSkipBtn.onclick = async () => {
  permissionPromptCompleted = true;
  hidePermissionModal();
  await beginSessionStartup();
};

// UI Controls
disconnectBtn.onclick = () => {
  geminiClient.disconnect();
};

micBtn.onclick = async () => {
  if (mediaHandler.isRecording) {
    mediaHandler.stopAudio();
    micBtn.textContent = "Start Mic";
  } else {
    try {
      await mediaHandler.startAudio((data) => {
        if (geminiClient.isConnected()) {
          geminiClient.send(data);
        }
      });
      micBtn.textContent = "Stop Mic";
    } catch (e) {
      alert("Could not start audio capture");
    }
  }
};

cameraBtn.onclick = async () => {
  if (cameraBtn.textContent === "Stop Camera") {
    mediaHandler.stopVideo(videoPreview);
    cameraBtn.textContent = "Start Camera";
    preferredCameraFacingMode = "user";
    screenBtn.textContent = "Share Screen";
    videoPlaceholder.classList.remove("hidden");
  } else {
    // If another stream is active (e.g. Screen), stop it first
    if (mediaHandler.videoStream) {
      mediaHandler.stopVideo(videoPreview);
      screenBtn.textContent = "Share Screen";
    }

    try {
      await mediaHandler.startVideo(
        videoPreview,
        sendCameraFrame,
        preferredCameraFacingMode
      );
      cameraBtn.textContent = "Stop Camera";
      screenBtn.textContent = "Share Screen";
      videoPlaceholder.classList.add("hidden");
    } catch (e) {
      alert("Could not access camera");
    }
  }
};

backCameraBtn.onclick = async () => {
  preferredCameraFacingMode = "environment";
  if (cameraBtn.textContent !== "Stop Camera") {
    return;
  }

  try {
    await mediaHandler.startVideo(
      videoPreview,
      sendCameraFrame,
      "environment",
      true
    );
    videoPlaceholder.classList.add("hidden");
  } catch (e) {
    // Intentionally no-op when back camera is unavailable.
  }
};

screenBtn.onclick = async () => {
  if (screenBtn.textContent === "Stop Sharing") {
    mediaHandler.stopVideo(videoPreview);
    screenBtn.textContent = "Share Screen";
    cameraBtn.textContent = "Start Camera";
    videoPlaceholder.classList.remove("hidden");
  } else {
    // If another stream is active (e.g. Camera), stop it first
    if (mediaHandler.videoStream) {
      mediaHandler.stopVideo(videoPreview);
      cameraBtn.textContent = "Start Camera";
    }

    try {
      await mediaHandler.startScreen(
        videoPreview,
        (base64Data) => {
          if (geminiClient.isConnected()) {
            geminiClient.sendImage(base64Data);
          }
        },
        () => {
          // onEnded callback (e.g. user stopped sharing from browser)
          screenBtn.textContent = "Share Screen";
          videoPlaceholder.classList.remove("hidden");
        }
      );
      screenBtn.textContent = "Stop Sharing";
      cameraBtn.textContent = "Start Camera";
      videoPlaceholder.classList.add("hidden");
    } catch (e) {
      alert("Could not share screen");
    }
  }
};

sendBtn.onclick = sendText;
textInput.onkeypress = (e) => {
  if (e.key === "Enter") sendText();
};

function sendText() {
  const text = textInput.value;
  if (text && geminiClient.isConnected()) {
    geminiClient.sendText(text);
    appendMessage("user", text);
    textInput.value = "";
  }
}

function resetUI() {
  authSection.classList.remove("hidden");
  appSection.classList.add("hidden");
  sessionEndSection.classList.add("hidden");
  sessionConnectRequested = false;
  modelSessionActive = false;
  clearStartupTimeout();
  clearStartSessionRetry();

  mediaHandler.stopAudio();
  mediaHandler.stopVideo(videoPreview);
  videoPlaceholder.classList.remove("hidden");

  micBtn.textContent = "Start Mic";
  cameraBtn.textContent = "Start Camera";
  preferredCameraFacingMode = "user";
  setMobilePanel("camera");
  screenBtn.textContent = "Share Screen";
  chatLog.innerHTML = "";
  renderProgress(defaultProgress);
  connectBtn.disabled = false;
  startSessionBtn.disabled = false;
  startSessionBtn.textContent = "Start Session";
  statusDiv.textContent = "Disconnected";
  statusDiv.className = "status disconnected";
}

function showSessionEnd() {
  appSection.classList.add("hidden");
  sessionEndSection.classList.remove("hidden");
  mediaHandler.stopAudio();
  mediaHandler.stopVideo(videoPreview);
}

restartBtn.onclick = () => {
  resetUI();
};
