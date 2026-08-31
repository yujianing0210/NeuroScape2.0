from __future__ import annotations

from app.models.schemas import CalibrationState


class InvalidTransition(ValueError):
    pass


class CalibrationStateMachine:
    _valid = {
        CalibrationState.IDLE: {CalibrationState.CONNECTION_CHECK},
        CalibrationState.CONNECTION_CHECK: {CalibrationState.READY, CalibrationState.IDLE},
        CalibrationState.READY: {CalibrationState.BLOCK_RECORDING, CalibrationState.IDLE},
        CalibrationState.BLOCK_RECORDING: {
            CalibrationState.PROCESSING,
            CalibrationState.IDLE,
        },
        CalibrationState.PROCESSING: {CalibrationState.COMPLETE, CalibrationState.ERROR},
        CalibrationState.COMPLETE: {CalibrationState.IDLE},
        CalibrationState.ERROR: {CalibrationState.IDLE},
    }

    def __init__(self) -> None:
        self.state = CalibrationState.IDLE

    def transition(self, target: CalibrationState) -> None:
        if target not in self._valid[self.state]:
            raise InvalidTransition(f"Cannot transition from {self.state.value} to {target.value}")
        self.state = target

    def reset(self) -> None:
        self.state = CalibrationState.IDLE
