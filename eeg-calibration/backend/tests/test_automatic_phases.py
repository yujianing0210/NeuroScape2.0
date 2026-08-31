from __future__ import annotations

import time
from pathlib import Path

import pytest

from app import config
from app.calibration.service import CalibrationService, GUIDED_BASELINE
from app.models.schemas import CalibrationState
from app.storage.session_store import SessionStore


class ManualTimer:
    instances = []
    def __init__(self, interval, callback):
        self.interval, self.callback, self.cancelled = interval, callback, False
        self.daemon = False
        self.instances.append(self)
    def start(self): pass
    def cancel(self): self.cancelled = True
    def fire(self):
        if not self.cancelled: self.callback()


class ReadyReceiver:
    def __init__(self):
        self.osc_callback = self.eeg_callback = None
        self.total_eeg_samples = 3000
        self._session_start = None
        self._marker_index = 0
        self.session_blink_events = 0
    def set_session_start(self, value): self._session_start = value
    def elapsed(self, now=None): return None if self._session_start is None else (now or time.monotonic()) - self._session_start
    def nearest_sample_index(self, _timestamp):
        value = self._marker_index
        self._marker_index += 1
        return value
    def snapshot_samples(self, _start=None, _end=None): return []
    def status(self):
        return {"connected": True, "total_eeg_samples": self.total_eeg_samples,
                "estimated_sample_rate_hz": 256.0, "last_packet_age_seconds": .01,
                "headband_on": True, "hsi": {"TP9": 1, "AF7": 1, "AF8": 1, "TP10": 1},
                "accelerometer": [None]*3, "gyroscope": [None]*3, "malformed_messages": 0,
                "packet_completeness": 1.0, "low_rate_warning": False, "real_data_seconds": 20.0,
                "blink_events_total": self.session_blink_events, "blink_events_session": self.session_blink_events,
                "last_blink_age_seconds": None, "waveform": []}
    def start(self): pass
    def stop(self): pass


def ready_service(tmp_path: Path) -> CalibrationService:
    ManualTimer.instances.clear()
    service = CalibrationService(store=SessionStore(tmp_path), receiver=ReadyReceiver(), timer_factory=ManualTimer)
    service.create_session("P1")
    service.machine.transition(CalibrationState.READY)
    return service


def quality(values, status="pass"):
    return {"status": status, "reasons": [] if status == "pass" else ["fewer_than_25_valid_epochs"],
            "expected_epochs": 30, "total_epochs": 30, "valid_epochs": len(values),
            "invalid_epochs": 30-len(values), "blink_epochs": 0, "packet_completeness": 1.0,
            "rejection_counts": {}, "channel_contributions": {"AF7": len(values), "AF8": len(values)},
            "epoch_tbrs": values, "epoch_details": [{"packet_completeness": 1.0, "valid_channels": ["AF7", "AF8"]} for _ in values]}


def completed_block(values, status="pass", block_id="baseline_1"):
    return {"block_id": block_id, "condition": GUIDED_BASELINE, "included_in_baseline": False,
            "condition_block_number": 1,
            "self_report": {"focus": 5, "drowsiness": 2}, "eeg_quality": quality(values, status)}


def test_single_baseline_schedule_and_automatic_timers(tmp_path):
    service = ready_service(tmp_path)
    assert [task["condition"] for task in service.original_schedule] == [GUIDED_BASELINE]
    service.start_acclimation()
    assert ManualTimer.instances[0].interval == config.ACCLIMATION_SECONDS == 60
    ManualTimer.instances[0].fire()
    service.accept_acclimation()
    start = service.start_block()
    assert start.event == "BASELINE_START"
    assert ManualTimer.instances[1].interval == config.BASELINE_SECONDS == 300
    service.shutdown()


def test_completed_failed_baseline_is_analyzed_and_schedules_one_redo(tmp_path, monkeypatch):
    service = ready_service(tmp_path)
    service.machine.state = CalibrationState.BLOCK_READY
    service.start_block()
    monkeypatch.setattr(service, "_analyze_block", lambda _block: quality([], "invalid"))
    service._finish_block()
    assert service.blocks[-1]["eligible_for_baseline"] is False
    assert service.blocks[-1]["self_report"] is None
    assert len(service.pending_tasks) == 1
    assert service.pending_tasks[0]["is_redo"] is True
    assert service.machine.state == CalibrationState.BLOCK_READY
    service.shutdown()


def test_completed_valid_baseline_processes_without_self_report(tmp_path, monkeypatch):
    service = ready_service(tmp_path)
    service.machine.state = CalibrationState.BLOCK_READY
    service.start_block()
    values = [1.0] * 25
    monkeypatch.setattr(service, "_analyze_block", lambda _block: quality(values))
    service._finish_block()
    assert service.machine.state == CalibrationState.COMPLETE
    assert service.result is not None
    assert service.result["baseline_available"] is True
    assert service.result["self_reported_focus"] is None
    assert service.result["self_reported_drowsiness"] is None
    service.shutdown()


def test_valid_baseline_generates_v5_median_mad_profile(tmp_path):
    service = ready_service(tmp_path)
    values = [1.0] * 12 + [1.2] * 13
    service.blocks = [completed_block(values)]
    profile = service._process()
    assert profile["baseline_log_tbr"] == pytest.approx(1.2)
    assert profile["baseline_mad"] == pytest.approx(0.0)
    assert profile["effective_baseline_scale"] == pytest.approx(0.05)
    assert profile["valid_epoch_count"] == 25
    assert profile["baseline_available"] is True
    assert profile["feature_version"].endswith("protocol_v5")
    service.shutdown()


def test_second_failed_attempt_finishes_with_unusable_profile(tmp_path):
    service = ready_service(tmp_path)
    service.blocks = [completed_block([], "invalid", "baseline_1"), completed_block([], "invalid", "baseline_2")]
    profile = service._process()
    assert profile["quality_status"] == "fail"
    assert profile["baseline_available"] is False
    assert profile["collection_decision"] == "insufficient_after_redo"
    service.shutdown()


def test_reset_cancels_active_timer(tmp_path):
    service = ready_service(tmp_path)
    service.start_acclimation()
    timer = ManualTimer.instances[0]
    service.reset()
    assert timer.cancelled and service.machine.state == CalibrationState.IDLE
