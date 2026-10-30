"""Local posing of ArtCraft's supplied Mixamo doll, retaining its skinned rig."""

from __future__ import annotations

import json
import math
import struct
from pathlib import Path

JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942


def build_mannequin(source: Path, output: Path, pose: str, style: str) -> dict:
    if output.suffix.lower() != ".glb":
        raise ValueError("The output must use the .glb extension.")
    if output.exists():
        raise ValueError(f"Output already exists: {output}. Choose a new filename.")
    doc, chunks = read_glb(source)
    if not doc.get("skins"):
        raise ValueError("The source model has no skin/skeleton to pose.")
    if any("uri" in b for b in doc.get("buffers", [])):
        raise ValueError("Only self-contained GLB files are supported.")
    if any("uri" in image for image in doc.get("images", [])):
        raise ValueError("External image files are not supported.")
    original_clips = len(doc.pop("animations", []))
    joints = {index for skin in doc["skins"] for index in skin["joints"]}
    apply_pose(doc, pose)
    if style == "ivory":
        for index, material in enumerate(doc.get("materials", [])):
            pbr = material.setdefault("pbrMetallicRoughness", {})
            pbr["baseColorFactor"] = [0.68, 0.58, 0.43, 1.0] if index == 0 else [0.13, 0.16, 0.17, 1.0]
            pbr["metallicFactor"] = 0.12
            pbr["roughnessFactor"] = 0.55
    doc.setdefault("asset", {})["generator"] = "ArtCraft headless mannequin prototype 0.2.0"
    doc.setdefault("extras", {})["headless_pose"] = pose
    output.parent.mkdir(parents=True, exist_ok=True)
    write_glb(output, doc, chunks)
    return {
        "output": str(output.resolve()),
        "source": str(source.resolve()),
        "pose": pose,
        "style": style,
        "mesh_count": len(doc.get("meshes", [])),
        "skin_count": len(doc["skins"]),
        "joint_count": len(joints),
        "source_animation_clips_removed": original_clips,
        "rig_preserved": True,
        "network_requests": 0,
    }


def read_glb(path: Path) -> tuple[dict, list[tuple[int, bytes]]]:
    data = path.read_bytes()
    if len(data) < 20:
        raise ValueError("File is too short to be a GLB.")
    magic, version, length = struct.unpack_from("<4sII", data)
    if magic != b"glTF" or version != 2 or length != len(data):
        raise ValueError("Expected a valid glTF 2.0 binary file.")
    chunks = []
    offset = 12
    while offset < len(data):
        if offset + 8 > len(data):
            raise ValueError("Truncated GLB chunk header.")
        size, kind = struct.unpack_from("<II", data, offset)
        offset += 8
        if size % 4 or offset + size > len(data):
            raise ValueError("Invalid GLB chunk length.")
        chunks.append((kind, data[offset:offset + size]))
        offset += size
    if not chunks or chunks[0][0] != JSON_CHUNK:
        raise ValueError("GLB is missing its initial JSON chunk.")
    try:
        doc = json.loads(chunks[0][1])
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError("GLB contains invalid JSON.") from exc
    if not isinstance(doc, dict):
        raise ValueError("GLB JSON must be an object.")
    return doc, chunks[1:]


def write_glb(path: Path, doc: dict, chunks: list[tuple[int, bytes]]) -> None:
    raw = json.dumps(doc, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()
    raw += b" " * (-len(raw) % 4)
    payload = struct.pack("<II", len(raw), JSON_CHUNK) + raw
    for kind, chunk in chunks:
        payload += struct.pack("<II", len(chunk), kind) + chunk
    # Exclusive creation protects earlier versions and the source file.
    with path.open("xb") as stream:
        stream.write(struct.pack("<4sII", b"glTF", 2, 12 + len(payload)) + payload)


def apply_pose(doc: dict, pose: str) -> None:
    if pose == "t-pose":
        return
    # Aim the upper arms in world space, converting back to each parent's
    # local coordinates. This avoids assuming a particular bone roll.
    aim_bone(doc, "LeftArm", "LeftForeArm", [0.18, -0.984, 0.0])
    aim_bone(doc, "RightArm", "RightForeArm", [-0.18, -0.984, 0.0])
    if pose == "wave":
        aim_bone(doc, "RightArm", "RightForeArm", [-0.9, 0.3, 0.1])
        aim_bone(doc, "RightForeArm", "RightHand", [-0.15, 0.97, 0.15])


def aim_bone(doc: dict, bone_name: str, child_name: str, direction: list[float]) -> None:
    nodes = doc["nodes"]
    by_name = {node.get("name", "").split(":")[-1]: i for i, node in enumerate(nodes)}
    if bone_name not in by_name or child_name not in by_name:
        raise ValueError(f"The required Mixamo bones are missing: {bone_name}, {child_name}.")
    bone, child = by_name[bone_name], by_name[child_name]
    parents = {c: i for i, node in enumerate(nodes) for c in node.get("children", [])}
    cache = {}

    def world_q(index):
        if index not in cache:
            node = nodes[index]
            if "matrix" in node:
                raise ValueError("Matrix-based bone transforms are not supported by this prototype.")
            q = normalize(node.get("rotation", [0, 0, 0, 1]))
            cache[index] = multiply(world_q(parents[index]), q) if index in parents else q
        return cache[index]

    current = world_q(bone)
    child_offset = nodes[child].get("translation", [0, 1, 0])
    actual = rotate(current, child_offset)
    delta = from_vectors(actual, direction)
    desired = multiply(delta, current)
    parent = world_q(parents[bone]) if bone in parents else [0, 0, 0, 1]
    inverse_parent = [-parent[0], -parent[1], -parent[2], parent[3]]
    nodes[bone]["rotation"] = normalize(multiply(inverse_parent, desired))


def normalize(vector):
    length = math.sqrt(sum(v * v for v in vector))
    if length < 1e-12:
        raise ValueError("Cannot normalize a zero-length vector.")
    return [v / length for v in vector]


def multiply(a, b):
    x, y, z, w = a
    X, Y, Z, W = b
    return [w * X + x * W + y * Z - z * Y,
            w * Y - x * Z + y * W + z * X,
            w * Z + x * Y - y * X + z * W,
            w * W - x * X - y * Y - z * Z]


def rotate(q, vector):
    return multiply(multiply(q, [*vector, 0]), [-q[0], -q[1], -q[2], q[3]])[:3]


def from_vectors(start, end):
    a, b = normalize(start), normalize(end)
    dot = max(-1.0, min(1.0, sum(x * y for x, y in zip(a, b))))
    if dot < -0.999999:
        axis = [0, -a[2], a[1]] if abs(a[0]) < 0.9 else [-a[2], 0, a[0]]
        return [*normalize(axis), 0]
    cross = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
    return normalize([*cross, 1 + dot])
