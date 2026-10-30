#!/usr/bin/env python3
"""ArtCraft catalog client and CLI bridge to its upstream FK posing modules."""

from __future__ import annotations

import argparse
import json
import os
import plistlib
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

VERSION = "0.3.0"
API_BASE = "https://api.storyteller.ai"
# Override with ARTCRAFT_APP for non-default or non-macOS installs.
APP_PATH = Path(os.environ.get("ARTCRAFT_APP", "/Applications/ArtCraft.app"))
KINDS = ("image", "video")
MAX_RESPONSE_BYTES = 5 * 1024 * 1024
BUILD_HINT = "Build the pose adapter first: cd artcraft-engine && npm ci && npm run build"


class CliError(Exception):
    """An actionable error to show without a traceback."""


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    handlers = {
        "bones": cmd_pose_adapter,
        "pose": cmd_pose_adapter,
        "mannequin": cmd_mannequin,
        "doctor": cmd_doctor,
        "models": cmd_models,
        "model": cmd_model,
    }
    try:
        return handlers[args.command](args, parser)
    except CliError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except BrokenPipeError:
        # Allow piping a listing into head without a noisy traceback.
        return 0


def cmd_pose_adapter(args: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    adapter = Path(__file__).parent / "artcraft-engine/cli.mjs"
    if not shutil.which("node"):
        raise CliError("The ArtCraft pose adapter needs Node.js 20 or newer.")
    if not (adapter.parent / "dist/FKHelper.js").exists():
        raise CliError(BUILD_HINT)
    command = ["node", str(adapter), args.command, "--input", str(args.input)]
    if args.command == "bones":
        if args.json:
            command.append("--json")
    else:
        command.extend(["--space", args.space])
        for rotation in args.rotate:
            command.extend(["--rotate", rotation])
        for option in ("output", "pose_in", "pose_out", "snap"):
            if getattr(args, option) is not None:
                command.extend(["--" + option.replace("_", "-"), str(getattr(args, option))])
    return subprocess.run(command, check=False).returncode


def cmd_mannequin(args: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    from artcraft_mannequin import build_mannequin
    try:
        report = build_mannequin(args.source, args.output, args.pose, args.style)
    except (OSError, ValueError) as exc:
        raise CliError(str(exc)) from exc
    print_json(report)
    return 0


def cmd_doctor(args: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    report = installation_report()
    if not args.offline:
        catalog = fetch_catalog("image", "artcraft", args.timeout)
        report["catalog_check"] = {
            "status": "ok",
            "endpoint": catalog["source"],
            "model_count": len(catalog["models"]),
            "credentials_sent": False,
        }
    else:
        report["catalog_check"] = {"status": "not checked (offline)"}
    if args.json:
        print_json(report)
    else:
        app = report["desktop_app"]
        print(f"ArtCraft headless prototype {VERSION}")
        print(f"Python: {report['python']}")
        print(f"Desktop app: {app['path']}")
        print(f"Installed version: {app.get('version') or 'not found'}")
        print(f"Catalog: {report['catalog_check']['status']}")
        if "model_count" in report["catalog_check"]:
            print(f"ArtCraft image models: {report['catalog_check']['model_count']}")
        print("This client uses public GET requests; it does not launch the desktop app.")
    return 0


def cmd_models(args: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    catalog = fetch_catalog(args.kind, args.provider, args.timeout)
    models = catalog["models"]
    if args.available_only:
        models = [m for m in models if m.get("is_disabled") is not True]
    if args.search:
        term = args.search.casefold()
        models = [m for m in models if term in (
            f"{m['model']} {m.get('full_name') or ''} {m.get('model_creator') or ''}"
        ).casefold()]
    catalog["models"] = models
    if args.json:
        print_json(catalog)
    else:
        print_models(catalog)
    return 0


def cmd_model(args: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    catalog = fetch_catalog(args.kind, args.provider, args.timeout)
    model = next((m for m in catalog["models"] if m["model"] == args.model_id), None)
    if model is None:
        raise CliError(
            f"Unknown {args.kind} model {args.model_id!r}. "
            f"Try: {parser.prog} models --kind {args.kind} --provider all"
        )
    # Preserve every field, including new server-side options.
    print_json({
        "kind": args.kind,
        "source": catalog["source"],
        "fetched_at": catalog["fetched_at"],
        "model": model,
        "providers": providers_for_model(catalog, args.model_id),
    })
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="artcraft-headless",
        description="Headless ArtCraft prototype: model catalogs and upstream FK pose tools. No generation jobs.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {VERSION}")
    subcommands = parser.add_subparsers(dest="command", required=True)

    models = subcommands.add_parser("models", help="Fetch the live image or video model catalog")
    add_catalog_options(models)
    models.add_argument("--search", help="Filter by model ID, display name, or creator")
    models.add_argument("--available-only", action="store_true", help="Exclude explicitly disabled models")
    models.add_argument("--json", action="store_true", help="Print the catalog as JSON")

    model = subcommands.add_parser("model", help="Inspect a model's capabilities and supported options")
    model.add_argument("model_id", help="Exact model identifier from the models command")
    add_catalog_options(model)

    doctor = subcommands.add_parser("doctor", help="Check the installation and public catalog connection")
    doctor.add_argument("--offline", action="store_true", help="Inspect the local installation only")
    doctor.add_argument("--json", action="store_true", help="Print diagnostics as JSON")
    doctor.add_argument("--timeout", type=positive_timeout, default=20, metavar="SECONDS")

    mannequin = subcommands.add_parser("mannequin", help="Legacy custom pose prototype; use pose for ArtCraft's actual tools")
    mannequin.add_argument("--source", type=Path, required=True, help="Downloaded ArtCraft mannequin GLB")
    mannequin.add_argument("--output", type=Path, required=True, help="New GLB file (existing files are never overwritten)")
    mannequin.add_argument("--pose", choices=("standing", "t-pose", "wave"), default="standing")
    mannequin.add_argument("--style", choices=("ivory", "original"), default="ivory")

    bones = subcommands.add_parser("bones", help="List editable bones using ArtCraft's FKHelper")
    bones.add_argument("--input", type=Path, required=True, help="Rigged GLB")
    bones.add_argument("--json", action="store_true")

    pose = subcommands.add_parser("pose", help="Adjust bones using ArtCraft's actual TransformControls")
    pose.add_argument("--input", type=Path, required=True, help="Rigged GLB to load")
    pose.add_argument("--rotate", action="append", default=[], metavar="BONE:AXIS:DEGREES", help="Relative rotation; repeat to edit multiple bones")
    pose.add_argument("--space", choices=("local", "world"), default="local")
    pose.add_argument("--snap", type=float, metavar="DEGREES", help="ArtCraft's rotation snapping increment")
    pose.add_argument("--pose-in", type=Path, help="Restore an ArtCraft BoneJSONHelper pose")
    pose.add_argument("--pose-out", type=Path, help="Save an ArtCraft BoneJSONHelper pose")
    pose.add_argument("--output", type=Path, help="Write a new posed GLB; existing files are never overwritten")
    return parser


def add_catalog_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--kind", choices=KINDS, default="image")
    parser.add_argument("--provider", choices=("artcraft", "all"), default="artcraft")
    parser.add_argument("--timeout", type=positive_timeout, default=20, metavar="SECONDS")


def positive_timeout(value: str) -> int:
    try:
        seconds = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("timeout must be a positive integer") from exc
    if seconds <= 0:
        raise argparse.ArgumentTypeError("timeout must be a positive integer")
    return seconds


def fetch_catalog(kind: str, provider: str, timeout: int) -> dict:
    url = f"{API_BASE}/v1/omni_gen/models/{kind}?{urlencode({'provider': provider})}"
    request = Request(url, headers={
        "Accept": "application/json",
        "User-Agent": f"artcraft-headless-prototype/{VERSION}",
    }, method="GET")
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except HTTPError as exc:
        if exc.code in (401, 403):
            raise CliError(f"Catalog access denied (HTTP {exc.code}); public endpoint access may have changed.") from exc
        if exc.code == 429:
            raise CliError("Catalog rate limit reached (HTTP 429); try again later.") from exc
        raise CliError(f"Catalog request failed (HTTP {exc.code}).") from exc
    except (URLError, TimeoutError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        raise CliError(f"Cannot reach the ArtCraft catalog: {reason}") from exc
    if len(raw) > MAX_RESPONSE_BYTES:
        raise CliError("Catalog response is unexpectedly large.")
    catalog = parse_catalog(raw)
    catalog.update({
        "kind": kind,
        "provider_filter": provider,
        "source": url,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    })
    return catalog


def parse_catalog(raw: bytes) -> dict:
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        raise CliError("The catalog endpoint did not return valid JSON.") from exc
    if not isinstance(data, dict) or data.get("success") is not True:
        raise CliError("The catalog endpoint did not report success.")
    models = data.get("models")
    if not isinstance(models, list) or any(
        not isinstance(m, dict) or not isinstance(m.get("model"), str) for m in models
    ):
        raise CliError("Unexpected catalog format: expected model objects with string IDs.")
    providers = data.get("providers", [])
    if not isinstance(providers, list) or any(
        not isinstance(p, dict) or not isinstance(p.get("models", []), list)
        or any(not isinstance(m, dict) for m in p.get("models", []))
        for p in providers
    ):
        raise CliError("Unexpected catalog format: invalid provider list.")
    data["providers"] = providers
    return data


def providers_for_model(catalog: dict, model_id: str) -> list[dict]:
    return [
        {"provider": p.get("provider"), **m}
        for p in catalog["providers"]
        for m in p.get("models", [])
        if m.get("model") == model_id
    ]


def print_models(catalog: dict) -> None:
    rows = [("MODEL ID", "NAME", "STATUS")]
    for model in catalog["models"]:
        disabled = model.get("is_disabled")
        status = "disabled" if disabled is True else ("enabled" if disabled is False else "not flagged")
        rows.append((model["model"], model.get("full_name") or model["model"], status))
    widths = [max(len(row[i]) for row in rows) for i in range(3)]
    for row in rows:
        print("  ".join(value.ljust(widths[i]) for i, value in enumerate(row)).rstrip())
    print(f"\n{len(catalog['models'])} {catalog['kind']} models; provider filter: {catalog['provider_filter']}.")
    print(f"Source: {catalog['source']}")
    print("Catalog presence does not guarantee account access or local model availability.")


def installation_report() -> dict:
    app = {"path": str(APP_PATH), "installed": APP_PATH.is_dir(), "version": None}
    plist_path = APP_PATH / "Contents/Info.plist"
    if plist_path.exists():
        try:
            with plist_path.open("rb") as stream:
                app["version"] = plistlib.load(stream).get("CFBundleShortVersionString")
        except (OSError, plistlib.InvalidFileException, ValueError) as exc:
            raise CliError(f"Cannot read the installed app's version: {exc}") from exc
    return {"cli_version": VERSION, "python": sys.version.split()[0], "desktop_app": app}


def print_json(data: dict) -> None:
    print(json.dumps(data, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    raise SystemExit(main())
