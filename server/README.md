# Gemini Live API - Python SDK & Vanilla JS

A demonstration of the Gemini Live API using the [Google Gen AI Python SDK](https://github.com/googleapis/python-genai) for the backend and vanilla JavaScript for the frontend. This example shows how to build a real-time multimodal application with a robust Python backend handling the API connection.

## Inspiration

Cooking is physical and time-sensitive, but most AI assistants are still text-first and screen-heavy.  
ApronAI was inspired by the idea of a real-time kitchen copilot that can watch what you are doing, listen to you, and guide you step by step without forcing you to constantly type.

## What it does

ApronAI provides a multimodal cooking assistant powered by Gemini Live:

- Streams microphone audio and camera frames to Gemini in real time.
- Responds with low-latency native audio.
- Tracks recipe progress step-by-step with explicit memory.
- Exposes progress via API and renders it live in UI (web + AR HUD).
- Supports multiple recipe prompts loaded dynamically from `/knolwedge`.
- Offers two frontends:
  - `/` for AR/WebXR mode
  - `/eval` for standard camera/chat evaluation mode

## How we built it

- Backend: FastAPI + WebSocket session bridge in `main.py`.
- Model integration: `gemini_live.py` wrapper around `google-genai` Live API.
- Frontend:
  - Vanilla JS media pipeline (`gemini-client.js`, `media-handler.js`).
  - AR interface built with Three.js + `ARButton`.
- Continuity layer:
  - `progress_tracker.py` maintains explicit, text-based task memory checkpoints.
  - Knowledge-driven recipes are loaded from JSON files in `/knolwedge`.
- Reliability:
  - Session restarts, resumable handles, queue backpressure control, and HTTPS/WSS support for mobile devices.

## Challenges we ran into

- Long-running multimodal sessions were timing out or degrading around short windows when audio + video were both active.
- Conversation continuity could degrade when context was compressed, causing repeated questions.
- Mobile browsers introduced extra constraints around HTTPS cert trust, media permissions, and AR behavior.

To address this, we combined:

- Context window compression (sliding/context shifting window) for longer sessions.
- Explicit memory management to preserve stable step progress across compression and session restarts.

## Accomplishments that we're proud of

- Built a stable real-time multimodal loop with audio + video + voice responses.
- Achieved significantly longer practical session duration through compression + session recovery.
- Added explicit progress memory that survives long conversations and keeps the assistant on-step.
- Delivered AR mode with in-scene HUD/transcript plus a fallback eval UI that works on phones and desktop.
- Added dynamic recipe selection and knowledge loading without hardcoding prompts in frontend logic.

## What we learned

- Compression alone extends session length, but explicit memory is essential for continuity quality.
- Real-time apps need careful queueing and restart strategy, not just model calls.
- Mobile and AR UX are heavily shaped by browser security and permission models.
- Designing for observability (verbose logs, tests, progress APIs) speeds up iteration and debugging.

## What's next for ApronAI

- Richer task memory with structured state per recipe (timers, ingredient status, parallel steps).
- More recipe packs and tool integrations (timers, substitutions, pantry-aware guidance).
- Better AR interaction patterns for hands-busy scenarios (voice-only mode, larger gaze-friendly controls).
- Stronger production hardening: analytics, auth, and deployment profiles for multi-user usage.

## Quick Start

### 1. Backend Setup

Install Python dependencies and start the FastAPI server:

```bash
# Install dependencies
pip install -r requirements.txt

# Authenticate with Google Cloud
gcloud auth application-default login

# Start the server
python main.py

# Start with verbose diagnostics
python main.py -v
```

### 2. Frontend

Open your browser and navigate to:

[http://localhost:8000](http://localhost:8000)

Routes:

- `/` - new WebXR AR frontend (HUD + progress + backend session controls)
- `/eval` - existing evaluation frontend (camera/chat UI)

### 3. Mobile HTTPS/WSS (camera + mic)

For mobile devices, use HTTPS and a cert that includes your server LAN IP in SAN.

```bash
# Regenerate dev cert with auto-detected LAN IPs
./scripts/generate_dev_cert.sh

# Run HTTPS server on all interfaces
python main.py -h 0.0.0.0 -p 8000
```

Then open `https://<your-lan-ip>:8000` on mobile and trust the certificate for that IP.
If your IP changes, run `./scripts/generate_dev_cert.sh` again.

## Deploy To Google Cloud Run

This project is deployable to Google Cloud Run (recommended for WebSocket support).

### 1. Prerequisites

- `gcloud` CLI installed and authenticated
- Docker installed locally
- Billing enabled on your Google Cloud project

### 2. One-command deploy (from `server/`)

```bash
PROJECT_ID=<your-project-id> ./deploy_cloud_run.sh
```

Optional overrides:

```bash
PROJECT_ID=<your-project-id> REGION=us-central1 SERVICE_NAME=apronai-live LOCATION=us-central1 MODEL=gemini-live-2.5-flash-native-audio ./deploy_cloud_run.sh
# Cloud Run timeout is set to 3600s in the script
```

Architecture note (Apple Silicon / ARM Macs):

- The deploy script builds `linux/amd64` by default, which is required by Cloud Run.
- You can override with `BUILD_PLATFORM=linux/amd64` explicitly if needed.

Runtime service account (recommended):

```bash
PROJECT_ID=<your-project-id> SERVICE_ACCOUNT=<sa-email> ./deploy_cloud_run.sh
```

If logs show `Permission 'aiplatform.endpoints.predict' denied`, grant Vertex AI role to the Cloud Run runtime service account:

```bash
gcloud projects add-iam-policy-binding <your-project-id> \
  --member="serviceAccount:<sa-email>" \
  --role="roles/aiplatform.user"
```

### 3. Required runtime permissions

The Cloud Run service account must be able to call Vertex AI Live API.

- Grant `roles/aiplatform.user` to the Cloud Run runtime service account.
- If using a custom service account, deploy with `--service-account=<email>`.

### 4. Cloud Build alternative

You can also deploy through Cloud Build:

```bash
gcloud builds submit --config cloudbuild.yaml --substitutions=_PROJECT_ID=<your-project-id> .
```

### Deployment files

- `Dockerfile` - production container image for Cloud Run
- `.dockerignore` - excludes local-only files (`.env`, certs, tests)
- `deploy_cloud_run.sh` - direct deploy helper
- `cloudbuild.yaml` - CI/CD pipeline deploy path

## Features

- **Google Gen AI SDK**: Uses the official Python SDK (`google-genai`) for simplified API interaction.
- **FastAPI Backend**: Robust, async-ready web server handling WebSocket connections.
- **Real-time Streaming**: Bi-directional audio and video streaming.
- **Continuous Session Recovery**: Automatically restarts Live sessions when they time out, with resumption handles when available.
- **Explicit Text Memory**: Persists selected recipe step progress via internal text checkpoints so compression is less likely to lose current step.
- **Progress API + UI**: `GET /api/progress` exposes step statuses (`done`, `in_progress`, `wait`) and the main UI shows them live.
- **Knowledge API**: `GET /api/knowledge` and `GET /api/knowledge/{id}` load recipe prompts/steps from `knolwedge/*.json`.
- **Dedicated Progress Module**: `progress_tracker.py` contains memory logic and shared progress state store.
- **Tool Use**: Demonstrates how to register and handle server-side tools.
- **Vanilla JS Frontend**: Lightweight frontend with no build steps or framework dependencies.

## Project Structure

```
/
├── main.py             # FastAPI server & WebSocket endpoint
├── gemini_live.py      # Gemini Live API wrapper using Gen AI SDK
├── knolwedge/          # Recipe knowledge files (one JSON per recipe)
├── requirements.txt    # Python dependencies
└── frontend/
    ├── index.html      # User Interface
    ├── main.js         # Application logic
    ├── gemini-client.js # WebSocket client for backend communication
    ├── media-handler.js # Audio/Video capture and playback
    └── pcm-processor.js # AudioWorklet for PCM processing
```

## Configuration

You can configure the application by setting environment variables or by directly editing the defaults in `main.py`.

**Important:** You must update the `PROJECT_ID` to match your Google Cloud project.

1.  Open `main.py`.
2.  Locate the `PROJECT_ID` variable near the top of the file.
3.  Replace `"your-project-id-here"` with your actual project ID.

```python
# Configuration
PROJECT_ID = os.getenv("PROJECT_ID", "your-project-id-here")
```

Alternatively, you can set the `PROJECT_ID` environment variable before running the server.

### Optional Runtime Tuning

The backend supports these optional environment variables:

- `SESSION_RESTART_DELAY_SECONDS` (default: `0.75`) - pause before reconnecting a new Live session
- `MAX_AUDIO_QUEUE_SIZE` (default: `128`) - max buffered audio chunks (drops oldest when full)
- `MAX_VIDEO_QUEUE_SIZE` (default: `8`) - max buffered video frames (drops oldest when full)
- `MAX_TEXT_QUEUE_SIZE` (default: `64`) - max buffered text messages
- `LIVE_MEDIA_RESOLUTION` (default: `MEDIA_RESOLUTION_MEDIUM`) - `MEDIA_RESOLUTION_LOW|MEDIUM|HIGH`
- `LIVE_ENABLE_CONTEXT_WINDOW_COMPRESSION` (default: `1`) - enable/disable context window compression for longer audio+video sessions
- `LIVE_COMPRESSION_TRIGGER_TOKENS` (default: unset) - optional token threshold override before compression starts
- `LIVE_COMPRESSION_TARGET_TOKENS` (default: unset) - optional target token size override for sliding window
- `LIVE_ENABLE_TRANSCRIPTIONS` (default: `1`) - enable/disable input + output transcriptions
- `LIVE_ENABLE_PROACTIVE_AUDIO` (default: `0`) - enable/disable proactive audio mode
- `LIVE_API_VERSION` (default: `v1`) - Live API version for Vertex (`v1` recommended)
- `LIVE_VOICE_NAME` (default: `Zephyr`) - prebuilt voice name (female voice)
- `LIVE_SYSTEM_PROMPT` (default: unset) - optional global override for recipe system prompt
- `LIVE_ENGLISH_ONLY` (default: `1`) - force the assistant to respond in English only

## Core Components

### Backend (`gemini_live.py`)

The `GeminiLive` class wraps the `genai.Client` to manage the session:

```python
# Connects using the SDK
async with self.client.aio.live.connect(model=self.model, config=config) as session:
    # Manages input/output queues
    await asyncio.gather(
        send_audio(),
        send_video(),
        receive_responses()
    )
```

### Frontend (`gemini-client.js`)

The frontend communicates with the FastAPI backend via WebSockets, sending base64-encoded media chunks and receiving audio responses.
