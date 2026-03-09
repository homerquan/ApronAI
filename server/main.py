import argparse
import asyncio
import base64
import contextlib
import json
import logging
import os

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from gemini_live import GeminiLive

# Load environment variables
load_dotenv()

logger = logging.getLogger(__name__)


def parse_optional_int_env(name: str):
    raw = os.getenv(name)
    if raw is None:
        return None
    raw = raw.strip()
    if raw == "":
        return None
    return int(raw)


# Configuration
PROJECT_ID = os.getenv("PROJECT_ID", "your-gcp-project-id")
LOCATION = os.getenv("LOCATION", "us-central1")
MODEL = os.getenv("MODEL", "gemini-live-2.5-flash-native-audio")
SESSION_RESTART_DELAY_SECONDS = float(os.getenv("SESSION_RESTART_DELAY_SECONDS", "0.75"))
MAX_AUDIO_QUEUE_SIZE = int(os.getenv("MAX_AUDIO_QUEUE_SIZE", "128"))
MAX_VIDEO_QUEUE_SIZE = int(os.getenv("MAX_VIDEO_QUEUE_SIZE", "8"))
MAX_TEXT_QUEUE_SIZE = int(os.getenv("MAX_TEXT_QUEUE_SIZE", "64"))
LIVE_MEDIA_RESOLUTION = os.getenv("LIVE_MEDIA_RESOLUTION", "MEDIA_RESOLUTION_MEDIUM")
LIVE_ENABLE_CONTEXT_WINDOW_COMPRESSION = os.getenv(
    "LIVE_ENABLE_CONTEXT_WINDOW_COMPRESSION", "1"
).lower() not in {"0", "false", "no"}
LIVE_COMPRESSION_TRIGGER_TOKENS = parse_optional_int_env("LIVE_COMPRESSION_TRIGGER_TOKENS")
LIVE_COMPRESSION_TARGET_TOKENS = parse_optional_int_env("LIVE_COMPRESSION_TARGET_TOKENS")
LIVE_ENABLE_TRANSCRIPTIONS = os.getenv("LIVE_ENABLE_TRANSCRIPTIONS", "1").lower() not in {"0", "false", "no"}
LIVE_ENABLE_PROACTIVE_AUDIO = os.getenv("LIVE_ENABLE_PROACTIVE_AUDIO", "0").lower() in {"1", "true", "yes"}
LIVE_API_VERSION = os.getenv("LIVE_API_VERSION", "v1").strip() or None
LIVE_VOICE_NAME = os.getenv("LIVE_VOICE_NAME", "Zephyr")
LIVE_SYSTEM_PROMPT = os.getenv(
    "LIVE_SYSTEM_PROMPT",
    (
        "You are an AI assistant that teaches users how to cook pasta. "
        "Provide practical, step-by-step guidance with clear timings."
    ),
)
LIVE_ENGLISH_ONLY = os.getenv("LIVE_ENGLISH_ONLY", "1").lower() not in {
    "0",
    "false",
    "no",
}


def configure_logging(verbose_count: int = 0):
    level = logging.INFO if verbose_count <= 0 else logging.DEBUG
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s:%(name)s:%(message)s",
        force=True,
    )
    logger.debug("Verbose logging enabled (count=%s)", verbose_count)

# Initialize FastAPI
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve static files
app.mount("/static", StaticFiles(directory="frontend"), name="static")


@app.get("/")
async def root():
    return FileResponse("frontend/index.html")


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for Gemini Live."""
    await websocket.accept()

    logger.info("WebSocket connection accepted")

    audio_input_queue = asyncio.Queue(maxsize=MAX_AUDIO_QUEUE_SIZE)
    video_input_queue = asyncio.Queue(maxsize=MAX_VIDEO_QUEUE_SIZE)
    text_input_queue = asyncio.Queue(maxsize=MAX_TEXT_QUEUE_SIZE)
    stop_event = asyncio.Event()

    async def put_realtime(queue: asyncio.Queue, payload: bytes, label: str):
        if queue.full():
            with contextlib.suppress(asyncio.QueueEmpty):
                queue.get_nowait()
                logger.debug("Dropped stale %s frame", label)
        with contextlib.suppress(asyncio.QueueFull):
            queue.put_nowait(payload)

    def clear_queue(queue: asyncio.Queue) -> int:
        dropped = 0
        while not queue.empty():
            with contextlib.suppress(asyncio.QueueEmpty):
                queue.get_nowait()
                dropped += 1
        return dropped

    async def audio_output_callback(data):
        await websocket.send_bytes(data)

    async def audio_interrupt_callback():
        # The event queue handles the JSON message, but we might want to do something else here
        pass

    gemini_client = GeminiLive(
        project_id=PROJECT_ID,
        location=LOCATION,
        model=MODEL,
        input_sample_rate=16000,
        media_resolution=LIVE_MEDIA_RESOLUTION,
        enable_context_window_compression=LIVE_ENABLE_CONTEXT_WINDOW_COMPRESSION,
        compression_trigger_tokens=LIVE_COMPRESSION_TRIGGER_TOKENS,
        compression_target_tokens=LIVE_COMPRESSION_TARGET_TOKENS,
        enable_transcriptions=LIVE_ENABLE_TRANSCRIPTIONS,
        enable_proactive_audio=LIVE_ENABLE_PROACTIVE_AUDIO,
        api_version=LIVE_API_VERSION,
        voice_name=LIVE_VOICE_NAME,
        system_instruction_text=LIVE_SYSTEM_PROMPT,
        english_only=LIVE_ENGLISH_ONLY,
    )
    logger.info(
        "Gemini config model=%s location=%s api_version=%s media_resolution=%s compression_enabled=%s compression=(%s->%s) transcriptions=%s proactive_audio=%s voice=%s english_only=%s",
        gemini_client.model,
        LOCATION,
        LIVE_API_VERSION,
        LIVE_MEDIA_RESOLUTION,
        LIVE_ENABLE_CONTEXT_WINDOW_COMPRESSION,
        LIVE_COMPRESSION_TRIGGER_TOKENS,
        LIVE_COMPRESSION_TARGET_TOKENS,
        LIVE_ENABLE_TRANSCRIPTIONS,
        LIVE_ENABLE_PROACTIVE_AUDIO,
        LIVE_VOICE_NAME,
        LIVE_ENGLISH_ONLY,
    )

    async def receive_from_client():
        try:
            while not stop_event.is_set():
                message = await websocket.receive()

                if message.get("bytes"):
                    await put_realtime(audio_input_queue, message["bytes"], "audio")
                elif message.get("text"):
                    text = message["text"]
                    try:
                        payload = json.loads(text)
                        if isinstance(payload, dict) and payload.get("type") == "image" and payload.get("data"):
                            image_data = base64.b64decode(payload["data"], validate=True)
                            await put_realtime(video_input_queue, image_data, "video")
                            continue
                        if isinstance(payload, dict) and isinstance(payload.get("text"), str):
                            await text_input_queue.put(payload["text"])
                            continue
                    except json.JSONDecodeError:
                        pass
                    except Exception as e:
                        logger.warning("Failed to parse client payload: %s", e)
                        continue

                    await text_input_queue.put(text)
        except WebSocketDisconnect:
            logger.info("WebSocket disconnected")
        except Exception as e:
            logger.error(f"Error receiving from client: {e}")
        finally:
            stop_event.set()

    receive_task = asyncio.create_task(receive_from_client())

    async def run_session():
        restart_count = 0
        resume_handle = None
        while not stop_event.is_set():
            restart_count += 1
            if restart_count > 1:
                logger.info("Restarting Gemini Live session (attempt %s)", restart_count)
                # Keep text history but drop stale realtime media before resuming.
                dropped_audio = clear_queue(audio_input_queue)
                dropped_video = clear_queue(video_input_queue)
                if dropped_audio or dropped_video:
                    logger.info(
                        "Dropped stale media before restart (audio=%s, video=%s)",
                        dropped_audio,
                        dropped_video,
                    )
                with contextlib.suppress(Exception):
                    await websocket.send_json(
                        {
                            "type": "session_restarting",
                            "attempt": restart_count,
                            "resuming": bool(resume_handle),
                        }
                    )
                await asyncio.sleep(SESSION_RESTART_DELAY_SECONDS)

            try:
                logger.info(
                    "Opening Gemini Live session attempt=%s resume=%s",
                    restart_count,
                    bool(resume_handle),
                )
                async for event in gemini_client.start_session(
                    audio_input_queue=audio_input_queue,
                    video_input_queue=video_input_queue,
                    text_input_queue=text_input_queue,
                    audio_output_callback=audio_output_callback,
                    audio_interrupt_callback=audio_interrupt_callback,
                    session_resumption_handle=resume_handle,
                ):
                    if stop_event.is_set():
                        break
                    if not event:
                        continue
                    if event.get("type") == "session_resumption_update":
                        if event.get("resumable") and event.get("new_handle"):
                            resume_handle = event["new_handle"]
                        continue
                    if event.get("type") == "go_away":
                        logger.info("Gemini go_away received (time_left=%s)", event.get("time_left"))
                        continue
                    if event.get("type") == "error":
                        error_msg = event.get("error", "")
                        logger.warning("Gemini session error: %s", error_msg)
                        # Reset stale resume handles if server rejects them.
                        if resume_handle and "handle" in error_msg.lower():
                            resume_handle = None
                    # Forward events (transcriptions, etc) to client
                    await websocket.send_json(event)
            except WebSocketDisconnect:
                logger.info("WebSocket disconnected during session loop")
                stop_event.set()
                break
            except Exception as e:
                logger.exception("Gemini session loop failed")
                with contextlib.suppress(Exception):
                    await websocket.send_json({"type": "error", "error": str(e)})

    try:
        await run_session()
    except Exception as e:
        logger.error(f"Error in Gemini session: {e}")
    finally:
        stop_event.set()
        receive_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await receive_task
        # Ensure websocket is closed if not already
        with contextlib.suppress(Exception):
            await websocket.close()


if __name__ == "__main__":
    import uvicorn

    parser = argparse.ArgumentParser(description="Gemini Live FastAPI server")
    parser.add_argument(
        "-v",
        "--verbose",
        action="count",
        default=0,
        help="Increase logging verbosity (-v for debug app logs)",
    )
    parser.add_argument(
        "--host",
        default=os.getenv("HOST", "localhost"),
        help="Host to bind",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.getenv("PORT", 8000)),
        help="Port to bind",
    )
    args = parser.parse_args()

    configure_logging(args.verbose)
    logger.info("Starting server host=%s port=%s", args.host, args.port)

    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        log_level="debug" if args.verbose else "info",
    )
