import mimetypes
import csv
import io

from fastapi.testclient import TestClient

from app import config
from app.main import app
from app.models.schemas import EEGSample


def test_calibration_api_surface_omits_retired_self_report():
    paths = app.openapi()["paths"]
    expected = {
        "/api/calibration/acclimation/start",
        "/api/calibration/acclimation/end-early",
        "/api/calibration/acclimation/accept",
        "/api/calibration/acclimation/repeat",
        "/api/calibration/block/start",
        "/api/calibration/block/end-early",
    }
    assert expected <= paths.keys()
    assert "/api/calibration/self-report" not in paths
    assert "/api/calibration/relaxation/start" not in paths
    assert "/api/calibration/focus/start" not in paths


def test_removed_runtime_api_is_not_exposed():
    response = TestClient(app).get("/api/runtime/status")
    assert response.status_code == 404
    assert response.json()["detail"].startswith("API endpoint not found")


def test_javascript_modules_have_browser_compatible_mime_type():
    assert mimetypes.guess_type("frontend-bundle.js")[0] == "application/javascript"
    assets = config.FRONTEND_DIST / "assets"
    if assets.exists():
        bundle = next(assets.glob("*.js"))
        response = TestClient(app).get(f"/assets/{bundle.name}")
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/javascript")


def test_live_raw_csv_rebases_elapsed_time(monkeypatch):
    samples = [
        EEGSample(
            sample_index=index,
            monotonic_timestamp=100.0 + index / 256,
            session_elapsed_seconds=999.0,
            tp9=1,
            af7=2,
            af8=3,
            tp10=4,
        )
        for index in (10, 11)
    ]
    from app import main

    monkeypatch.setattr(main.service, "live_raw_samples", lambda after: samples)
    response = TestClient(app).get("/api/live/raw.csv?after_sample_index=9")
    assert response.status_code == 200
    rows = list(csv.DictReader(io.StringIO(response.text)))
    assert [int(row["sample_index"]) for row in rows] == [10, 11]
    assert float(rows[0]["session_elapsed_seconds"]) == 0.0
    assert float(rows[1]["session_elapsed_seconds"]) == 1 / 256
