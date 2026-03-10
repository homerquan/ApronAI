from collections import deque
from copy import deepcopy
from threading import Lock
import re
import time


PASTA_STEPS = [
    "Bring a pot of water to a rolling boil.",
    "Add salt, then add pasta.",
    "Stir and cook until al dente.",
    "Reserve a little pasta water, then drain.",
    "Combine with sauce and finish for 1-2 minutes.",
]

PASTA_STEP_KEYWORDS = {
    1: ("boil", "boiling", "water"),
    2: ("salt", "pasta", "add pasta"),
    3: ("stir", "al dente", "cook"),
    4: ("reserve", "drain"),
    5: ("sauce", "combine", "finish"),
}

STEP_REF_PATTERN = re.compile(r"(?:step\s*(\d+)|(\d+)\s*(?:st|nd|rd|th)\s*step)")
DONE_PATTERN = re.compile(
    r"\b(done|finished|completed|all set|ready|i did it|i'm done|its done|it's done)\b"
)
START_PATTERN = re.compile(r"\b(start|begin|go ahead|let's cook|lets cook)\b")


class RecipeProgressMemory:
    """Tracks progress in explicit text memory checkpoints for a recipe."""

    def __init__(self, task_name="Cook pasta", steps=None, step_keywords=None):
        self.task_name = task_name
        self.steps = list(steps or PASTA_STEPS)
        if step_keywords is None:
            self.step_keywords = {k: tuple(v) for k, v in PASTA_STEP_KEYWORDS.items()}
        else:
            normalized = {}
            for step, words in step_keywords.items():
                try:
                    step_num = int(step)
                except (TypeError, ValueError):
                    continue
                normalized[step_num] = tuple(words or ())
            self.step_keywords = normalized
        self.current_step = 1
        self.completed_steps = set()
        self.recent_user_turns = deque(maxlen=3)
        self.has_started = False
        self.last_signature = None

    def _extract_step_reference(self, text: str):
        match = STEP_REF_PATTERN.search(text)
        if not match:
            return None
        step_str = match.group(1) or match.group(2)
        try:
            step = int(step_str)
        except (TypeError, ValueError):
            return None
        if 1 <= step <= len(self.steps):
            return step
        return None

    def _infer_step_from_keywords(self, text: str):
        for step, words in self.step_keywords.items():
            if any(word in text for word in words):
                return step
        return None

    def observe_user_turn(self, text: str):
        if not text:
            return False
        normalized = " ".join(text.strip().lower().split())
        if not normalized:
            return False

        self.recent_user_turns.append(text.strip())
        before = (
            self.has_started,
            self.current_step,
            tuple(sorted(self.completed_steps)),
        )

        referenced_step = self._extract_step_reference(normalized)
        if referenced_step is None:
            referenced_step = self._infer_step_from_keywords(normalized)

        if referenced_step is not None:
            self.has_started = True
            self.current_step = max(1, min(len(self.steps), referenced_step))

        if START_PATTERN.search(normalized):
            self.has_started = True

        if DONE_PATTERN.search(normalized):
            self.has_started = True
            done_step = referenced_step or self.current_step
            self.completed_steps.add(done_step)
            if done_step == self.current_step and self.current_step < len(self.steps):
                self.current_step += 1

        after = (
            self.has_started,
            self.current_step,
            tuple(sorted(self.completed_steps)),
        )
        return before != after

    def build_checkpoint_text(self):
        completed = sorted(self.completed_steps)
        if completed:
            completed_text = ", ".join(
                f"{step}. {self.steps[step - 1]}" for step in completed
            )
        else:
            completed_text = "none"

        if self.has_started:
            current_text = self.steps[self.current_step - 1]
            step_line = f"Current step: {self.current_step}/{len(self.steps)} - {current_text}"
        else:
            step_line = (
                "Current step: not started yet. "
                f"Next step is 1/{len(self.steps)} - {self.steps[0]}"
            )

        recent_user = self.recent_user_turns[-1] if self.recent_user_turns else "none yet"

        return (
            "MEMORY CHECKPOINT (internal, do not acknowledge):\n"
            f"Task: {self.task_name}.\n"
            f"{step_line}\n"
            f"Completed steps: {completed_text}\n"
            f"Latest user turn: {recent_user}\n"
            "Use this to keep continuity. Do not restart from step 1 unless the user asks."
        )

    def build_checkpoint_message(self, force=False):
        signature = (
            self.has_started,
            self.current_step,
            tuple(sorted(self.completed_steps)),
            self.recent_user_turns[-1] if self.recent_user_turns else "",
        )
        if not force and signature == self.last_signature:
            return None
        self.last_signature = signature
        return {"text": self.build_checkpoint_text(), "end_of_turn": False}

    def to_progress_payload(self):
        steps = []
        for idx, text in enumerate(self.steps, start=1):
            if idx in self.completed_steps:
                status = "done"
            elif self.has_started and idx == self.current_step:
                status = "in_progress"
            else:
                status = "wait"
            steps.append({"step": idx, "text": text, "status": status})
        return {
            "has_started": self.has_started,
            "current_step": self.current_step,
            "completed_steps": sorted(self.completed_steps),
            "steps": steps,
            "latest_user_turn": self.recent_user_turns[-1] if self.recent_user_turns else "",
            "task": self.task_name,
        }


class PastaProgressMemory(RecipeProgressMemory):
    """Backwards-compatible pasta-specific progress memory."""

    def __init__(self, steps=None):
        super().__init__(
            task_name="Cook pasta",
            steps=steps or PASTA_STEPS,
            step_keywords=PASTA_STEP_KEYWORDS,
        )


class ProgressStateStore:
    """Thread-safe progress store used by both API and websocket events."""

    def __init__(self):
        self._lock = Lock()
        self._state = {}
        self.set_from_memory(PastaProgressMemory())

    def _with_timestamp(self, payload):
        out = dict(payload)
        out["updated_at"] = time.time()
        return out

    def set(self, payload):
        state = self._with_timestamp(payload)
        with self._lock:
            self._state.clear()
            self._state.update(state)
            return deepcopy(self._state)

    def set_from_memory(self, memory: RecipeProgressMemory):
        return self.set(memory.to_progress_payload())

    def get(self):
        with self._lock:
            return deepcopy(self._state)
