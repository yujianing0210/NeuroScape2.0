from __future__ import annotations

import re
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field, field_validator


class CalibrationState(str, Enum):
    IDLE = "IDLE"
    CONNECTION_CHECK = "CONNECTION_CHECK"
    READY = "READY"
    ACCLIMATION = "ACCLIMATION"
    ACCLIMATION_COMPLETE = "ACCLIMATION_COMPLETE"
    BLOCK_READY = "BLOCK_READY"
    BLOCK_RECORDING = "BLOCK_RECORDING"
    PROCESSING = "PROCESSING"
    COMPLETE = "COMPLETE"
    ERROR = "ERROR"


class SessionCreate(BaseModel):
    participant_id: str = Field(min_length=2, max_length=64)

    @field_validator("participant_id")
    @classmethod
    def normalize(cls, value: str) -> str:
        normalized = value.strip().upper()
        if not re.fullmatch(r"P0*[1-9][0-9]*", normalized):
            raise ValueError("Participant ID must use P followed by a positive integer, for example P001")
        return normalized


class CalibrationStart(BaseModel):
    quality_override: bool = False


class GuidanceEventSubmit(BaseModel):
    event: str
    timing_offset_ms: float | None = None

    @field_validator("event")
    @classmethod
    def validate_event(cls, value: str) -> str:
        allowed = {
            "BASELINE_GUIDANCE_READY",
            "BASELINE_GUIDANCE_PLAYBACK_START",
            "BASELINE_GUIDANCE_PAUSE",
            "BASELINE_GUIDANCE_RESUME",
            "BASELINE_GUIDANCE_ERROR",
            "BASELINE_GUIDANCE_ENDED",
        }
        if value not in allowed:
            raise ValueError("Unsupported baseline guidance event")
        return value


class Marker(BaseModel):
    event: str
    monotonic_timestamp: float
    session_elapsed_seconds: float
    nearest_eeg_sample_index: int | None
    local_timestamp: str
    condition: str | None = None
    block_number: int | None = None
    block_id: str | None = None
    attempt: int | None = None
    completed_automatically: bool | None = None
    reason: str | None = None


class EEGSample(BaseModel):
    sample_index: int
    monotonic_timestamp: float
    session_elapsed_seconds: float | None
    tp9: float
    af7: float
    af8: float
    tp10: float
    aux_right: float | None = None
    headband_on: bool | None = None
    hsi_tp9: int | None = None
    hsi_af7: int | None = None
    hsi_af8: int | None = None
    hsi_tp10: int | None = None
    acc_x: float | None = None
    acc_y: float | None = None
    acc_z: float | None = None
    gyro_x: float | None = None
    gyro_y: float | None = None
    gyro_z: float | None = None
    blink: bool = False
    jaw_clench: bool = False

    def csv_row(self) -> dict[str, Any]:
        return self.model_dump()


class ReplayProcessSubmit(BaseModel):
    samples: list[EEGSample]

    @field_validator("samples")
    @classmethod
    def validate_samples(cls, value: list[EEGSample]) -> list[EEGSample]:
        minimum = 9 * 60 * 256
        maximum = 10 * 60 * 256 + 256
        if len(value) < minimum:
            raise ValueError("Replay EEG is shorter than the required ten-minute recording (minimum accepted: nine minutes)")
        if len(value) > maximum:
            raise ValueError("Replay EEG cannot exceed ten minutes plus one second")
        timestamps = [sample.monotonic_timestamp for sample in value]
        if any(b <= a for a, b in zip(timestamps, timestamps[1:])):
            raise ValueError("Replay EEG timestamps must be strictly increasing")
        return value
