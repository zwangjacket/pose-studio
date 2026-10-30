# Interactive female mannequin viewer

Created 2026-10-26. Entry point: `../pose.html` (serve the mannequin directory).

## Female model provenance

- Listed as **Female Doll** in ArtCraft's `devCharacterItems`:
  https://github.com/storytold/artcraft/blob/main/frontend/libs/components/pagescene/src/lib/signals/demoAssets/demoCharacterItems.ts
- Media token: `m_r7w1tmkx2jg8nznr3hyzj4k6zhfh7d`.
- Public metadata: https://api.storyteller.ai/v1/media_files/file/m_r7w1tmkx2jg8nznr3hyzj4k6zhfh7d
- Source: https://cdn-2.fakeyou.com/media/w/9/1/g/h/w91ghrw65zfxzm6d2zhkaveaq2h7qqh6/upload_w91ghrw65zfxzm6d2zhkaveaq2h7qqh6.glb
- Metadata identifies the uploader as Printrman. As with the earlier male model,
  asset redistribution rights are not established by the code license. This is a
  local experiment, not a published asset distribution.
- Original saved as `01_source/artcraft-female-doll.glb`.
- Default `03_exports/mannequin-female-standing.glb` uses upstream FK to rotate
  LeftArm -65 degrees and RightArm +65 degrees about world Z. The original mesh,
  skeleton and skin weights are preserved; animation is removed for static posing.
- The female rig has 65 bones and two skinned meshes; ArtCraft exposes 22 joints.
  The viewer applies an ivory body / graphite joints material treatment at runtime.

## Implementation

Source and build command live in `tools/artcraft-engine/browser/app.js` and
`tools/artcraft-engine/build-browser.mjs`, relative to PhotoCraft-work. The
standalone browser bundle is under `04_assets/pose-app.js`. Upstream files remain
unchanged at the pinned revision recorded in `tools/artcraft-engine/upstream/SOURCE.json`.
Relevant license and notice files are copied alongside the browser bundle.

The viewer edits whole-character transforms and FK joint rotations locally.
Both hands start with a gentle finger curl, increasing slightly toward the pinky,
and relaxed thumbs. This is captured in the default pose so Reset figure and
starter poses retain the relaxed hands; loaded pose files keep their saved fingers.
It supports undo/redo, reset, framing, front view, camera orbit/pan/zoom, numeric
transforms, snapping, JSON pose save/load, and a posed GLB export. Uniform scaling
uses a host sensitivity correction to avoid a singularity at the gizmo's pivot.
Pose JSON includes the character's world placement and the native ArtCraft bone
tree. Downloads go to the browser's usual download destination.

## Direct ragdoll posing controls

The default Pose mode uses direct 3D ragdoll manipulation on the golden joint
markers (or holding `Space` while dragging any body part), replacing the earlier
joint-selection dropdown and Bend / Twist / Swing sliders. The sidebar displays a
compact **Active joint** bar with a one-click **Reset joint** button, **Prevent body
intersections** toggle, optional **Fine-tune with rotation rings** toggle, and
starter poses (relaxed standing, wave, arms open, reach forward, arms crossed,
hands behind back, kneel, and laying down). Whole-figure numeric transforms (`X / Y / Z`, handle axes, and snapping)
appear only in `Move` / `Rotate` / `Scale` modes or when rotation rings are enabled.

Double-click a joint to toggle its fine-tune rotation rings. The active joint is
larger and mint-highlighted while the other markers dim; the active marker stays
visible even when **Show joint markers** is off. Double-click empty viewport space
to turn off the rings and clear the active joint. Fine-tuning can also be enabled
with the checkbox after deselecting.

## Self-collision guard

`browser/pose-guard.js` adds 15 capsule proxies and 94 non-adjacent collision pairs,
plus configured local joint limits. It operates in character space, so moving,
rotating or scaling the whole model does not change the collision test. On release,
it searches nearby rotations and refines toward the requested pose. The last
verified clear state is the fallback; no global-nearest solution is promised.
Collision correction and the user's edit form a single undo action. Golden joint
targets turn red for overlapping segments while an edit is in progress. Turning
the guard off allows free posing, and turning it on projects the current pose.

Limitations: simplified volumes, no exact mesh collision, no finger constraints,
no floor contact, no balance/strength model, and no soft tissue simulation. A clear
proxy result is not a guarantee of anatomical validity or zero visual penetration.

Verified in the browser: a shoulder edit into the torso snaps back on release,
and enabling the guard repairs a pose created while it was disabled. Seven
constraint tests exercise the actual female model, including 48 sampled edits.

## Ragdoll pull (chain-following IK)

`browser/ragdoll-ik.js` adds a chain-following inverse kinematics ("ragdoll pull")
mode activated by holding `Space` while dragging any selectable joint marker (or by
toggling **Ragdoll pull (follow joints)** in the Pose panel).

- **Arms & hands (`LeftHand`, `RightHand`, `LeftForeArm`, `RightForeArm`)**:
  Dragging a wrist or elbow coordinates the spine (`Spine`, `Spine1`, `Spine2`),
  collarbone (`Shoulder`), upper arm (`Arm`), and forearm (`ForeArm`) using
  damped torso compliance, analytical two-bone Law-of-Cosines flexion, anatomical
  pole alignment, and a collision-avoiding swivel search. Dragging a hand inward
  into the back/waist silhouette automatically projects the target around the
  back of the torso capsules so the arm folds behind the back without passing
  through the chest; scrolling the mouse wheel (or holding `Shift`) while dragging
  adjusts depth forward/backward.
- **Legs & feet (`LeftFoot`, `RightFoot`, `LeftToeBase`, `RightToeBase`, `LeftLeg`)**:
  Dragging an ankle, toe, or knee bends the knee and hip while subtly tilting the
  pelvis and counter-balancing the spine.
- **Torso, neck, head & pelvis (`Spine`, `Spine1`, `Spine2`, `Neck`, `Head`, `Hips`)**:
  Pushing any torso or pelvis point downward while holding `Space` lowers the
  pelvis (`Hips.position`) and drives two-bone IK on both legs so the knees bend
  forward and descend to the floor into a crouch or full kneel (with shins, ankles,
  and toes aligned flat along the floor). Pulling the torso back upward unbends
  the knees to return to standing, while horizontal dragging leans and twists the
  spine chain in a smooth distributed curve.
- Connected joints that are actively following the dragged joint highlight in
  mint-teal during the drag, and the entire pull records as a single undo action.

## Soft female form & studio image rendering

`browser/female-form.js` (`FemaleForm`) provides a reversible **Soft female form (less skeletal)** mode and studio portrait renderer:

- **Seamless female body (`FemaleSeamlessBody`)**: Replaces the segmented mannequin armor plates and exposed ball joints on the torso, waist, hips, arms, and legs with a continuous, skin-weighted `SkinnedMesh` bound to the same Mixamo skeleton (sculpted female bust, hourglass waist, rounded hips and glutes, continuous knees and elbows), while preserving the head, hands, and feet and adding a sculpted feminine hairstyle (`FemaleHairCosmetic`) on `mixamorigHead`. Unchecking **Soft female form (less skeletal)** restores the original jointed mannequin at any time.
- **Studio image rendering (`Render image (PNG)`)**: Renders a `1600 × 1200` studio portrait (`renderStudioImage`) with all joint markers, gizmos, skeleton lines, and floor grid hidden, adding warm portrait fill/rim lighting and a soft studio vignette. Inside the render preview dialog (`#render-modal`), users can toggle **Soft female form (less skeletal)**, switch between **Warm skin · studio**, **Sculpted studio clay**, and **Classic jointed mannequin**, and download the rendered PNG.
