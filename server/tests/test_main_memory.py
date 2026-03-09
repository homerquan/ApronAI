import importlib
from pathlib import Path
import sys


SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))


def _load_progress_tracker():
    return importlib.import_module("progress_tracker")


def test_pasta_memory_initial_checkpoint(monkeypatch):
    tracker_mod = _load_progress_tracker()
    tracker = tracker_mod.PastaProgressMemory()

    msg = tracker.build_checkpoint_message(force=True)
    assert msg["end_of_turn"] is False
    assert "Current step: not started yet." in msg["text"]
    assert "Completed steps: none" in msg["text"]


def test_pasta_memory_advances_when_step_completed(monkeypatch):
    tracker_mod = _load_progress_tracker()
    tracker = tracker_mod.PastaProgressMemory()

    changed = tracker.observe_user_turn("I completed step 1, what next?")
    assert changed is True
    assert tracker.has_started is True
    assert tracker.current_step == 2
    assert 1 in tracker.completed_steps

    msg = tracker.build_checkpoint_message(force=True)
    assert "Current step: 2/5" in msg["text"]
    assert "1. Bring a pot of water to a rolling boil." in msg["text"]


def test_pasta_memory_deduplicates_same_signature(monkeypatch):
    tracker_mod = _load_progress_tracker()
    tracker = tracker_mod.PastaProgressMemory()

    first = tracker.build_checkpoint_message(force=False)
    second = tracker.build_checkpoint_message(force=False)
    assert first is not None
    assert second is None


def test_pasta_memory_progress_payload_statuses(monkeypatch):
    tracker_mod = _load_progress_tracker()
    tracker = tracker_mod.PastaProgressMemory()
    initial_payload = tracker.to_progress_payload()
    assert all(item["status"] == "wait" for item in initial_payload["steps"])

    tracker.observe_user_turn("I completed step 1.")
    payload = tracker.to_progress_payload()

    by_step = {item["step"]: item["status"] for item in payload["steps"]}
    assert by_step[1] == "done"
    assert by_step[2] == "in_progress"
    assert by_step[3] == "wait"
