# ApronAI

ApronAI is a real-time multimodal assistant for physical tasks, demonstrated through cooking.

Built on the Gemini Live API, it listens to speech, watches the scene through the camera, responds with native audio, and keeps track of progress through explicit memory over long-running sessions. Rather than acting like a chatbot with a recipe attached, ApronAI is designed more like an embodied copilot: an AI system that can support people while they are doing hands-busy, time-sensitive work in the real world.

Cooking is the first environment, but the broader idea is larger: bringing multimodal AI into physical workflows where seeing, listening, remembering state, and responding in real time matters.

## Inspiration

Most AI assistants still live in a text box. That works well for writing and search, but it breaks down in physical environments where people are moving, using tools, switching attention, and making decisions under time pressure.

Cooking is a simple but powerful example of this challenge. Your hands are busy, your timing matters, and the state of the task is constantly changing. A useful assistant in that setting should not just answer questions. It should perceive what is happening, remember where you are in the process, and guide you in a way that feels natural in the flow of work.

ApronAI was inspired by that vision: AI that can operate alongside people during real physical tasks, not only after the fact or through static instructions. The kitchen became a practical testbed for this idea, combining multimodal perception, explicit memory, and real-time voice interaction into a system that feels closer to a true physical-world copilot.

## What it does

- Streams microphone audio and camera frames to Gemini Live over WebSocket.
- Returns low-latency voice responses.
- Tracks recipe progress with explicit memory checkpoints.
- Surfaces progress via API and live HUD.
- Supports multiple recipes loaded dynamically from `knolwedge/*.json`.
- Provides two frontends:
- `/` for AR/WebXR mode.
- `/eval` for standard camera/chat evaluation mode.

## How we built it

- **Backend**: FastAPI with a WebSocket bridge (`main.py`).
- **Model integration**: Gemini Live wrapper using `google-genai` (`gemini_live.py`).
- **Frontend**: Vanilla JS media pipeline + Three.js AR UI.
- **Memory and progress**: Recipe-aware explicit memory and shared progress store (`progress_tracker.py`).
- **Knowledge system**: Recipe prompts and steps in JSON files under `knolwedge/`.
- **Reliability**: Session restart/resumption flow, queue backpressure handling, mobile HTTPS support.

## Challenges we ran into

- Session quality degraded in longer multimodal conversations when both audio and video were active.
- Context continuity dropped over time, causing repeated questions.
- Mobile and AR constraints (TLS trust, permissions, browser-specific behavior) complicated startup reliability.

To solve this, we combined:

- **Context window compression** with a sliding/context-shifting strategy for longer sessions.
- **Explicit memory management** to preserve task state across context compression and session restarts.

## Accomplishments that we're proud of

- Stable real-time audio/video + voice-response loop.
- Long practical session duration through compression + session recovery.
- Explicit step memory that keeps the assistant on track.
- AR mode with in-scene HUD/transcript plus `/eval` fallback for broader device support.
- Dynamic recipe selection from backend knowledge files without hardcoded frontend prompts.

## What we learned

- Compression extends session length, but explicit memory is critical for continuity quality.
- Real-time systems need robust queueing/restart behavior, not only model prompts.
- Mobile and AR browser security models must be treated as first-class engineering constraints.
- Good observability (tests, logs, API checks) dramatically reduces debugging time.

## What's next for ApronAI

- Richer structured memory (timers, ingredient state, parallel steps).
- More recipes and tool integrations (timers, substitutions, pantry-aware guidance).
- Better AR-first interaction patterns for hands-busy usage.
- Better AR overlay UI (e.g., using SLAM mapping information onto objects)
- Production hardening: auth, analytics, and multi-user deployment posture.

## Architecture

- `main.py`: FastAPI app, websocket endpoint, session orchestration, progress/knowledge APIs.
- `gemini_live.py`: Gemini Live client wrapper and streaming I/O pipeline.
- `progress_tracker.py`: explicit memory logic + thread-safe progress store.
- `frontend/index.html` + `frontend/ar-main.js`: AR/WebXR UI.
- `frontend/eval.html` + `frontend/main.js`: evaluation UI.

## Quick Start

### 1. Prerequisites

- Python 3.10+
- Node.js (for optional frontend syntax checks)
- `gcloud` CLI authenticated for Vertex AI access

### 2. Install dependencies

```bash
cd server
pip install -r requirements.txt
```

### 3. Authenticate

```bash
gcloud auth application-default login
```

### 4. Run locally

```bash
python main.py
```

Verbose logs:

```bash
python main.py -v
```

### 5. Open UI

- AR/WebXR UI: [http://localhost:8000/](http://localhost:8000/)
- Eval UI: [http://localhost:8000/eval](http://localhost:8000/eval)

## Mobile HTTPS (camera + mic)

For mobile testing, use HTTPS and a cert that includes your LAN IP in SAN.

```bash
cd server
./scripts/generate_dev_cert.sh
python main.py -h 0.0.0.0 -p 8000
```

Then open `https://<your-lan-ip>:8000` and trust the certificate on the device.

## Testing

### Automated tests

Run all backend tests:

```bash
cd server
python3 -m pytest -q
```

Run targeted suites:

```bash
python3 -m pytest -q tests/test_main_routes.py
python3 -m pytest -q tests/test_main_websocket.py
python3 -m pytest -q tests/test_main_memory.py
python3 -m pytest -q tests/test_gemini_live.py
```

### Frontend syntax check

```bash
node --check frontend/ar-main.js
```

### Manual smoke test

1. Start server with `python main.py -v`.
2. Open `/` and confirm recipe choices render.
3. Click **Start Session**, allow mic/camera permissions.
4. Confirm websocket status transitions to connected.
5. Speak a prompt and verify transcript + audio response.
6. Confirm progress updates via UI and `GET /api/progress`.
7. Open `/eval` and verify the legacy flow still works.

## Deploy to Google Cloud Run

### One-command deploy

```bash
cd server
PROJECT_ID=<your-project-id> ./deploy_cloud_run.sh
```

Optional overrides:

```bash
PROJECT_ID=<your-project-id> REGION=us-central1 SERVICE_NAME=apronai-live LOCATION=us-central1 MODEL=gemini-live-2.5-flash-native-audio ./deploy_cloud_run.sh
```

Apple Silicon note:

- Cloud Run requires `linux/amd64`; deploy script builds that target by default.

### IAM requirement

Grant the runtime service account Vertex AI user role:

```bash
gcloud projects add-iam-policy-binding <your-project-id> \
  --member="serviceAccount:<sa-email>" \
  --role="roles/aiplatform.user"
```

## Configuration

Key environment variables:

- `PROJECT_ID`: Google Cloud project ID.
- `LOCATION`: Vertex region (default `us-central1`).
- `MODEL`: Live model ID.
- `LIVE_API_VERSION`: Live API version (default `v1`).
- `LIVE_VOICE_NAME`: output voice (default `Zephyr`).
- `LIVE_ENABLE_CONTEXT_WINDOW_COMPRESSION`: enable/disable compression.
- `LIVE_COMPRESSION_TRIGGER_TOKENS`: optional compression trigger token threshold.
- `LIVE_COMPRESSION_TARGET_TOKENS`: optional compression target token threshold.
- `LIVE_ENGLISH_ONLY`: force English responses when enabled.
- `LIVE_SYSTEM_PROMPT`: optional global override prompt.
- `SESSION_RESTART_DELAY_SECONDS`: restart pause between session attempts.
- `MAX_AUDIO_QUEUE_SIZE`, `MAX_VIDEO_QUEUE_SIZE`, `MAX_TEXT_QUEUE_SIZE`: input queue bounds.

## Project Structure

```text
server/
├── main.py
├── gemini_live.py
├── progress_tracker.py
├── knolwedge/
│   ├── pasta.json
│   ├── taco.json
│   └── salard.json
├── frontend/
│   ├── index.html
│   ├── ar-main.js
│   ├── eval.html
│   ├── main.js
│   ├── gemini-client.js
│   ├── media-handler.js
│   └── pcm-processor.js
└── tests/
```
