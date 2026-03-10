import argparse
import asyncio
import base64
import contextlib
import json
import logging
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from gemini_live import GeminiLive
from progress_tracker import (
    PASTA_STEPS,
    ProgressStateStore,
    RecipeProgressMemory,
)

SERVER_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SSL_CERTFILE = os.path.join(SERVER_DIR, "ssl", "cert.pem")
DEFAULT_SSL_KEYFILE = os.path.join(SERVER_DIR, "ssl", "key.pem")
KNOLWEDGE_DIR = Path(SERVER_DIR) / "knolwedge"

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


def load_knowledge_entries():
    entries = {}
    if not KNOLWEDGE_DIR.exists():
        return entries

    for path in sorted(KNOLWEDGE_DIR.glob("*.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.warning("Skipping invalid knowledge file %s: %s", path.name, exc)
            continue

        recipe_id = str(payload.get("id") or path.stem).strip().lower()
        prompt = str(payload.get("prompt") or "").strip()
        steps = [str(step).strip() for step in payload.get("steps") or [] if str(step).strip()]
        if not recipe_id or not prompt or not steps:
            logger.warning(
                "Skipping knowledge file %s (missing id/prompt/steps)", path.name
            )
            continue

        keywords = payload.get("keywords") or {}
        if not isinstance(keywords, dict):
            keywords = {}

        entries[recipe_id] = {
            "id": recipe_id,
            "title": str(payload.get("title") or recipe_id.title()),
            "task": str(payload.get("task") or f"Cook {recipe_id}"),
            "prompt": prompt,
            "steps": steps,
            "keywords": keywords,
        }
    return entries


KNOWLEDGE_RECIPES = load_knowledge_entries()
DEFAULT_RECIPE_ID = os.getenv("DEFAULT_RECIPE_ID", "pasta").strip().lower()
if DEFAULT_RECIPE_ID not in KNOWLEDGE_RECIPES and KNOWLEDGE_RECIPES:
    DEFAULT_RECIPE_ID = next(iter(KNOWLEDGE_RECIPES))
if not KNOWLEDGE_RECIPES:
    KNOWLEDGE_RECIPES["pasta"] = {
        "id": "pasta",
        "title": "Pasta",
        "task": "Cook pasta",
        "prompt": (
            "You are a pasta-cooking coach. Follow this sequence exactly: "
            + " ".join(f"{idx}) {text}" for idx, text in enumerate(PASTA_STEPS, start=1))
            + " Guide one step at a time, ask for brief confirmation before moving on, "
            "and keep track of the current step."
        ),
        "steps": list(PASTA_STEPS),
        "keywords": {},
    }
    DEFAULT_RECIPE_ID = "pasta"


def get_recipe_config(recipe_id: str | None):
    if recipe_id:
        key = recipe_id.strip().lower()
        if key in KNOWLEDGE_RECIPES:
            return KNOWLEDGE_RECIPES[key]
    return KNOWLEDGE_RECIPES[DEFAULT_RECIPE_ID]


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
LIVE_SYSTEM_PROMPT_OVERRIDE = os.getenv("LIVE_SYSTEM_PROMPT")
LIVE_ENGLISH_ONLY = os.getenv("LIVE_ENGLISH_ONLY", "1").lower() not in {
    "0",
    "false",
    "no",
}

progress_store = ProgressStateStore()


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


@app.get("/eval")
async def eval_frontend():
    return FileResponse("frontend/eval.html")


@app.get("/api/progress")
async def progress():
    return progress_store.get()


@app.get("/api/knowledge")
async def knowledge_list():
    recipes = [
        {"id": item["id"], "title": item["title"]}
        for item in KNOWLEDGE_RECIPES.values()
    ]
    return {"default": DEFAULT_RECIPE_ID, "recipes": recipes}


@app.get("/api/knowledge/{recipe_id}")
async def knowledge_item(recipe_id: str):
    key = recipe_id.strip().lower()
    recipe = KNOWLEDGE_RECIPES.get(key)
    if not recipe:
        raise HTTPException(status_code=404, detail="Unknown recipe")
    return recipe


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for Gemini Live."""
    await websocket.accept()

    logger.info("WebSocket connection accepted")

    audio_input_queue = asyncio.Queue(maxsize=MAX_AUDIO_QUEUE_SIZE)
    video_input_queue = asyncio.Queue(maxsize=MAX_VIDEO_QUEUE_SIZE)
    text_input_queue = asyncio.Queue(maxsize=MAX_TEXT_QUEUE_SIZE)
    stop_event = asyncio.Event()
    session_started = False
    active_recipe_id = DEFAULT_RECIPE_ID
    run_session_task = None
    receive_task = None

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

    async def run_session(recipe_id: str):
        restart_count = 0
        resume_handle = None
        recipe = get_recipe_config(recipe_id)
        memory_tracker = RecipeProgressMemory(
            task_name=recipe["task"],
            steps=recipe["steps"],
            step_keywords=recipe.get("keywords"),
        )
        system_prompt_text = LIVE_SYSTEM_PROMPT_OVERRIDE or recipe["prompt"]
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
            system_instruction_text=system_prompt_text,
            english_only=LIVE_ENGLISH_ONLY,
        )
        logger.info(
            "Gemini config model=%s location=%s api_version=%s media_resolution=%s compression_enabled=%s compression=(%s->%s) transcriptions=%s proactive_audio=%s voice=%s english_only=%s recipe=%s",
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
            recipe["id"],
        )
        initial_progress = progress_store.set_from_memory(memory_tracker)
        with contextlib.suppress(Exception):
            await websocket.send_json({"type": "progress", "progress": initial_progress})
        pending_user_transcript = []
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

            # Reinforce progress memory at the start of each model session.
            checkpoint_message = memory_tracker.build_checkpoint_message(force=True)
            if checkpoint_message:
                await text_input_queue.put(checkpoint_message)

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
                    if event.get("type") == "user" and event.get("text"):
                        pending_user_transcript.append(event["text"])
                    if event.get("type") == "turn_complete" and pending_user_transcript:
                        merged_user_turn = "".join(pending_user_transcript).strip()
                        pending_user_transcript.clear()
                        if memory_tracker.observe_user_turn(merged_user_turn):
                            progress_payload = progress_store.set_from_memory(
                                memory_tracker
                            )
                            checkpoint_message = memory_tracker.build_checkpoint_message(
                                force=True
                            )
                            if checkpoint_message:
                                await text_input_queue.put(checkpoint_message)
                                logger.debug(
                                    "Updated recipe memory checkpoint for step %s",
                                    memory_tracker.current_step,
                                )
                            with contextlib.suppress(Exception):
                                await websocket.send_json(
                                    {"type": "progress", "progress": progress_payload}
                                )
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

    async def start_model_session_if_needed(recipe_id: str | None):
        nonlocal session_started, run_session_task, active_recipe_id
        if session_started and run_session_task and not run_session_task.done():
            return
        recipe = get_recipe_config(recipe_id)
        active_recipe_id = recipe["id"]
        session_started = True
        run_session_task = asyncio.create_task(run_session(active_recipe_id))
        logger.info(
            "Gemini model session started by client request (recipe=%s)",
            active_recipe_id,
        )
        with contextlib.suppress(Exception):
            await websocket.send_json({"type": "session_started", "recipe": active_recipe_id})

    async def receive_from_client():
        try:
            while not stop_event.is_set():
                message = await websocket.receive()
                if message.get("type") == "websocket.disconnect":
                    logger.info("WebSocket disconnect frame received")
                    break

                if message.get("bytes"):
                    if not session_started:
                        logger.debug("Ignoring audio chunk before start_session")
                        continue
                    await put_realtime(audio_input_queue, message["bytes"], "audio")
                elif message.get("text"):
                    text = message["text"]
                    logger.debug("Client text frame: %s", text[:240])
                    try:
                        payload = json.loads(text)
                        if isinstance(payload, dict):
                            if payload.get("type") == "start_session":
                                logger.info("Received start_session request from client")
                                requested_recipe = payload.get("recipe")
                                await start_model_session_if_needed(requested_recipe)
                                continue
                            if payload.get("type") == "image" and payload.get("data"):
                                if not session_started:
                                    logger.debug("Ignoring image frame before start_session")
                                    continue
                                image_data = base64.b64decode(payload["data"], validate=True)
                                await put_realtime(video_input_queue, image_data, "video")
                                continue
                            if isinstance(payload.get("text"), str):
                                if not session_started:
                                    logger.debug("Ignoring text input before start_session")
                                    continue
                                await text_input_queue.put(payload["text"])
                                continue
                    except json.JSONDecodeError:
                        pass
                    except Exception as e:
                        logger.warning("Failed to parse client payload: %s", e)
                        continue

                    if session_started:
                        await text_input_queue.put(text)
                    else:
                        logger.debug("Ignoring plain text payload before start_session")
        except WebSocketDisconnect:
            logger.info("WebSocket disconnected")
        except Exception as e:
            logger.error(f"Error receiving from client: {e}")
        finally:
            stop_event.set()

    with contextlib.suppress(Exception):
        await websocket.send_json(
            {
                "type": "ready",
                "session_started": False,
                "default_recipe": DEFAULT_RECIPE_ID,
            }
        )

    try:
        receive_task = asyncio.create_task(receive_from_client())
        await receive_task
    finally:
        stop_event.set()
        if run_session_task:
            run_session_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await run_session_task
        if receive_task:
            receive_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await receive_task
        # Ensure websocket is closed if not already
        with contextlib.suppress(Exception):
            await websocket.close()


if __name__ == "__main__":
    import uvicorn

    parser = argparse.ArgumentParser(
        description="Gemini Live FastAPI server",
        add_help=False,
    )
    parser.add_argument(
        "--help",
        action="help",
        help="Show this help message and exit",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="count",
        default=0,
        help="Increase logging verbosity (-v for debug app logs)",
    )
    parser.add_argument(
        "-h",
        "--host",
        default=os.getenv("HOST", "localhost"),
        help="Host to bind",
    )
    parser.add_argument(
        "-p",
        "--port",
        type=int,
        default=int(os.getenv("PORT", 8000)),
        help="Port to bind",
    )
    parser.add_argument(
        "--ssl-certfile",
        default=os.getenv("SSL_CERTFILE", DEFAULT_SSL_CERTFILE),
        help="Path to TLS certificate file (enables HTTPS when set with --ssl-keyfile)",
    )
    parser.add_argument(
        "--ssl-keyfile",
        default=os.getenv("SSL_KEYFILE", DEFAULT_SSL_KEYFILE),
        help="Path to TLS private key file (enables HTTPS when set with --ssl-certfile)",
    )
    args = parser.parse_args()

    configure_logging(args.verbose)
    scheme = "https" if args.ssl_certfile and args.ssl_keyfile else "http"
    logger.info("Starting server host=%s port=%s scheme=%s", args.host, args.port, scheme)

    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        log_level="debug" if args.verbose else "info",
        ssl_certfile=args.ssl_certfile,
        ssl_keyfile=args.ssl_keyfile,
    )
