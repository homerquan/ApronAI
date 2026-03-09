# Gemini Live API - Python SDK & Vanilla JS

A demonstration of the Gemini Live API using the [Google Gen AI Python SDK](https://github.com/googleapis/python-genai) for the backend and vanilla JavaScript for the frontend. This example shows how to build a real-time multimodal application with a robust Python backend handling the API connection.

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
- **Explicit Text Memory**: Persists pasta step progress via internal text checkpoints so compression is less likely to lose current step.
- **Progress API + UI**: `GET /api/progress` exposes step statuses (`done`, `in_progress`, `wait`) and the main UI shows them live.
- **Dedicated Progress Module**: `progress_tracker.py` contains memory logic and shared progress state store.
- **Tool Use**: Demonstrates how to register and handle server-side tools.
- **Vanilla JS Frontend**: Lightweight frontend with no build steps or framework dependencies.

## Project Structure

```
/
├── main.py             # FastAPI server & WebSocket endpoint
├── gemini_live.py      # Gemini Live API wrapper using Gen AI SDK
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
- `LIVE_SYSTEM_PROMPT` (default: pasta-cooking assistant prompt) - system instruction text
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
