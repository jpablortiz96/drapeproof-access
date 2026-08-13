"""Deterministic local CV worker for pose and feature continuity evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any

import cv2
import mediapipe as mp
import numpy as np


LANDMARK_NAMES = [
    "nose", "left-eye-inner", "left-eye", "left-eye-outer", "right-eye-inner", "right-eye",
    "right-eye-outer", "left-ear", "right-ear", "mouth-left", "mouth-right", "left-shoulder",
    "right-shoulder", "left-elbow", "right-elbow", "left-wrist", "right-wrist", "left-pinky",
    "right-pinky", "left-index", "right-index", "left-thumb", "right-thumb", "left-hip",
    "right-hip", "left-knee", "right-knee", "left-ankle", "right-ankle", "left-heel",
    "right-heel", "left-foot-index", "right-foot-index",
]

CRITICAL_INDICES = {11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28}
POSE_CONNECTIONS = [
    (11, 12), (11, 13), (13, 15), (12, 14), (14, 16), (11, 23), (12, 24), (23, 24),
    (23, 25), (25, 27), (24, 26), (26, 28), (27, 29), (29, 31), (28, 30), (30, 32),
]

ORB_CONFIG = {
    "nfeatures": 2000,
    "scaleFactor": 1.2,
    "nlevels": 8,
    "edgeThreshold": 31,
    "firstLevel": 0,
    "WTA_K": 2,
    "scoreType": "HARRIS_SCORE",
    "patchSize": 31,
    "fastThreshold": 20,
}
FEATURE_CONFIG = {
    "grayscale": "OpenCV BGR-to-gray decoder",
    "maximum_long_side": 1024,
    "resize_interpolation": "INTER_AREA",
    "matcher": "BFMatcher NORM_HAMMING crossCheck=false",
    "knn_k": 2,
    "lowe_ratio": 0.75,
    "ransac_reprojection_threshold_pixels": 3.0,
    "ransac_max_iterations": 2000,
    "ransac_confidence": 0.995,
    "visualization_match_limit": 80,
}


def configure_runtime() -> None:
    cv2.setNumThreads(1)
    cv2.setRNGSeed(0)
    cv2.ocl.setUseOpenCL(False)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def scalar(value: Any) -> float | None:
    if value is None:
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def write_png(path: Path, image: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(path), image, [cv2.IMWRITE_PNG_COMPRESSION, 9]):
        raise RuntimeError(f"Could not write visual artifact: {path}")


def draw_pose(image: np.ndarray, landmarks: list[dict[str, Any]], output: Path) -> None:
    canvas = image.copy()
    height, width = canvas.shape[:2]
    if not landmarks:
        cv2.rectangle(canvas, (0, 0), (width, 54), (13, 23, 31), -1)
        cv2.putText(canvas, "NO POSE DETECTED", (18, 36), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (60, 69, 255), 2, cv2.LINE_AA)
        write_png(output, canvas)
        return

    def point(index: int) -> tuple[int, int]:
        landmark = landmarks[index]
        return (round(float(landmark["x"]) * (width - 1)), round(float(landmark["y"]) * (height - 1)))

    for first, second in POSE_CONNECTIONS:
        a, b = landmarks[first], landmarks[second]
        if min(float(a.get("visibility") or 0), float(b.get("visibility") or 0)) >= 0.2:
            cv2.line(canvas, point(first), point(second), (255, 229, 0), max(2, width // 400), cv2.LINE_AA)
    for index in sorted(CRITICAL_INDICES):
        item = landmarks[index]
        available = float(item.get("visibility") or 0) >= 0.5 and float(item.get("presence") or 0) >= 0.5
        cv2.circle(canvas, point(index), max(4, width // 180), (88, 210, 49) if available else (60, 69, 255), -1, cv2.LINE_AA)
    cv2.rectangle(canvas, (0, 0), (width, 54), (13, 23, 31), -1)
    cv2.putText(canvas, "MEDIAPIPE POSE - GEOMETRY ONLY", (18, 36), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2, cv2.LINE_AA)
    write_png(output, canvas)


def pose_command(args: argparse.Namespace) -> dict[str, Any]:
    image_path = Path(args.image).resolve()
    model_path = Path(args.model).resolve()
    bgr = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if bgr is None:
        raise ValueError(f"Could not decode image: {image_path}")
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    base_options = mp.tasks.BaseOptions(model_asset_path=str(model_path))
    options = mp.tasks.vision.PoseLandmarkerOptions(
        base_options=base_options,
        running_mode=mp.tasks.vision.RunningMode.IMAGE,
        num_poses=1,
        min_pose_detection_confidence=0.5,
        min_pose_presence_confidence=0.5,
        min_tracking_confidence=0.5,
        output_segmentation_masks=False,
    )
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))
    with mp.tasks.vision.PoseLandmarker.create_from_options(options) as detector:
        result = detector.detect(mp_image)
    landmarks: list[dict[str, Any]] = []
    if result.pose_landmarks:
        for index, item in enumerate(result.pose_landmarks[0]):
            landmarks.append({
                "index": index,
                "name": LANDMARK_NAMES[index],
                "x": scalar(item.x),
                "y": scalar(item.y),
                "z": scalar(item.z),
                "visibility": scalar(getattr(item, "visibility", None)),
                "presence": scalar(getattr(item, "presence", None)),
            })
    draw_pose(bgr, landmarks, Path(args.visual).resolve())
    return {
        "schema_version": "1.0",
        "implementation": "MediaPipe Pose Landmarker",
        "dependency_version": mp.__version__,
        "model": {
            "name": "Pose landmarker (lite), float16, bundle version 1",
            "path": str(model_path),
            "sha256": sha256_file(model_path),
            "source": "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
        },
        "inference": {
            "running_mode": "IMAGE",
            "num_poses": 1,
            "min_pose_detection_confidence": 0.5,
            "min_pose_presence_confidence": 0.5,
            "min_tracking_confidence": 0.5,
            "output_segmentation_masks": False,
            "input_preprocessing": "OpenCV decode, BGR-to-SRGB, no application resize/crop; MediaPipe documented internal rotation/resizing/normalization/color conversion",
        },
        "input": {
            "path": str(image_path),
            "sha256": sha256_file(image_path),
            "width": int(bgr.shape[1]),
            "height": int(bgr.shape[0]),
        },
        "landmark_schema": "MediaPipe Pose 33 normalized image landmarks",
        "poses_detected": 1 if landmarks else 0,
        "landmarks": landmarks,
    }


def resized_gray(path: Path) -> tuple[np.ndarray, dict[str, Any]]:
    original = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if original is None:
        raise ValueError(f"Could not decode image: {path}")
    height, width = original.shape[:2]
    scale = min(1.0, FEATURE_CONFIG["maximum_long_side"] / max(width, height))
    work_width, work_height = round(width * scale), round(height * scale)
    work = cv2.resize(original, (work_width, work_height), interpolation=cv2.INTER_AREA) if scale < 1 else original
    return work, {"width": width, "height": height, "working_width": work_width, "working_height": work_height, "scale": scale}


def normalize_homography(h_work: np.ndarray, source_meta: dict[str, Any], generated_meta: dict[str, Any]) -> tuple[np.ndarray, np.ndarray]:
    source_scale = np.diag([source_meta["scale"], source_meta["scale"], 1.0])
    generated_scale_inv = np.diag([1.0 / generated_meta["scale"], 1.0 / generated_meta["scale"], 1.0])
    h_full = generated_scale_inv @ h_work @ source_scale
    source_pixels = np.diag([max(1, source_meta["width"] - 1), max(1, source_meta["height"] - 1), 1.0])
    generated_normalizer = np.diag([1.0 / max(1, generated_meta["width"] - 1), 1.0 / max(1, generated_meta["height"] - 1), 1.0])
    h_normalized = generated_normalizer @ h_full @ source_pixels
    if h_full[2, 2] != 0:
        h_full = h_full / h_full[2, 2]
    if h_normalized[2, 2] != 0:
        h_normalized = h_normalized / h_normalized[2, 2]
    return h_full, h_normalized


def match_visual(source: np.ndarray, generated: np.ndarray, kp_source: Any, kp_generated: Any, matches: list[Any], path: Path, label: str) -> None:
    selected = sorted(matches, key=lambda match: (match.distance, match.queryIdx, match.trainIdx))[: FEATURE_CONFIG["visualization_match_limit"]]
    canvas = cv2.drawMatches(source, kp_source, generated, kp_generated, selected, None, flags=cv2.DrawMatchesFlags_NOT_DRAW_SINGLE_POINTS)
    cv2.rectangle(canvas, (0, 0), (canvas.shape[1], 48), (13, 23, 31), -1)
    cv2.putText(canvas, label, (16, 33), cv2.FONT_HERSHEY_SIMPLEX, 0.75, (255, 255, 255), 2, cv2.LINE_AA)
    write_png(path, canvas)


def features_command(args: argparse.Namespace) -> dict[str, Any]:
    source_path = Path(args.source).resolve()
    generated_path = Path(args.generated).resolve()
    source, source_meta = resized_gray(source_path)
    generated, generated_meta = resized_gray(generated_path)
    orb = cv2.ORB_create(
        nfeatures=ORB_CONFIG["nfeatures"], scaleFactor=ORB_CONFIG["scaleFactor"], nlevels=ORB_CONFIG["nlevels"],
        edgeThreshold=ORB_CONFIG["edgeThreshold"], firstLevel=ORB_CONFIG["firstLevel"], WTA_K=ORB_CONFIG["WTA_K"],
        scoreType=cv2.ORB_HARRIS_SCORE, patchSize=ORB_CONFIG["patchSize"], fastThreshold=ORB_CONFIG["fastThreshold"],
    )
    kp_source, desc_source = orb.detectAndCompute(source, None)
    kp_generated, desc_generated = orb.detectAndCompute(generated, None)
    knn: list[Any] = []
    if desc_source is not None and desc_generated is not None:
        knn = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=False).knnMatch(desc_source, desc_generated, k=2)
    retained = [pair[0] for pair in knn if len(pair) == 2 and pair[0].distance < FEATURE_CONFIG["lowe_ratio"] * pair[1].distance]
    h_work = None
    inlier_mask: list[bool] = []
    reprojection_errors: list[float] = []
    if len(retained) >= 4:
        source_points = np.float32([kp_source[item.queryIdx].pt for item in retained]).reshape(-1, 1, 2)
        generated_points = np.float32([kp_generated[item.trainIdx].pt for item in retained]).reshape(-1, 1, 2)
        h_work, mask = cv2.findHomography(
            source_points, generated_points, cv2.RANSAC,
            FEATURE_CONFIG["ransac_reprojection_threshold_pixels"],
            maxIters=FEATURE_CONFIG["ransac_max_iterations"], confidence=FEATURE_CONFIG["ransac_confidence"],
        )
        if h_work is not None and mask is not None:
            inlier_mask = [bool(value) for value in mask.ravel().tolist()]
            projected = cv2.perspectiveTransform(source_points, h_work)
            distances = np.linalg.norm(projected.reshape(-1, 2) - generated_points.reshape(-1, 2), axis=1)
            reprojection_errors = [float(error) for error, is_inlier in zip(distances, inlier_mask) if is_inlier]
    inlier_matches = [match for match, is_inlier in zip(retained, inlier_mask) if is_inlier]
    match_visual(source, generated, kp_source, kp_generated, retained, Path(args.matches_visual).resolve(), "ORB RETAINED MATCHES - VISUAL TEXTURE ONLY")
    match_visual(source, generated, kp_source, kp_generated, inlier_matches, Path(args.inliers_visual).resolve(), "RANSAC GEOMETRIC INLIERS - NOT SEMANTIC IDENTITY")
    h_full = None
    h_normalized = None
    if h_work is not None:
        h_full, h_normalized = normalize_homography(h_work, source_meta, generated_meta)
    inlier_count = len(inlier_matches)
    return {
        "schema_version": "1.0",
        "implementation": "OpenCV ORB + BFMatcher + RANSAC homography",
        "dependency_version": cv2.__version__,
        "deterministic_runtime": {"rng_seed": 0, "threads": 1, "opencl": False},
        "configuration": {"orb": ORB_CONFIG, **FEATURE_CONFIG},
        "source": {"path": str(source_path), "sha256": sha256_file(source_path), **source_meta},
        "generated": {"path": str(generated_path), "sha256": sha256_file(generated_path), **generated_meta},
        "source_keypoints": len(kp_source),
        "generated_keypoints": len(kp_generated),
        "raw_matches": len(knn),
        "two_neighbor_match_pairs": sum(1 for pair in knn if len(pair) == 2),
        "retained_matches": len(retained),
        "geometric_inliers": inlier_count,
        "inlier_ratio": inlier_count / len(retained) if retained else 0.0,
        "geometric_transform_estimated": h_work is not None,
        "homography_source_pixels_to_generated_pixels": h_full.tolist() if h_full is not None else None,
        "homography_source_normalized_to_generated_normalized": h_normalized.tolist() if h_normalized is not None else None,
        "inlier_reprojection_error_working_pixels": {
            "mean": float(np.mean(reprojection_errors)) if reprojection_errors else None,
            "median": float(np.median(reprojection_errors)) if reprojection_errors else None,
            "maximum": float(np.max(reprojection_errors)) if reprojection_errors else None,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    pose = subparsers.add_parser("pose")
    pose.add_argument("--image", required=True)
    pose.add_argument("--model", required=True)
    pose.add_argument("--visual", required=True)
    features = subparsers.add_parser("features")
    features.add_argument("--source", required=True)
    features.add_argument("--generated", required=True)
    features.add_argument("--matches-visual", required=True)
    features.add_argument("--inliers-visual", required=True)
    args = parser.parse_args()
    configure_runtime()
    output = pose_command(args) if args.command == "pose" else features_command(args)
    print(json.dumps(output, sort_keys=True, separators=(",", ":"), allow_nan=False))


if __name__ == "__main__":
    main()
