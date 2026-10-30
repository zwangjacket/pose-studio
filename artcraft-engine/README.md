# ArtCraft pose tools through the CLI

## Interactive local viewer

Open **http://127.0.0.1:8766/pose.html** while the local server is running.
The default is ArtCraft's female mannequin, with Move / Rotate / Scale / Pose
modes, clickable joints, numeric transforms, snapping, undo/redo, pose JSON
save/load, and posed GLB download. Drag empty space to orbit, right-drag to pan,
and scroll to zoom. Keyboard shortcuts: W / E / R / P; F frames the figure.

Pose mode starts with Bend / Twist / Swing sliders. They describe local XYZ
rotation offsets from the supplied relaxed standing pose. Joint names use
familiar terms (elbow, knee, wrist, etc.),
grouped by body region. Click a golden joint or choose it from the dropdown.
One slider gesture is one undo step. Reset this joint restores only that joint.
Rotation rings are optional. Targets keep a roughly 9-pixel radius at different
zoom levels. Starter poses (standing, wave, arms open, reach) preserve the whole
figure's position, orientation and scale, and can be undone.

**Prevent body intersections** is on by default. On release, the local guard
clamps configured joint limits and checks 15 capsule volumes covering the torso,
head, arms, hands, legs, and feet. Adjacent segments are excluded from collision
pairs. If the requested pose overlaps, it searches nearby rotations of the edited
joint and refines a clear solution; a previously verified pose provides a safe
fallback. The correction is part of the same undo action. Imported poses and
starter poses are also checked, and turning the guard on repairs an invalid pose.

This is an approximate FK constraint system, not a full anatomy simulator or IK.
The result is a nearby clear configuration under these proxies, not a guaranteed
globally closest pose. Fingers, floor contact, soft tissue, and exact triangle-mesh
contact are not constrained. The guard can be switched off for free posing.
Implementation: `browser/pose-guard.js`. Its tests use the actual female rig and
cover arm/torso overlap, crossed thighs, hinge/head limits, a previously invalid
pose, root-transform preservation, and 48 deterministic sampled edits.

Start the server from any folder:

```bash
python3 -m http.server 8766 --bind 127.0.0.1 --directory ..
```

The browser adapter is `browser/app.js`. Rebuild after editing it:

```bash
cd tools/artcraft-engine
npm run build:browser
```

Use Node 20+ (installed at `~/.nvm/versions/node/v24.16.0/bin/node` here).
The browser bundle includes Three.js 0.171.0 and the same unmodified upstream
FKHelper/TransformControls/BoneJSONHelper as the CLI. The host supplies the UI,
camera, history, downloads, and a screen-distance sensitivity correction for
the center scale handle. It uses pinned FKHelper internals for the joint dropdown.
No CDN, login, or remote service is needed at runtime.

Save work before closing or refreshing: edits live in the page until downloaded.
The viewer's pose JSON wraps upstream bone JSON with the whole-character transform
and a format identifier. It is distinct from the CLI's bare bone JSON.
GLB download uses Three.js GLTFExporter and keeps the skeleton/skinning, while
excluding gizmos, the floor, and animation clips. The earlier `index.html`
viewer and CLI remain available.

Female asset provenance and local-use scope are recorded in
`notes/interactive-viewer.md`.

This adapter executes ArtCraft's actual FK posing modules in a headless Node
process. It does not use the custom quaternion posing code from the earlier
`mannequin` prototype.

## Try it

From the PhotoCraft-work folder, list the bones the ArtCraft pose tool exposes:

```bash
uv run --no-project python3 tools/artcraft_cli.py bones \
  --input exports/mannequin-native-fk.glb
```

Turn the mannequin's head 25 degrees around its local Y axis:

```bash
uv run --no-project python3 tools/artcraft_cli.py pose \
  --input exports/mannequin-native-fk.glb \
  --rotate Head:y:25 \
  --output exports/my-head-turn.glb \
  --pose-out poses/my-head-turn.pose.json
```

Repeat `--rotate` to adjust more bones. Axes are `x`, `y`, `z`; angles are in
degrees and relative to the input pose. Operations run in argument order. Default
space is local, matching ArtCraft's FK mode; use `--space world` for world axes.
`--snap 15` invokes ArtCraft's own rotation snapping.

Restore a saved pose on the same source skeleton:

```bash
uv run --no-project python3 tools/artcraft_cli.py pose \
  --input models/artcraft-male-doll.glb \
  --pose-in poses/my-head-turn.pose.json \
  --output exports/restored-head-turn.glb
```

Existing output files are rejected. Pick a new filename for each version. The
original model is preserved. All pose operations run locally without accounts,
network requests, or AI generation.

## What is upstream and what is ours

The four files under `upstream/engine/` are **unmodified** ArtCraft source at
commit `d4e4ac69bbd93d237eaf5d0260bc6a5ff3a5e373`:

- `FKHelper.ts`: exposes editable bones and attaches the rotation control.
- `FKBoneFilter.ts`: decides which bones the pose tool makes editable.
- `TransformControls.js`: applies rotations, space conversion, snapping, and
  emits the normal drag/object-change events.
- `BoneJSONHelper.ts`: serializes and restores ArtCraft's native bone-pose JSON.

`upstream/SOURCE.json` records exact source paths and SHA-256 hashes. Tests verify
that the vendored modules have not changed. Upstream MIT license and NOTICE are
retained. Three.js is pinned to 0.171.0, satisfying ArtCraft's declared version.

Our `engine.mjs` provides the minimal host: a Three.js scene, a camera, and a DOM
event-registration stub. It asks FKHelper for its actual editable bone markers,
attaches the selected bone through FKHelper's own control path, then converts the
CLI angle to a synthetic pointer drag. The **unchanged upstream**
`pointerDown`, `pointerMove`, and `pointerUp` methods calculate and apply the
rotation. No custom quaternion calculation applies the pose.

The adapter calls some TypeScript-private members of FKHelper that remain normal
properties in its emitted JavaScript. This is why the upstream revision is pinned
and covered by behavioral tests. No changes are made to the installed app.

Our GLB writer persists the resulting node transforms while preserving the source
meshes, skin weights, inverse bind matrices and binary chunks. It removes animation
clips from the exported variant so they cannot override the static pose. Saved
`.pose.json` files come directly from ArtCraft's `BoneJSONHelper`.

## Boundary

This runs the **pose subsystem** from ArtCraft, not the whole desktop application.
It edits local GLB files and pose files. It does not connect to, change, or
synchronize an already open ArtCraft desktop scene. Importing the resulting model
into the desktop application remains separate.

The original CLI's `mannequin --pose standing|wave` command is retained as a legacy
experiment and uses our earlier custom posing code. Use **`pose`** and **`bones`**
for ArtCraft's actual tools.

## Build and verify

Dependencies and compiled modules are already installed here. For a fresh copy,
use Node 20+ and npm:

```bash
cd tools/artcraft-engine
npm ci --ignore-scripts
npm run build
npm test
```

The six engine tests cover untouched upstream source hashes, native bone
filtering, local/world rotations, events, snap/inverse rotation, native pose
save/restore, and preservation of GLB binary/skin data. The mannequin fixture is
the original GLB under `models/`.

The sample `mannequin-native-fk.glb` was built from that original by applying these
world-space rotations through ArtCraft's controls:

```text
LeftArm:z:-70
RightArm:z:70
RightForeArm:x:-65
Head:y:20
```

Review it in the local viewer at http://127.0.0.1:8766 (select “ArtCraft FK — CLI edit”).
