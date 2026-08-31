from __future__ import annotations

import inspect

import numpy as np
import pytest

from app.calibration.service import CalibrationService
from app.models.schemas import CalibrationState
from app.signal_processing import core
from app.signal_processing.core import (
    EpochResult,
    IncompatibleCalibrationProfile,
    analyze_segment,
    baseline_summary,
    band_power,
    channel_log_tbr,
    condition_median,
    create_epochs,
    baseline_mad,
    preprocess,
    validate_calibration_profile,
)
from app.storage.session_store import SessionStore


def epoch(index: int, value: float | None) -> EpochResult:
    return EpochResult(index, value, ["AF7"] if value is not None else [], {}, {}, 1.0, {})


def test_filter_shape_and_finite_values(make_samples):
    values = np.array([sample.af7 for sample in make_samples()])
    output = preprocess(values)
    assert output.shape == values.shape
    assert np.all(np.isfinite(output))


def test_ten_second_epoch_creation(make_samples):
    assert len(create_epochs(make_samples(seconds=21))) == 2


def test_welch_uses_median_and_frequency_bin_sum(monkeypatch):
    received: dict[str, object] = {}

    def fake_welch(values, **kwargs):
        received.update(kwargs)
        return np.array([4.0, 5.0, 6.0]), np.array([1.0, 1.0, 1.0])

    monkeypatch.setattr(core, "welch", fake_welch)
    assert band_power(np.ones(1024), 4.0, 6.0) == pytest.approx(3.0)
    assert received["average"] == "median"


def test_theta_excludes_8_hz_and_beta_includes_30_hz(monkeypatch):
    frequencies = np.arange(0.0, 31.0, 0.5)
    psd = np.zeros_like(frequencies)
    psd[np.where(frequencies == 4.0)] = 1.0
    psd[np.where(frequencies == 7.5)] = 2.0
    psd[np.where(frequencies == 8.0)] = 100.0
    psd[np.where(frequencies == 13.0)] = 3.0
    psd[np.where(frequencies == 30.0)] = 4.0
    psd[np.where(frequencies == 30.5)] = 100.0
    monkeypatch.setattr(core, "welch", lambda values, **kwargs: (frequencies, psd))
    assert band_power(np.ones(1024), 4, 8, include_high=False) == pytest.approx(1.5)
    assert band_power(np.ones(1024), 13, 30, include_high=True) == pytest.approx(3.5)


def test_theta_and_beta_band_extraction():
    time_axis = np.arange(2560) / 256
    theta = np.sin(2 * np.pi * 6 * time_axis)
    beta = np.sin(2 * np.pi * 20 * time_axis)
    assert band_power(theta, 4, 8, include_high=False) > band_power(theta, 13, 30) * 100
    assert band_power(beta, 13, 30) > band_power(beta, 4, 8, include_high=False) * 100


def test_channel_log_tbr_uses_document_bands(monkeypatch):
    calls: list[tuple[float, float, bool]] = []

    def fake_band(values, low, high, fs=256, *, include_high=True):
        calls.append((low, high, include_high))
        return 8.0 if low == 4.0 else 2.0

    monkeypatch.setattr(core, "band_power", fake_band)
    assert channel_log_tbr(np.ones(512)) == pytest.approx(np.log((8.0 + 1e-12) / (2.0 + 1e-12)))
    assert calls == [(4.0, 8.0, False), (13.0, 30.0, True)]


def test_af7_af8_epoch_median(make_samples):
    samples = make_samples()
    time_axis = np.arange(len(samples)) / 256
    af7 = 8 * np.sin(2 * np.pi * 6 * time_axis) + np.sin(2 * np.pi * 20 * time_axis)
    af8 = np.sin(2 * np.pi * 6 * time_axis) + 8 * np.sin(2 * np.pi * 20 * time_axis)
    for index, sample in enumerate(samples):
        sample.af7 = float(af7[index])
        sample.af8 = float(af8[index])
    result = analyze_segment(samples)[0]
    assert len(result.valid_channels) == 2
    assert result.tbr == pytest.approx(float(np.median(list(result.channel_tbr.values()))))
    assert result.theta_power is not None
    assert result.beta_power is not None


def test_single_valid_channel_fallback(make_samples):
    samples = make_samples()
    for sample in samples:
        sample.hsi_af8 = 4
    result = analyze_segment(samples)[0]
    assert result.valid_channels == ["AF7"]
    assert result.tbr == result.channel_tbr["AF7"]


def test_condition_median_uses_only_valid_epochs():
    results = [epoch(0, -1.0), epoch(1, None), epoch(2, 8.0), epoch(3, 2.0)]
    assert condition_median(results) == pytest.approx(2.0)


def test_baseline_summary_uses_median_mad_and_robust_scale():
    values = [1.0, 2.0, 100.0]
    summary = baseline_summary(values)
    assert summary["baseline_log_tbr"] == pytest.approx(2.0)
    assert summary["baseline_mad"] == pytest.approx(baseline_mad(values))
    assert summary["baseline_scale"] == pytest.approx(1.4826)


def test_epoch_quality_record_contains_soft_flags(make_samples):
    record = analyze_segment(make_samples())[0].as_quality_record()
    assert {"valid", "invalid_reasons", "quality_flags", "valid_channels", "packet_completeness", "peak_to_peak_uv", "epoch_tbr"} <= record.keys()


def test_quality_rejects_headband_and_bad_hsi(make_samples):
    result = analyze_segment(make_samples(headband=False, hsi=4))[0]
    assert not result.usable
    assert "headband_off" in result.invalid_reasons["AF7"]
    assert "poor_hsi" in result.invalid_reasons["AF7"]


def test_self_report_cannot_enter_signal_processing_formula():
    parameters = inspect.signature(baseline_summary).parameters
    assert "self_report" not in parameters


def test_incompatible_feature_version_is_rejected():
    with pytest.raises(IncompatibleCalibrationProfile, match="Incompatible calibration profile. Please recalibrate."):
        validate_calibration_profile({"feature_version": "raw_welch_frontal_log_tbr_mean_blink_tolerance_v3"})

