from __future__ import annotations

import os
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.getenv("NEUROSCAPE_DATA_DIR", ROOT_DIR / "data" / "sessions"))
FRONTEND_DIST = ROOT_DIR / "frontend" / "dist"

# UDP accepts packets from Mind Monitor; HTTP remains loopback-only by default.
OSC_HOST = os.getenv("NEUROSCAPE_OSC_HOST", "0.0.0.0")
OSC_PORT = int(os.getenv("NEUROSCAPE_OSC_PORT", "5000"))
HTTP_HOST = os.getenv("NEUROSCAPE_HTTP_HOST", "127.0.0.1")
HTTP_PORT = int(os.getenv("NEUROSCAPE_HTTP_PORT", "8000"))

# Muse 2 raw EEG and calibration parameters.
SAMPLING_RATE_HZ = 256
NOTCH_HZ = 60.0
NOTCH_Q = 30.0
BANDPASS_LOW_HZ = 1.0
BANDPASS_HIGH_HZ = 35.0
FILTER_ORDER = 4
EPOCH_SECONDS = 10
BASELINE_SECONDS = 300
EXPECTED_BASELINE_EPOCHS = 30
MIN_VALID_BASELINE_EPOCHS = 25
MIN_BASELINE_SCALE_LOG_TBR = 0.05  # TBD_PILOT
WELCH_NPERSEG = 512
WELCH_NOVERLAP = 256
EPSILON = 1e-12

# Channel/epoch quality limits. Motion rejection remains disabled by default.
MIN_PACKET_COMPLETENESS = 0.90
MAX_PEAK_TO_PEAK_UV = 150.0
MAX_BAD_HSI_FRACTION = 0.20
BLINK_EXCLUSION_SECONDS = 0.5
JAW_EXCLUSION_SECONDS = 1.0
MOTION_REJECTION_ENABLED = False
WAVEFORM_RATE_HZ = 16
BUFFER_SECONDS = 900
CONNECTION_RECENT_SECONDS = 2.0
