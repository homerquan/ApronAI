import asyncio
import importlib
import json
import logging
from pathlib import Path
import sys

from fastapi.testclient import TestClient


SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))


def _load_main(monkeypatch):
    monkeypatch.chdir(SERVER_DIR)
    sys.modules.pop("main", None)
    return importlib.import_module("main")


class _FakeGeminiLive:
    def __init__(self, *args, **kwargs):
        self.model = kwargs.get("model", "fake-model")

    async def start_session(self, **kwargs):
        # Keep the fake session alive until the websocket closes/cancels.
        while True:
            await asyncio.sleep(1)
            if False:
                yield {}


def _recv_until_session_started(ws):
    first = ws.receive_json()
    if first.get("type") == "session_started":
        return first
    assert first.get("type") == "progress"
    second = ws.receive_json()
    assert second.get("type") == "session_started"
    return second


def test_ws_ready_and_start_session_handshake(monkeypatch):
    main = _load_main(monkeypatch)
    monkeypatch.setattr(main, "GeminiLive", _FakeGeminiLive)

    with TestClient(main.app) as client:
        with client.websocket_connect("/ws") as ws:
            ready = ws.receive_json()
            assert ready["type"] == "ready"
            assert ready["session_started"] is False

            ws.send_text(json.dumps({"type": "start_session"}))
            started = _recv_until_session_started(ws)
            assert started["type"] == "session_started"


def test_ws_disconnect_does_not_log_receive_after_disconnect_error(monkeypatch, caplog):
    main = _load_main(monkeypatch)
    monkeypatch.setattr(main, "GeminiLive", _FakeGeminiLive)

    with caplog.at_level(logging.ERROR):
        with TestClient(main.app) as client:
            with client.websocket_connect("/ws") as ws:
                ready = ws.receive_json()
                assert ready["type"] == "ready"
                assert ready["session_started"] is False

    assert not any(
        'Cannot call "receive" once a disconnect message has been received.'
        in record.getMessage()
        for record in caplog.records
    )


def test_ws_start_session_uses_selected_recipe(monkeypatch):
    main = _load_main(monkeypatch)
    monkeypatch.setattr(main, "GeminiLive", _FakeGeminiLive)

    with TestClient(main.app) as client:
        with client.websocket_connect("/ws") as ws:
            ready = ws.receive_json()
            assert ready["type"] == "ready"
            ws.send_text(json.dumps({"type": "start_session", "recipe": "taco"}))

            messages = [ws.receive_json(), ws.receive_json()]
            assert any(msg.get("type") == "session_started" for msg in messages)
            progress_msg = next(msg for msg in messages if msg.get("type") == "progress")
            assert progress_msg["progress"]["task"] == "Cook tacos"
