"""Private Vercel Python worker for the validated DrapeProof continuity engine."""

from __future__ import annotations

import argparse
import base64
import binascii
import hmac
from http.server import BaseHTTPRequestHandler
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import cv2  # noqa: E402
import mediapipe as mp  # noqa: E402
import numpy as np  # noqa: E402
from scripts.continuity_cv import configure_runtime, features_command, pose_command, sha256_file  # noqa: E402

MODEL_PATH = ROOT / "models" / "continuity" / "pose_landmarker_lite.task"
MODEL_SHA256 = "59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a"
MAX_REQUEST_BYTES = 4_400_000
MAX_IMAGE_BYTES = 3_000_000


def send_json(target: BaseHTTPRequestHandler, status: int, value: dict[str, Any]) -> None:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    target.send_response(status)
    target.send_header("Content-Type", "application/json")
    target.send_header("Content-Length", str(len(encoded)))
    target.send_header("Cache-Control", "private, no-store, max-age=0")
    target.send_header("X-Content-Type-Options", "nosniff")
    target.end_headers()
    target.wfile.write(encoded)


def decode_image(value: object) -> bytes:
    if not isinstance(value, str) or not value:
        raise ValueError("A required verification input was unavailable.")
    try:
        decoded = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError("A verification input was not valid base64.") from error
    if not decoded or len(decoded) > MAX_IMAGE_BYTES:
        raise ValueError("A verification input had an invalid size.")
    return decoded


def scrub_pose(value: dict[str, Any], input_label: str) -> dict[str, Any]:
    value["input"]["path"] = input_label
    value["model"]["path"] = "bundled-pose-model"
    return value


def scrub_features(value: dict[str, Any]) -> dict[str, Any]:
    value["source"]["path"] = "private-source-image"
    value["generated"]["path"] = "private-result-image"
    return value


def compact_artifact(path: Path, name: str) -> dict[str, str]:
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError("A verification visual artifact could not be decoded.")
    height, width = image.shape[:2]
    scale = min(1.0, 640.0 / max(width, height))
    if scale < 1.0:
        image = cv2.resize(image, (round(width * scale), round(height * scale)), interpolation=cv2.INTER_AREA)
    ok, encoded = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 78, cv2.IMWRITE_JPEG_OPTIMIZE, 1])
    if not ok:
        raise RuntimeError("A verification visual artifact could not be encoded.")
    return {"name": name, "media_type": "image/jpeg", "base64": base64.b64encode(encoded.tobytes()).decode("ascii")}


def execute(payload: dict[str, Any]) -> dict[str, Any]:
    if payload.get("schema_version") != "1.0":
        raise ValueError("The verification request schema was invalid.")
    if not MODEL_PATH.is_file() or sha256_file(MODEL_PATH) != MODEL_SHA256:
        raise FileNotFoundError("The bundled pose model is missing or invalid.")
    source_bytes = decode_image(payload.get("source_base64"))
    result_bytes = decode_image(payload.get("result_base64"))
    base = Path(tempfile.gettempdir()) / "drapeproof"
    base.mkdir(parents=True, exist_ok=True)
    workspace = Path(tempfile.mkdtemp(prefix="verify-", dir=base))
    try:
        source_path = workspace / "source-image"
        result_path = workspace / "result-image"
        source_pose_visual = workspace / "pose-source.png"
        result_pose_visual = workspace / "pose-result.png"
        feature_matches_visual = workspace / "feature-matches.png"
        feature_inliers_visual = workspace / "feature-inliers.png"
        source_path.write_bytes(source_bytes)
        result_path.write_bytes(result_bytes)
        configure_runtime()
        source_pose = pose_command(argparse.Namespace(image=str(source_path), model=str(MODEL_PATH), visual=str(source_pose_visual)))
        result_pose = pose_command(argparse.Namespace(image=str(result_path), model=str(MODEL_PATH), visual=str(result_pose_visual)))
        features = features_command(argparse.Namespace(
            source=str(source_path), generated=str(result_path),
            matches_visual=str(feature_matches_visual), inliers_visual=str(feature_inliers_visual),
        ))
        return {
            "ok": True,
            "runtime": {"python": sys.version.split()[0], "opencv": cv2.__version__, "mediapipe": mp.__version__, "numpy": np.__version__},
            "source_pose": scrub_pose(source_pose, "private-source-image"),
            "result_pose": scrub_pose(result_pose, "private-result-image"),
            "features": scrub_features(features),
            "artifacts": [
                compact_artifact(source_pose_visual, "pose-source.jpg"),
                compact_artifact(result_pose_visual, "pose-result.jpg"),
                compact_artifact(feature_matches_visual, "feature-matches.jpg"),
                compact_artifact(feature_inliers_visual, "feature-inliers.jpg"),
            ],
        }
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        expected = os.environ.get("CRON_SECRET", "")
        actual = self.headers.get("Authorization", "")
        if not expected or not hmac.compare_digest(actual, f"Bearer {expected}"):
            self.send_response(404)
            self.send_header("Cache-Control", "private, no-store")
            self.end_headers()
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_REQUEST_BYTES:
            send_json(self, 413, {"ok": False, "failure_code": "VERIFIER_INPUT_UNAVAILABLE", "message": "The verification request size was invalid."})
            return
        try:
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError("The verification request body was invalid.")
            send_json(self, 200, execute(payload))
        except FileNotFoundError:
            send_json(self, 503, {"ok": False, "failure_code": "VERIFIER_ASSET_MISSING", "message": "A required verification asset was unavailable."})
        except (ImportError, OSError):
            send_json(self, 503, {"ok": False, "failure_code": "VERIFIER_RUNTIME_UNAVAILABLE", "message": "The verification runtime was unavailable."})
        except (ValueError, json.JSONDecodeError):
            send_json(self, 422, {"ok": False, "failure_code": "VERIFIER_INPUT_UNAVAILABLE", "message": "The verification inputs could not be processed."})
        except Exception:
            send_json(self, 500, {"ok": False, "failure_code": "VERIFIER_EXECUTION_FAILED", "message": "The verification worker could not complete."})

    def log_message(self, format: str, *args: object) -> None:
        return
