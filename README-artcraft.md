# ArtCraft headless prototype

Version 0.3.0 adds `pose` and `bones`, which execute ArtCraft's actual FK posing
tools. See [ArtCraft pose CLI](artcraft-engine/README.md) for commands, provenance,
and the boundary between the upstream tools and our adapter. The earlier
`mannequin` command described below remains a legacy custom implementation.

A standalone CLI that calls the same public model-listing endpoints as
ArtCraft's open-source desktop client. Catalog commands need Python 3.10+ and no
third-party Python packages, GUI, Rust, API keys, or desktop credentials. The
upstream pose adapter additionally uses Node 20+, Three.js and a one-time
TypeScript build; these dependencies are already installed in this workspace.

This is our prototype, not an official CLI shipped with ArtCraft. It implements
catalog inspection and local posing of ArtCraft's supplied mannequin GLB. It does
not perform inference, uploads, or generation. Listing a model does not download
its weights or grant access to it.

Run from `/Users/graydonsnider/PycharmProjects/PhotoCraft-work`:

```bash
uv run --no-project python3 tools/artcraft_cli.py --help
uv run --no-project python3 tools/artcraft_cli.py doctor
uv run --no-project python3 tools/artcraft_cli.py models
uv run --no-project python3 tools/artcraft_cli.py models --kind video
uv run --no-project python3 tools/artcraft_cli.py models --provider all --search flux
uv run --no-project python3 tools/artcraft_cli.py model nano_banana_pro
uv run --no-project python3 tools/artcraft_cli.py models --json
```

Direct `python3 tools/artcraft_cli.py ...` also works in an ordinary terminal.
The examples use the already installed `uv` because direct Python network
requests cannot resolve the API host in this agent's restricted execution
environment, while `uv run` succeeds. No third-party Python dependencies are needed.

`doctor --offline` reads only the installed app's version. Other commands make
public HTTPS GET requests to `api.storyteller.ai`; no credentials are read or sent.
Use `--timeout 10` on a subcommand to change the network timeout. JSON keeps all
server-provided fields, including capabilities, disabled flags, and provider
overrides. The listing reports an absent disabled flag as “not flagged”, rather
than assuming that the model is enabled.

## Source references

Protocol checked against the public `storytold/artcraft` repository on 2026-10-13:

- [Image catalog client](https://github.com/storytold/artcraft/blob/main/crates/api_clients/artcraft/artcraft_client/src/endpoints/omni_gen/models/image/omni_gen_list_image_models.rs)
- [Video catalog client](https://github.com/storytold/artcraft/blob/main/crates/api_clients/artcraft/artcraft_client/src/endpoints/omni_gen/models/video/omni_gen_list_video_models.rs)
- [Public API host](https://github.com/storytold/artcraft/blob/main/crates/api_clients/artcraft/artcraft_client/src/utils/api_host.rs)

The upstream clients support optional credentials and expose
`GET /v1/omni_gen/models/{image,video}` with `provider=artcraft|all`.
Their production tests explicitly use no credentials. This prototype independently
implements those requests using Python's standard library.

## Validation

```bash
uv run --no-project python3 -m unittest discover -s tools/tests -v
uv run --no-project python3 tools/artcraft_cli.py doctor
```

The first command tests response handling and CLI behavior without network access.
The second checks the installed desktop version and makes one live catalog request.

Verified on 2026-10-13: help, doctor (installed ArtCraft 0.41.0), live image
listing, filtered FLUX listing, video listing, and Nano Banana Pro capability
inspection. Eight offline tests passed. The live check returned 20 image model
entries and 30 video entries after excluding explicitly disabled models; the
catalog and counts can change. No credentials were used and no generation jobs
were submitted.

## Local 3D mannequin

The supplied ArtCraft male doll has two skinned meshes and 52 joints. Its original
download is saved in `models/artcraft-male-doll.glb`.
Pose it locally:

```bash
uv run --no-project python3 tools/artcraft_cli.py mannequin \
  --source models/artcraft-male-doll.glb \
  --pose wave \
  --output exports/my-wave.glb
```

Poses: `standing`, `wave`, `t-pose` (the supplied rest pose). `--style original`
retains the original colors; the default `ivory` uses a warm body and dark joints.
The existing clip is removed from the exported variant so it cannot override the
new pose. Skin weights, inverse bind matrices, meshes and the full skeleton are
preserved. The original GLB is unchanged. Outputs must use new filenames.

This command runs entirely locally and makes no network requests. It operates on
the source asset, not on an active ArtCraft desktop scene. The interactive local
preview uses Three.js, the same 3D library ArtCraft's scene engine uses:

```bash
uv run --no-project python3 -m http.server 8766 --bind 127.0.0.1 --directory .
```

Open `http://127.0.0.1:8766`. The preview supports orbiting, standing/waving poses,
skeleton visibility and GLB download. Its JavaScript libraries are vendored;
it does not use an external CDN at runtime.
