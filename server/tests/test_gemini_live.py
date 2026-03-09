import asyncio
from pathlib import Path
import sys

SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

import gemini_live  # noqa: E402


def _build_fake_client(monkeypatch, captured, receive_impl):
    class FakeSession:
        async def send_realtime_input(self, *args, **kwargs):
            return None

        async def send(self, *args, **kwargs):
            return None

        async def send_tool_response(self, *args, **kwargs):
            return None

        def receive(self):
            return receive_impl()

    class FakeConnectContext:
        async def __aenter__(self):
            return FakeSession()

        async def __aexit__(self, exc_type, exc, tb):
            return False

    class FakeLive:
        def connect(self, *, model, config):
            captured["connect_model"] = model
            captured["connect_config"] = config
            return FakeConnectContext()

    class FakeAio:
        def __init__(self):
            self.live = FakeLive()

    class FakeClient:
        def __init__(self, **kwargs):
            captured["client_kwargs"] = kwargs
            self.aio = FakeAio()

    monkeypatch.setattr(gemini_live.genai, "Client", FakeClient)


async def _collect_events(generator):
    return [event async for event in generator]


def test_init_strips_vertex_model_prefix_and_applies_api_version(monkeypatch):
    captured = {}

    async def receive_impl():
        if False:
            yield None

    _build_fake_client(monkeypatch, captured, receive_impl)

    live = gemini_live.GeminiLive(
        project_id="p",
        location="us-central1",
        model="models/gemini-live-2.5-flash-native-audio",
        input_sample_rate=16000,
        api_version="v1",
    )

    assert live.model == "gemini-live-2.5-flash-native-audio"
    assert captured["client_kwargs"]["vertexai"] is True
    assert captured["client_kwargs"]["http_options"] == {"api_version": "v1"}


def test_init_omits_http_options_when_api_version_is_none(monkeypatch):
    captured = {}

    async def receive_impl():
        if False:
            yield None

    _build_fake_client(monkeypatch, captured, receive_impl)

    gemini_live.GeminiLive(
        project_id="p",
        location="us-central1",
        model="gemini-live-2.5-flash-native-audio",
        input_sample_rate=16000,
        api_version=None,
    )

    assert "http_options" not in captured["client_kwargs"]


def test_start_session_applies_live_config(monkeypatch):
    captured = {}

    async def receive_impl():
        if False:
            yield None

    _build_fake_client(monkeypatch, captured, receive_impl)

    live = gemini_live.GeminiLive(
        project_id="p",
        location="us-central1",
        model="models/custom-model",
        input_sample_rate=16000,
        media_resolution="MEDIA_RESOLUTION_HIGH",
        compression_trigger_tokens=1234,
        compression_target_tokens=567,
        enable_transcriptions=False,
        enable_proactive_audio=False,
        api_version="v1",
        voice_name="Zephyr",
        system_instruction_text="Teach pasta cooking clearly.",
        english_only=True,
    )

    events = asyncio.run(
        _collect_events(
            live.start_session(
                audio_input_queue=asyncio.Queue(),
                video_input_queue=asyncio.Queue(),
                text_input_queue=asyncio.Queue(),
                audio_output_callback=lambda data: None,
                session_resumption_handle="resume-123",
            )
        )
    )

    assert events == []
    assert captured["connect_model"] == "custom-model"
    cfg = captured["connect_config"]
    assert cfg.media_resolution == gemini_live.types.MediaResolution.MEDIA_RESOLUTION_HIGH
    assert cfg.context_window_compression.trigger_tokens == 1234
    assert cfg.context_window_compression.sliding_window.target_tokens == 567
    assert cfg.input_audio_transcription is None
    assert cfg.output_audio_transcription is None
    assert cfg.proactivity is None
    assert cfg.session_resumption.handle == "resume-123"
    assert cfg.session_resumption.transparent is True
    assert cfg.speech_config.voice_config.prebuilt_voice_config.voice_name == "Zephyr"
    assert cfg.system_instruction.role == "user"
    assert cfg.system_instruction.parts[0].text == (
        "Teach pasta cooking clearly.\n\nRESPOND IN ENGLISH. YOU MUST RESPOND UNMISTAKABLY IN ENGLISH."
    )


def test_start_session_yields_error_event_when_receive_fails(monkeypatch):
    captured = {}

    async def receive_impl():
        raise RuntimeError("boom")
        if False:
            yield None

    _build_fake_client(monkeypatch, captured, receive_impl)

    live = gemini_live.GeminiLive(
        project_id="p",
        location="us-central1",
        model="gemini-live-2.5-flash-native-audio",
        input_sample_rate=16000,
        api_version="v1",
    )

    events = asyncio.run(
        _collect_events(
            live.start_session(
                audio_input_queue=asyncio.Queue(),
                video_input_queue=asyncio.Queue(),
                text_input_queue=asyncio.Queue(),
                audio_output_callback=lambda data: None,
            )
        )
    )

    assert len(events) == 1
    assert events[0]["type"] == "error"
    assert "RuntimeError: boom" in events[0]["error"]


def test_start_session_enables_adaptive_compression_by_default(monkeypatch):
    captured = {}

    async def receive_impl():
        if False:
            yield None

    _build_fake_client(monkeypatch, captured, receive_impl)

    live = gemini_live.GeminiLive(
        project_id="p",
        location="us-central1",
        model="gemini-live-2.5-flash-native-audio",
        input_sample_rate=16000,
        api_version="v1",
    )

    events = asyncio.run(
        _collect_events(
            live.start_session(
                audio_input_queue=asyncio.Queue(),
                video_input_queue=asyncio.Queue(),
                text_input_queue=asyncio.Queue(),
                audio_output_callback=lambda data: None,
            )
        )
    )

    assert events == []
    cfg = captured["connect_config"]
    assert cfg.context_window_compression is not None
    assert cfg.context_window_compression.trigger_tokens is None
    assert cfg.context_window_compression.sliding_window is not None
    assert cfg.context_window_compression.sliding_window.target_tokens is None
