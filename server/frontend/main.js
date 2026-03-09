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
const chatLog = document.getElementById("chat-log");
const progressList = document.getElementById("progress-list");
const progressUpdated = document.getElementById("progress-updated");

let currentGeminiMessageDiv = null;
let currentUserMessageDiv = null;
let preferredCameraFacingMode = "user";

function sendCameraFrame(base64Data) {
  if (geminiClient.isConnected()) {
    geminiClient.sendImage(base64Data);
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
    statusDiv.textContent = "Connected";
    statusDiv.className = "status connected";
    authSection.classList.add("hidden");
    appSection.classList.remove("hidden");
    loadProgress();

    // Send hidden instruction
    geminiClient.sendText(
      `System: You are an AI assistant that teaches users how to cook pasta. Provide practical, step-by-step guidance with clear timings.`
    );
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
    statusDiv.textContent = "Disconnected";
    statusDiv.className = "status disconnected";
    showSessionEnd();
  },
  onError: (e) => {
    console.error("WS Error:", e);
    statusDiv.textContent = "Connection Error";
    statusDiv.className = "status error";
  },
});

function handleJsonMessage(msg) {
  if (msg.type === "interrupted") {
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

function appendMessage(type, text) {
  const msgDiv = document.createElement("div");
  msgDiv.className = `message ${type}`;
  msgDiv.textContent = text;
  chatLog.appendChild(msgDiv);
  chatLog.scrollTop = chatLog.scrollHeight;
  return msgDiv;
}

// Connect Button Handler
connectBtn.onclick = async () => {
  statusDiv.textContent = "Connecting...";
  connectBtn.disabled = true;

  try {
    // Initialize audio context on user gesture
    await mediaHandler.initializeAudio();

    geminiClient.connect();
  } catch (error) {
    console.error("Connection error:", error);
    statusDiv.textContent = "Connection Failed: " + error.message;
    statusDiv.className = "status error";
    connectBtn.disabled = false;
  }
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

  mediaHandler.stopAudio();
  mediaHandler.stopVideo(videoPreview);
  videoPlaceholder.classList.remove("hidden");

  micBtn.textContent = "Start Mic";
  cameraBtn.textContent = "Start Camera";
  preferredCameraFacingMode = "user";
  screenBtn.textContent = "Share Screen";
  chatLog.innerHTML = "";
  renderProgress(defaultProgress);
  connectBtn.disabled = false;
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
