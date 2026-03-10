import importlib
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


def test_root_serves_ar_frontend(monkeypatch):
    main = _load_main(monkeypatch)
    with TestClient(main.app) as client:
        response = client.get("/")
        assert response.status_code == 200
        assert "ApronAI AR Coach" in response.text
        assert "/static/ar-main.js" in response.text


def test_eval_serves_existing_frontend(monkeypatch):
    main = _load_main(monkeypatch)
    with TestClient(main.app) as client:
        response = client.get("/eval")
        assert response.status_code == 200
        assert "Gemini Live API Demo" in response.text
        assert "/static/main.js" in response.text


def test_knowledge_list_includes_expected_recipes(monkeypatch):
    main = _load_main(monkeypatch)
    with TestClient(main.app) as client:
        response = client.get("/api/knowledge")
        assert response.status_code == 200
        payload = response.json()
        ids = {item["id"] for item in payload["recipes"]}
        assert {"pasta", "taco", "salard"}.issubset(ids)


def test_knowledge_item_returns_prompt_and_steps(monkeypatch):
    main = _load_main(monkeypatch)
    with TestClient(main.app) as client:
        response = client.get("/api/knowledge/taco")
        assert response.status_code == 200
        payload = response.json()
        assert payload["id"] == "taco"
        assert isinstance(payload["prompt"], str) and payload["prompt"]
        assert isinstance(payload["steps"], list) and len(payload["steps"]) >= 3
