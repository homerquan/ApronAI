import importlib
import logging
from pathlib import Path
import sys


SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))


def test_configure_logging_sets_debug_level(monkeypatch):
    monkeypatch.chdir(SERVER_DIR)
    main = importlib.import_module("main")
    main.configure_logging(1)

    assert logging.getLogger().getEffectiveLevel() == logging.DEBUG
