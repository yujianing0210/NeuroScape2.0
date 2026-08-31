from __future__ import annotations

import asyncio
import copy
import threading
import time
from collections import Counter
from datetime import datetime, timezone
from typing import Any, Callable

import numpy as np

from app import config
from app.calibration.machine import CalibrationStateMachine, InvalidTransition
from app.models.schemas import CalibrationState, EEGSample, Marker
from app.osc.receiver import MuseOSCReceiver, local_ipv4
from app.signal_processing.core import (
    FEATURE_VERSION,
    analyze_segment,
    baseline_summary,
    preprocess,
    validate_calibration_profile,
)
from app.storage.session_store import SessionStore

GUIDED_BASELINE = "guided_breathing_baseline"
GUIDED_BASELINE_LABEL = "Guided Breathing Baseline"


class CalibrationService:
    def __init__(
        self,
        store: SessionStore | None = None,
        receiver: MuseOSCReceiver | None = None,
        timer_factory: Callable[[float, Callable[[], None]], Any] = threading.Timer,
    ) -> None:
        self.store = store or SessionStore()
        self.receiver = receiver or MuseOSCReceiver()
        self.receiver.osc_callback = self._record_osc
        self.receiver.eeg_callback = self._record_eeg
        self.machine = CalibrationStateMachine()
        self.metadata: dict[str, Any] | None = None
        self.markers: list[Marker] = []
        self.result: dict[str, Any] | None = None
        self.quality: dict[str, Any] | None = None
        self.processing_stage: str | None = None
        self.original_schedule: list[dict[str, Any]] = []
        self.pending_tasks: list[dict[str, Any]] = []
        self.blocks: list[dict[str, Any]] = []
        self.current_block: dict[str, Any] | None = None
        self.collection_decision = "not_started"
        self._timer_factory = timer_factory
        self._active_timer: Any | None = None
        self._phase_lock = threading.RLock()

    def start_services(self) -> None:
        self.receiver.start()

    def shutdown(self) -> None:
        self._cancel_timer()
        self.receiver.stop()
        self.store.close()

    def _cancel_timer(self) -> None:
        with self._phase_lock:
            if self._active_timer is not None:
                self._active_timer.cancel()
            self._active_timer = None

    def _schedule(self, duration: float, callback: Callable[[], None]) -> Any:
        timer = self._timer_factory(duration, callback)
        timer.daemon = True
        timer.start()
        return timer

    def _record_osc(self, record: dict) -> None:
        if self.store.writer:
            self.store.writer.put_osc(record)

    def _record_eeg(self, sample: EEGSample) -> None:
        if self.store.writer:
            self.store.writer.put_eeg(sample)

    @staticmethod
    def _baseline_task() -> dict[str, Any]:
        return {
            "task_id": GUIDED_BASELINE,
            "sequence_number": 1,
            "condition": GUIDED_BASELINE,
            "condition_label": GUIDED_BASELINE_LABEL,
            "condition_block_number": 1,
            "is_redo": False,
            "redo_of_block_id": None,
            "redo_reason": None,
        }

    def create_session(self, participant_id: str) -> dict:
        if self.machine.state != CalibrationState.IDLE:
            raise InvalidTransition("Reset the current session before creating another")
        self._cancel_timer()
        started = time.monotonic()
        self.receiver.set_session_start(started)
        self.metadata = self.store.create(participant_id, local_ipv4())
        self.metadata.update(
            {
                "session_monotonic_start": started,
                "protocol_version": FEATURE_VERSION,
            }
        )
        self.store.update_metadata(
            session_monotonic_start=started,
            protocol_version=FEATURE_VERSION,
        )
        self.markers = []
        self.result = None
        self.quality = None
        self.processing_stage = None
        self.original_schedule = [self._baseline_task()]
        self.pending_tasks = copy.deepcopy(self.original_schedule)
        self.blocks = []
        self.current_block = None
        self.collection_decision = "not_started"
        self.machine.transition(CalibrationState.CONNECTION_CHECK)
        self._persist_protocol()
        return self.metadata

    async def connection_test(self, duration: float = 10.0) -> dict:
        if self.machine.state not in (CalibrationState.CONNECTION_CHECK, CalibrationState.READY):
            raise InvalidTransition("Create a session before testing the connection")
        start_index = self.receiver.total_eeg_samples
        start_time = time.monotonic()
        await asyncio.sleep(duration)
        samples = self.receiver.snapshot_samples(start_index)
        elapsed = time.monotonic() - start_time
        count = len(samples)
        rate = count / elapsed if elapsed else 0.0
        ranges = {}
        for label, channel in (("AF7", "af7"), ("AF8", "af8")):
            values = [getattr(sample, channel) for sample in samples]
            ranges[label] = [float(np.min(values)), float(np.max(values))] if values else None
        filter_ok = False
        if len(samples) >= 32:
            try:
                filter_ok = all(
                    np.all(np.isfinite(preprocess(np.array([getattr(sample, channel) for sample in samples]))))
                    for channel in ("af7", "af8")
                )
            except ValueError:
                pass
        status = self.receiver.status()
        completeness = min(1.0, count / (duration * config.SAMPLING_RATE_HZ))
        ready = bool(
            count
            and status["headband_on"] is True
            and filter_ok
            and status["real_data_seconds"] >= 10.0
        )
        if ready and self.machine.state == CalibrationState.CONNECTION_CHECK:
            self.machine.transition(CalibrationState.READY)
        result = {
            "duration_seconds": elapsed,
            "sample_count": count,
            "estimated_sample_rate_hz": rate,
            "packet_completeness": completeness,
            "ranges_microvolts": ranges,
            "headband_on": status["headband_on"],
            "hsi": status["hsi"],
            "filter_success": filter_ok,
            "ready": ready,
            "message": (
                "Connection verified with real EEG."
                if ready
                else "Requirements not met; check streaming, fit, and sample rate."
            ),
        }
        self.store.update_metadata(last_connection_test=result)
        return result

    def _marker(self, event: str, **context: Any) -> Marker:
        now = time.monotonic()
        marker = Marker(
            event=event,
            monotonic_timestamp=now,
            session_elapsed_seconds=self.receiver.elapsed(now) or 0.0,
            nearest_eeg_sample_index=self.receiver.nearest_sample_index(now),
            local_timestamp=datetime.now(timezone.utc).isoformat(),
            **context,
        )
        self.markers.append(marker)
        if self.store.writer:
            self.store.writer.put_marker(marker)
        return marker

    def _validate_recording_signal(self, quality_override: bool) -> list[str]:
        status = self.receiver.status()
        if not status["connected"] or status["headband_on"] is not True or status["real_data_seconds"] < 10:
            raise ValueError("Real EEG must be arriving with HeadBandOn for at least 10 seconds")
        poor = [name for name in ("AF7", "AF8") if status["hsi"].get(name) == 4]
        if poor and not quality_override:
            raise ValueError(f"Poor contact on {', '.join(poor)}; explicit quality_override is required")
        return poor

    def _record_quality_override(self, quality_override: bool, poor: list[str]) -> None:
        if self.metadata is None:
            return
        existing_channels = set(self.metadata.get("poor_hsi_override_channels", []))
        existing_channels.update(poor)
        enabled = bool(self.metadata.get("researcher_quality_override", False) or quality_override)
        self.metadata["researcher_quality_override"] = enabled
        self.metadata["poor_hsi_override_channels"] = sorted(existing_channels)
        self.store.update_metadata(
            researcher_quality_override=enabled,
            poor_hsi_override_channels=sorted(existing_channels),
        )

    def start_block(self, quality_override: bool = False) -> Marker:
        with self._phase_lock:
            if self.machine.state != CalibrationState.READY or not self.pending_tasks:
                raise InvalidTransition("The single calibration session is not ready to start")
            poor = self._validate_recording_signal(quality_override)
            self._record_quality_override(quality_override, poor)
            task = self.pending_tasks.pop(0)
            block_id = f"baseline_{len(self.blocks) + 1}"
            self.machine.transition(CalibrationState.BLOCK_RECORDING)
            blink_event_start_count = int(self.receiver.status().get("blink_events_session", 0))
            marker = self._marker(
                "BASELINE_START",
                condition=task["condition"],
                block_number=task["condition_block_number"],
                block_id=block_id,
            )
            self.current_block = {
                **task,
                "block_id": block_id,
                "actual_sequence_number": len(self.blocks) + 1,
                "start_marker": marker.model_dump(),
                "blink_event_start_count": blink_event_start_count,
                "blink_event_count": None,
                "end_marker": None,
                "duration_seconds": None,
                "completed_automatically": None,
                "self_report": None,
                "eeg_quality": None,
                "included_in_baseline": False,
            }
            self._active_timer = self._schedule(config.BASELINE_SECONDS, self._finish_block)
            self._persist_protocol()
            return marker

    def _finish_block(self, automatic: bool = True) -> Marker | None:
        with self._phase_lock:
            if self.machine.state != CalibrationState.BLOCK_RECORDING or self.current_block is None:
                return None
            if not automatic and self._active_timer is not None:
                self._active_timer.cancel()
            self._active_timer = None
            block = self.current_block
            marker = self._marker(
                "BASELINE_END",
                condition=block["condition"],
                block_number=block["condition_block_number"],
                block_id=block["block_id"],
                completed_automatically=automatic,
                reason=None if automatic else "ended_early",
            )
            block["end_marker"] = marker.model_dump()
            block["completed_automatically"] = automatic
            blink_event_end_count = int(self.receiver.status().get("blink_events_session", 0))
            block["blink_event_count"] = max(
                0, blink_event_end_count - block["blink_event_start_count"]
            )
            block["duration_seconds"] = (
                marker.monotonic_timestamp - block["start_marker"]["monotonic_timestamp"]
            )
            block["eeg_quality"] = self._analyze_block(block)
            block["eligible_for_baseline"] = block["eeg_quality"]["status"] == "pass"
            self._marker(
                "BASELINE_ANALYZED",
                condition=block["condition"],
                block_number=block["condition_block_number"],
                block_id=block["block_id"],
            )
            self.blocks.append(block)
            self.current_block = None
            self._advance_after_block()
            self._persist_protocol()
            return marker

    def end_block_early(self) -> Marker:
        marker = self._finish_block(False)
        if marker is None:
            raise InvalidTransition("No calibration block is recording")
        return marker

    def record_guidance_event(
        self, event: str, timing_offset_ms: float | None = None
    ) -> dict[str, Any]:
        marker = self._marker(event)
        return {
            **marker.model_dump(),
            "timing_offset_ms": timing_offset_ms,
        }

    def _analyze_block(self, block: dict[str, Any]) -> dict[str, Any]:
        start_index = block["start_marker"].get("nearest_eeg_sample_index")
        end_index = block["end_marker"].get("nearest_eeg_sample_index") if block["end_marker"] else None
        if start_index is None or end_index is None:
            return {
                "status": "invalid",
                "reasons": ["markers_not_aligned"],
                "expected_epochs": config.EXPECTED_BASELINE_EPOCHS,
                "total_epochs": 0,
                "valid_epochs": 0,
                "invalid_epochs": 0,
                "blink_epochs": 0,
                "packet_completeness": 0.0,
                "rejection_counts": {},
                "channel_contributions": {},
                "epoch_tbrs": [],
                "epoch_details": [],
            }
        raw = self.receiver.snapshot_samples(int(start_index), int(end_index))
        epochs = analyze_segment(raw)
        valid_epochs = sum(epoch.usable for epoch in epochs)
        blink_epochs = sum("blink_overlap" in epoch.quality_flags for epoch in epochs)
        reasons = []
        if not block["completed_automatically"]:
            reasons.append("incomplete_duration")
        if valid_epochs < config.MIN_VALID_BASELINE_EPOCHS:
            reasons.append("fewer_than_25_valid_epochs")
        completeness = float(np.mean([epoch.packet_completeness for epoch in epochs])) if epochs else 0.0
        return {
            "status": "pass" if not reasons else "invalid",
            "reasons": reasons,
            "expected_epochs": config.EXPECTED_BASELINE_EPOCHS,
            "total_epochs": len(epochs),
            "valid_epochs": valid_epochs,
            "invalid_epochs": len(epochs) - valid_epochs,
            "blink_epochs": blink_epochs,
            "packet_completeness": completeness,
            "raw_duration_seconds": len(raw) / config.SAMPLING_RATE_HZ,
            "discarded_initial_seconds": 0,
            "rejection_counts": dict(
                Counter(
                    reason
                    for epoch in epochs
                    for channel_reasons in epoch.invalid_reasons.values()
                    for reason in channel_reasons
                )
            ),
            "channel_contributions": dict(
                Counter(channel for epoch in epochs for channel in epoch.valid_channels)
            ),
            "epoch_tbrs": [epoch.tbr for epoch in epochs],
            "epoch_details": [epoch.as_quality_record() for epoch in epochs],
        }

    def _baseline_evaluation(self) -> dict[str, Any]:
        selected = self.blocks[-1:] if self.blocks else []
        for block in self.blocks:
            block["included_in_baseline"] = block in selected
        block = selected[0] if selected else None
        quality = block.get("eeg_quality") if block else None
        issues = list(quality.get("reasons", [])) if quality else ["no_baseline_attempt"]
        return {
            "status": "pass" if quality and quality["status"] == "pass" else "insufficient",
            "issues": issues,
            "selected_baseline_id": block["block_id"] if block else None,
            "total_epochs": quality["total_epochs"] if quality else 0,
            "valid_epochs": quality["valid_epochs"] if quality else 0,
            "invalid_epochs": quality["invalid_epochs"] if quality else 0,
            "blink_epochs": quality["blink_epochs"] if quality else 0,
            "epoch_tbrs": [value for value in (quality["epoch_tbrs"] if quality else []) if value is not None],
            "rejection_counts": quality["rejection_counts"] if quality else {},
            "channel_contributions": quality["channel_contributions"] if quality else {},
        }

    def _advance_after_block(self) -> None:
        self.machine.transition(CalibrationState.PROCESSING)
        try:
            self._process()
            self.machine.transition(CalibrationState.COMPLETE)
            self.processing_stage = "complete"
        except Exception as exc:
            self.machine.transition(CalibrationState.ERROR)
            self.processing_stage = "error"
            self.store.update_metadata(processing_error=str(exc))

    def _process(self) -> dict[str, Any]:
        self.processing_stage = "baseline_quality"
        evaluation = self._baseline_evaluation()
        collection_ready = evaluation["status"] == "pass"
        self.collection_decision = (
            "ready_to_continue" if collection_ready else "insufficient_single_session"
        )
        self.processing_stage = "baseline_calculation"
        summary = baseline_summary(evaluation["epoch_tbrs"])
        baseline_present = summary["baseline_log_tbr"] is not None
        quality_issues = list(evaluation["issues"])
        selected_blocks = [block for block in self.blocks if block["included_in_baseline"]]
        all_selected_epochs = [
            epoch
            for block in selected_blocks
            for epoch in block["eeg_quality"]["epoch_details"]
        ]
        packet_completeness = (
            float(np.mean([epoch["packet_completeness"] for epoch in all_selected_epochs]))
            if all_selected_epochs
            else 0.0
        )
        possible_channels = len(all_selected_epochs) * 2
        valid_channels = sum(len(epoch["valid_channels"]) for epoch in all_selected_epochs)
        metadata = self.metadata or {}
        quality = {
            "status": "valid_collection" if collection_ready else "insufficient_quality",
            "collection_decision": self.collection_decision,
            "quality_issues": quality_issues,
            "packet_completeness": packet_completeness,
            "valid_frontal_fraction": valid_channels / possible_channels if possible_channels else 0.0,
            "researcher_quality_override": bool(metadata.get("researcher_quality_override", False)),
            "peak_to_peak_threshold_uv": config.MAX_PEAK_TO_PEAK_UV,
            "baseline_policy": {
                "duration_seconds": config.BASELINE_SECONDS,
                "expected_epochs": config.EXPECTED_BASELINE_EPOCHS,
                "minimum_valid_epochs": config.MIN_VALID_BASELINE_EPOCHS,
                "maximum_redos": 0,
                "aggregation": "valid_epoch_median",
            },
            "baseline_summary": evaluation,
            "blocks": copy.deepcopy(self.blocks),
        }
        self.processing_stage = "profile_generation"
        profile = {
            "participant_id": metadata.get("participant_id"),
            "session_id": metadata.get("session_id"),
            "sampling_rate_hz": config.SAMPLING_RATE_HZ,
            "feature_version": FEATURE_VERSION,
            **summary,
            "effective_baseline_scale": max(
                summary["baseline_scale"] or 0.0,
                config.MIN_BASELINE_SCALE_LOG_TBR,
            ),
            "expected_epoch_count": config.EXPECTED_BASELINE_EPOCHS,
            "valid_epoch_count": evaluation["valid_epochs"],
            "invalid_epoch_count": evaluation["invalid_epochs"],
            "collection_decision": self.collection_decision,
            "ready_to_continue": collection_ready,
            "baseline_available": collection_ready and baseline_present,
            "quality_status": "pass" if collection_ready else "fail",
            "quality_issues": quality_issues,
            "self_reported_focus": None,
            "self_reported_drowsiness": None,
            "selected_baseline_id": evaluation["selected_baseline_id"],
            "blocks": copy.deepcopy(self.blocks),
            "quality": {
                key: value
                for key, value in quality.items()
                if key != "blocks"
            },
        }
        validate_calibration_profile(profile)
        self.result = profile
        self.quality = quality
        self.store.write_json("calibration_profile.json", profile)
        self.store.write_json("quality_report.json", quality)
        self.store.update_metadata(
            completed_at=datetime.now(timezone.utc).isoformat(),
            feature_version=FEATURE_VERSION,
            collection_decision=self.collection_decision,
            baseline_available=collection_ready and baseline_present,
        )
        if self.store.writer:
            self.store.writer.flush()
        self._persist_protocol()
        return profile

    def _quality_snapshot(self) -> dict[str, Any]:
        status = self.receiver.status()
        return {
            "connected": status["connected"],
            "headband_on": status["headband_on"],
            "hsi": status["hsi"],
            "packet_completeness": status["packet_completeness"],
            "estimated_sample_rate_hz": status["estimated_sample_rate_hz"],
        }

    def _protocol_payload(self, include_epoch_details: bool = True) -> dict[str, Any]:
        blocks = copy.deepcopy(self.blocks)
        if not include_epoch_details:
            for block in blocks:
                if block.get("eeg_quality"):
                    block["eeg_quality"].pop("epoch_details", None)
        current = copy.deepcopy(self.current_block)
        if current and not include_epoch_details and current.get("eeg_quality"):
            current["eeg_quality"].pop("epoch_details", None)
        return {
            "original_schedule": copy.deepcopy(self.original_schedule),
            "pending_tasks": copy.deepcopy(self.pending_tasks),
            "next_block": copy.deepcopy(self.pending_tasks[0]) if self.pending_tasks else None,
            "current_block": current,
            "completed_blocks": blocks,
            "collection_decision": self.collection_decision,
        }

    def _persist_protocol(self) -> None:
        if self.store.session_dir:
            self.store.write_json("calibration_record.json", self._protocol_payload(True))

    def calibration_result(self) -> dict:
        if self.result is None:
            raise FileNotFoundError("No calibration result is available")
        return validate_calibration_profile(self.result)

    def start_live_session(self) -> dict:
        profile = self.calibration_result()
        return self._live_session_start(profile)

    def start_saved_live_session(self, session_id: str) -> dict:
        details = self.store.details(session_id)
        profile = details.get("profile")
        if profile is None:
            raise FileNotFoundError("No calibration profile is available for this session")
        return self._live_session_start(validate_calibration_profile(profile))

    def _live_session_start(self, profile: dict) -> dict:
        if not profile.get("ready_to_continue"):
            raise ValueError("Calibration quality is insufficient for an adaptive session")
        if not self.receiver.status()["connected"]:
            raise ValueError("Muse EEG is not streaming; realtime cannot start")
        samples = self.receiver.snapshot_samples()
        return {
            "after_sample_index": samples[-1].sample_index if samples else -1,
            "sampling_rate_hz": config.SAMPLING_RATE_HZ,
            "epoch_seconds": config.EPOCH_SECONDS,
        }

    def start_raw_live_recording(self) -> dict:
        status = self.receiver.status()
        if not status["connected"]:
            raise ValueError("Muse EEG is not streaming; raw recording cannot start")
        samples = self.receiver.snapshot_samples()
        return {
            "after_sample_index": samples[-1].sample_index if samples else -1,
            "sampling_rate_hz": config.SAMPLING_RATE_HZ,
        }

    def live_raw_samples(self, after_sample_index: int) -> list[EEGSample]:
        return self.receiver.snapshot_samples(start_index=after_sample_index + 1)

    def live_epoch(self, after_sample_index: int) -> dict:
        epoch_size = config.SAMPLING_RATE_HZ * config.EPOCH_SECONDS
        samples = self.receiver.snapshot_samples(start_index=after_sample_index + 1)
        if len(samples) < epoch_size:
            return {
                "ready": False,
                "available_samples": len(samples),
                "required_samples": epoch_size,
            }
        segment = samples[:epoch_size]
        result = analyze_segment(segment)[0]
        flags = list(result.quality_flags)
        for channel, reasons in result.invalid_reasons.items():
            flags.extend(f"{channel.lower()}:{reason}" for reason in reasons)
        return {
            "ready": True,
            "start_sample_index": segment[0].sample_index,
            "end_sample_index": segment[-1].sample_index,
            "log_tbr": result.tbr,
            "theta": result.theta_power,
            "beta": result.beta_power,
            "valid": result.usable,
            "quality_score": result.packet_completeness
            * (len(result.valid_channels) / 2),
            "artifact_flags": flags,
            "valid_channels": result.valid_channels,
            "packet_completeness": result.packet_completeness,
        }

    def process_replay_samples(self, samples: list[EEGSample]) -> dict:
        """Run uploaded samples through the production epoch pipeline unchanged."""
        first_timestamp = samples[0].monotonic_timestamp
        epochs = analyze_segment(samples)
        return {
            "duration_seconds": samples[-1].monotonic_timestamp - first_timestamp,
            "sampling_rate_hz": config.SAMPLING_RATE_HZ,
            "epoch_seconds": config.EPOCH_SECONDS,
            "epochs": [
                {
                    "timestamp_ms": (epoch.epoch_index + 1) * config.EPOCH_SECONDS * 1000,
                    "theta": epoch.theta_power,
                    "beta": epoch.beta_power,
                    "log_tbr": epoch.tbr,
                    "valid": epoch.usable,
                    "quality_score": epoch.packet_completeness
                    * (len(epoch.valid_channels) / 2),
                    "artifact_flags": [
                        *epoch.quality_flags,
                        *[
                            f"{channel.lower()}:{reason}"
                            for channel, reasons in epoch.invalid_reasons.items()
                            for reason in reasons
                        ],
                    ],
                }
                for epoch in epochs
            ],
        }

    def reset(self) -> None:
        self._cancel_timer()
        with self._phase_lock:
            self.machine.reset()
            self.receiver.set_session_start(None)
            self.store.close()
            self.metadata = None
            self.markers = []
            self.result = None
            self.quality = None
            self.processing_stage = None
            self.original_schedule = []
            self.pending_tasks = []
            self.blocks = []
            self.current_block = None
            self.collection_decision = "not_started"

    def status(self, include_waveform: bool = True) -> dict:
        receiver = self.receiver.status()
        waveform = receiver.pop("waveform")
        with self._phase_lock:
            markers = list(self.markers)
            active_start = None
            active_duration = 0.0
            if self.machine.state == CalibrationState.BLOCK_RECORDING and self.current_block:
                active_start = self.current_block["start_marker"]["monotonic_timestamp"]
                active_duration = float(config.BASELINE_SECONDS)
            elapsed = max(0.0, time.monotonic() - active_start) if active_start else 0.0
            timing = {
                "baseline_duration_seconds": float(config.BASELINE_SECONDS),
                "active_elapsed_seconds": min(active_duration, elapsed),
                "active_remaining_seconds": max(0.0, active_duration - elapsed),
                "total_recorded_seconds": sum(
                    float(block.get("duration_seconds") or 0.0) for block in self.blocks
                ),
            }
            protocol = self._protocol_payload(False)
            session_blink_events = int(receiver.get("blink_events_session", 0))
            blink_event_count: int | None = None
            blink_event_label: str | None = None
            if self.current_block is not None:
                stored_count = self.current_block.get("blink_event_count")
                blink_event_count = (
                    max(0, session_blink_events - self.current_block["blink_event_start_count"])
                    if stored_count is None
                    else int(stored_count)
                )
                blink_event_label = self.current_block["condition_label"]
            elif self.blocks:
                latest_block = self.blocks[-1]
                blink_event_count = int(latest_block.get("blink_event_count") or 0)
                blink_event_label = latest_block["condition_label"]
            receiver["blink_events_current_or_last_recording"] = blink_event_count
            receiver["blink_events_current_or_last_label"] = blink_event_label
        result = {
            "state": self.machine.state.value,
            "session": self.metadata,
            "connection": receiver,
            "local_ipv4": local_ipv4(),
            "osc_port": config.OSC_PORT,
            "markers": [marker.model_dump() for marker in markers],
            "timing": timing,
            "protocol": protocol,
            "processing_stage": self.processing_stage,
        }
        if include_waveform:
            result["waveform"] = waveform
        return result
