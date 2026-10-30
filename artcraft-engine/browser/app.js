import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { FKHelper } from '../upstream/engine/KinHelpers/FKHelper.ts';
import { BoneJSONHelper } from '../upstream/engine/KinHelpers/BoneJSONHelper.ts';
import { TransformControls } from '../upstream/engine/TransformControls.js';
import { PoseGuard, segmentDistance } from './pose-guard.js';
import { RagdollIK } from './ragdoll-ik.js';
import { FemaleForm } from './female-form.js';

const $ = (id) => document.getElementById(id);
const viewport = $('viewport');
const scene = new THREE.Scene();
scene.background = new THREE.Color('#181c20');
scene.fog = new THREE.Fog('#181c20', 9, 24);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.domElement.setAttribute('aria-label', '3D character controls');
viewport.prepend(renderer.domElement);
const camera = new THREE.PerspectiveCamera(36, 1, 0.01, 100);

let model, allBones = [], initialState, mode = 'translate', selectedBone = '';
let dragStart, pointerStart, pointerCurrent, pointerWasDrag = false, skeleton;
let poseGuard, ragdollIK, femaleForm, spaceHeld = false, ragdollSession = null, ragdollDepth = 0;
let lastRenderedDataUrl = '';
let lastPointerDownTime = 0, gestureStartBone = '', gestureStartRings = false;
const collisionHighlights = new Set();
const ragdollChain = new Set();
const markerRaycaster = new THREE.Raycaster();
const jointNames = {
  Hips: 'Pelvis', Spine: 'Lower back', Spine1: 'Mid back', Spine2: 'Chest', Neck: 'Neck', Head: 'Head',
  LeftShoulder: 'Left collarbone', RightShoulder: 'Right collarbone',
  LeftArm: 'Left shoulder', RightArm: 'Right shoulder',
  LeftForeArm: 'Left elbow', RightForeArm: 'Right elbow',
  LeftHand: 'Left wrist', RightHand: 'Right wrist',
  LeftUpLeg: 'Left hip', RightUpLeg: 'Right hip',
  LeftLeg: 'Left knee', RightLeg: 'Right knee',
  LeftFoot: 'Left ankle', RightFoot: 'Right ankle',
  LeftToeBase: 'Left toes', RightToeBase: 'Right toes',
};
const undo = [], redo = [];
// Register transform handlers before OrbitControls so a handle drag can disable
// orbit before its pointerdown handler runs.
const transform = new TransformControls(camera, renderer.domElement);
transform.setSize(0.8);
scene.add(transform);
const fk = new FKHelper({ camera, domElement: renderer.domElement, scene, onDragChange: onDragging });
// These TS-private members remain JS properties. This small adapter is tied to
// the same pinned upstream revision as the CLI; upstream sources stay untouched.
const jointControl = fk.transformControls;
jointControl.setSize(0.65);
jointControl.enabled = false;
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.minDistance = 0.45;
orbit.maxDistance = 20;
orbit.maxPolarAngle = Math.PI * 0.495;
transform.addEventListener('dragging-changed', (event) => onDragging(event.value));
for (const control of [transform, jointControl]) control.addEventListener('objectChange', onObjectChange);

const hemi = new THREE.HemisphereLight('#dbe8ff', '#57452f', 2.0);
scene.add(hemi);
const key = new THREE.DirectionalLight('#fff2db', 3.8);
key.position.set(3, 6, 4);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6 });
key.shadow.normalBias = 0.015;
scene.add(key);
const rim = new THREE.DirectionalLight('#9cbcd4', 2.4);
rim.position.set(-3, 4, -2);
scene.add(rim);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: '#262c31', roughness: 0.92 }));
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.02;
floor.receiveShadow = true;
scene.add(floor);
const grid = new THREE.GridHelper(30, 60, '#4a555e', '#343c43');
grid.position.y = -0.017;
scene.add(grid);

function resize() {
  const width = viewport.clientWidth, height = viewport.clientHeight;
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);
resize();
renderer.setAnimationLoop(() => { orbit.update(); resizeJointTargets(); renderer.render(scene, camera); });

function message(text) { $('status').textContent = text; }
function alias(name) { return name.replace(/^mixamorig[:_]?/i, ''); }
function relaxFingers() {
  // Both hands use local +Z toward the palm, so +X bends each phalanx inward.
  const bends = {
    Thumb: [4, 8, 6], Index: [8, 14, 8], Middle: [10, 16, 9],
    Ring: [12, 18, 10], Pinky: [14, 20, 10],
  };
  for (const bone of allBones) {
    const finger = /^(?:Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)([1-3])$/.exec(alias(bone.name));
    if (finger) bone.rotateX(THREE.MathUtils.degToRad(bends[finger[1]][Number(finger[2]) - 1]));
  }
}
function readable(name) { return jointNames[alias(name)] || alias(name).replace(/([a-z])([A-Z])/g, '$1 $2'); }
function activeObject() { return mode === 'pose' ? jointControl.object : model; }
function snapshot() {
  return [model, ...allBones].map(object => ({ p: object.position.toArray(), q: object.quaternion.toArray(), s: object.scale.toArray() }));
}
function restore(state) {
  [model, ...allBones].forEach((object, index) => {
    object.position.fromArray(state[index].p);
    object.quaternion.fromArray(state[index].q);
    object.scale.fromArray(state[index].s);
  });
  model.updateMatrixWorld(true);
  refreshFields();
}
function record(before) {
  if (!before || JSON.stringify(before) === JSON.stringify(snapshot())) return;
  undo.push(before);
  if (undo.length > 60) undo.shift();
  redo.length = 0;
  refreshHistory();
}
function refreshHistory() { $('undo').disabled = !undo.length; $('redo').disabled = !redo.length; }
function onDragging(dragging) {
  orbit.enabled = !dragging;
  if (dragging) { dragStart = snapshot(); pointerWasDrag = true; }
  else {
    if (mode === 'pose' && dragStart) settlePose(dragStart, [jointControl.object?.name].filter(Boolean));
    record(dragStart); dragStart = null; refreshFields();
  }
}
function onObjectChange() {
  // Upstream uniform scaling divides by the initial distance from the pivot,
  // which can explode when grabbing its center. Use steady screen-distance
  // sensitivity for that one handle while keeping upstream picking/dragging.
  if (mode === 'scale' && transform.axis === 'XYZ' && dragStart && pointerStart && pointerCurrent) {
    const delta = (pointerCurrent.x - pointerStart.x) - (pointerCurrent.y - pointerStart.y);
    const factor = Math.exp(THREE.MathUtils.clamp(delta * 0.005, -2, 2));
    model.scale.fromArray(dragStart[0].s).multiplyScalar(factor);
  }
  if (mode === 'scale') {
    for (const axis of ['x', 'y', 'z']) {
      if ($('snap').checked) model.scale[axis] = Math.round(model.scale[axis] * 10) / 10;
      model.scale[axis] = Math.max(0.05, model.scale[axis]);
    }
  }
  model?.updateMatrixWorld(true);
  refreshFields();
  if (mode === 'pose') previewCollisions();
}
function isRagdollActive() { return mode === 'pose' && (spaceHeld || !$('rings')?.checked); }
function paintJointMarkers() {
  const ragdoll = isRagdollActive();
  const fineTune = mode === 'pose' && !ragdoll && !!selectedBone;
  const showMarkers = $('joint-markers') ? $('joint-markers').checked : true;
  for (const marker of fk.targetBoneSpheres) {
    const name = marker.parent.name, clean = alias(name);
    const chosen = name === selectedBone;
    const following = ragdollChain.has(clean);
    marker.material.visible = showMarkers || (fineTune && chosen);
    marker.material.opacity = !marker.material.visible ? 0 : (chosen ? 1 : fineTune ? 0.16 : following ? 0.94 : ragdoll ? 0.84 : 0.68);
    marker.material.color.set(
      collisionHighlights.has(name) ? '#ff7969'
        : chosen ? (fineTune ? '#7fffe0' : '#fff1c9')
        : following ? '#7fd8be'
        : ragdoll ? '#edd08a'
        : '#dfaa61',
    );
  }
}
function previewCollisions() {
  if (!poseGuard) return;
  collisionHighlights.clear();
  const status = $('guard-status');
  if (!$('collision-guard').checked) {
    status.textContent = 'Free posing · collision guard is off.'; status.dataset.state = 'off'; paintJointMarkers(); return;
  }
  const collisions = poseGuard.collisions(), limits = poseGuard.limitViolations();
  for (const contact of collisions) for (const part of contact.parts) {
    const capsule = poseGuard.capsules.find(item => item.name === part);
    collisionHighlights.add(capsule.from.name); collisionHighlights.add(capsule.to.name);
  }
  status.dataset.state = collisions.length || limits.length ? 'overlap' : 'clear';
  status.textContent = collisions.length ? `${collisions[0].parts.join(' / ')} overlap · release to adjust.` : limits.length ? `${readable(limits[0])} exceeds its joint limit · release to adjust.` : 'Pose is clear. Checks use approximate body volumes.';
  paintJointMarkers();
}
function settlePose(before, names = []) {
  if (!poseGuard || !$('collision-guard').checked) { previewCollisions(); return; }
  const result = poseGuard.resolve({ names, previous: before?.slice(1) });
  collisionHighlights.clear(); paintJointMarkers();
  const status = $('guard-status');
  status.dataset.state = result.corrected ? 'adjusted' : 'clear';
  status.textContent = result.contacts.length
    ? result.fallback ? 'Returned to the last clear pose.' : 'Adjusted to a nearby clear pose.'
    : result.limited.length ? 'Adjusted to the mannequin’s joint limits.' : 'Pose is clear. Checks use approximate body volumes.';
  refreshFields();
}
function clearFK() {
  for (const marker of fk.targetBoneSpheres) marker.material.dispose();
  fk.skeletonHelper?.dispose();
  fk.clear();
  fk.skeletonHelper = null;
}
function setupFK() {
  fk.setTarget(model);
  fk.skeletonHelper.visible = $('skeleton').checked;
  for (const marker of fk.targetBoneSpheres) {
    marker.material.color.set('#e3b875');
    marker.material.depthWrite = false;
    marker.renderOrder = 20;
  }
}
function resizeJointTargets() {
  if (mode !== 'pose' || !model) return;
  model.updateMatrixWorld(true);
  const position = new THREE.Vector3(), scale = new THREE.Vector3();
  const pxRadius = spaceHeld ? 11.5 : 10;
  for (const marker of fk.targetBoneSpheres) {
    marker.parent.getWorldPosition(position);
    marker.parent.getWorldScale(scale);
    // Keep hit targets about 10-11.5 pixels in radius at any zoom or character scale.
    const selectedScale = !isRagdollActive() && marker.parent.name === selectedBone ? 1.25 : 1;
    const radius = pxRadius * selectedScale * 2 * position.distanceTo(camera.position) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / viewport.clientHeight;
    marker.scale.setScalar(radius / 0.015).divide(scale);
  }
}
function syncJointSelection() {
  const ragdoll = isRagdollActive();
  const showRings = mode === 'pose' && !spaceHeld && $('rings').checked;
  document.body.dataset.ragdoll = String(ragdoll);
  paintJointMarkers();
  jointControl.visible = showRings && !!jointControl.object;
  jointControl.enabled = showRings;
  $('transform-controls').hidden = mode === 'pose' && !showRings;
  $('space-row').hidden = mode === 'pose' && !showRings;
  if ($('active-joint-name')) $('active-joint-name').textContent = selectedBone ? readable(selectedBone) : 'None';
  if ($('reset-joint')) $('reset-joint').disabled = !selectedBone;
  if (mode === 'pose') {
    $('mode-help').textContent = showRings
      ? 'Drag a colored rotation ring to fine-tune the highlighted joint. Double-click empty space to deselect, or hold Space for ragdoll.'
      : 'Drag any joint or body part so connected joints follow. Double-click a joint for rotation rings.';
  }
}
function chooseBone(name) {
  const marker = fk.targetBoneSpheres.find(item => item.parent.name === name);
  if (!marker) return;
  selectedBone = name;
  fk.highlightSphere(marker);
  fk.showControls(marker.parent);
  syncJointSelection();
  message(`${readable(name)} selected · drag any joint or hold Space to pull chain`);
  refreshFields();
}
function setMode(next) {
  if (!model || dragStart) return;
  clearFK();
  transform.detach();
  mode = next;
  document.body.dataset.mode = mode;
  transform.enabled = mode !== 'pose';
  jointControl.enabled = mode === 'pose';
  for (const button of document.querySelectorAll('[data-mode]')) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  $('pose-controls').hidden = mode !== 'pose';
  $('transform-controls').hidden = mode === 'pose' && !$('rings').checked;
  $('joint-tooltip').hidden = true;
  if (mode === 'pose') {
    setupFK();
    $('space').value = 'local';
    chooseBone(selectedBone || fk.targetBoneSpheres.find(marker => alias(marker.parent.name) === 'LeftHand')?.parent.name);
  } else {
    transform.setMode(mode);
    transform.attach(model);
    message('Whole character selected');
  }
  $('space').disabled = mode === 'scale';
  if (mode === 'scale') $('space').value = 'local';
  $('mode-help').textContent = {
    translate: 'Drag a colored arrow to move the mannequin.',
    rotate: 'Drag a colored ring to turn the whole figure.',
    scale: 'Drag the center handle to resize the whole figure.',
    pose: 'Drag any golden joint (or hold Space and drag the body) so connected joints follow.',
  }[mode];
  syncJointSelection();
  updateControls();
  refreshFields();
}
function updateControls() {
  const snap = $('snap').checked;
  transform.setSpace(mode === 'scale' ? 'local' : $('space').value);
  jointControl.setSpace($('space').value);
  transform.setTranslationSnap(snap ? 0.1 : null);
  transform.setScaleSnap(snap ? 0.1 : null);
  for (const control of [transform, jointControl]) control.setRotationSnap(snap ? Math.PI / 12 : null);
  skeleton.visible = mode !== 'pose' && $('skeleton').checked;
  if (fk.skeletonHelper) fk.skeletonHelper.visible = $('skeleton').checked;
}
function refreshFields() {
  const object = activeObject();
  const rotational = mode === 'rotate' || mode === 'pose';
  const label = rotational ? 'Rotation' : mode === 'scale' ? 'Scale' : 'Position';
  $('transform-label').textContent = mode === 'pose' ? 'Joint rotation (local)' : label;
  $('units').textContent = rotational ? 'degrees' : mode === 'scale' ? 'factor' : 'meters';
  for (const axis of ['x', 'y', 'z']) {
    const field = $(`axis-${axis}`);
    field.disabled = !object;
    field.step = rotational ? '5' : '0.05';
    field.setAttribute('aria-label', `${axis.toUpperCase()} ${label.toLowerCase()}`);
    if (document.activeElement === field) continue;
    const value = !object ? 0 : rotational ? THREE.MathUtils.radToDeg(object.rotation[axis]) : mode === 'scale' ? object.scale[axis] : object.position[axis];
    field.value = Number(value.toFixed(rotational ? 1 : 3));
  }
  if ($('active-joint-name') && selectedBone) $('active-joint-name').textContent = readable(selectedBone);
}
function restTransform(bone) { return initialState[allBones.indexOf(bone) + 1]; }
function rotateInCharacterSpace(name, axis, degrees) {
  const bone = allBones.find(item => alias(item.name) === name);
  model.updateMatrixWorld(true);
  const direction = new THREE.Vector3(...({ x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[axis]));
  direction.applyQuaternion(model.getWorldQuaternion(new THREE.Quaternion()));
  const delta = new THREE.Quaternion().setFromAxisAngle(direction, THREE.MathUtils.degToRad(degrees));
  const parent = bone.parent.getWorldQuaternion(new THREE.Quaternion());
  bone.quaternion.premultiply(parent.clone().invert().multiply(delta).multiply(parent));
}
function starterPose(name) {
  if (!model || !name) return;
  const before = snapshot();
  restore([before[0], ...initialState.slice(1)]);
  if (name === 'wave') {
    rotateInCharacterSpace('RightArm', 'z', -125);
    allBones.find(b => alias(b.name) === 'RightForeArm').rotateX(THREE.MathUtils.degToRad(-60));
    selectedBone = allBones.find(b => alias(b.name) === 'RightForeArm').name;
  } else if (name === 'open') {
    rotateInCharacterSpace('LeftArm', 'z', 55);
    rotateInCharacterSpace('RightArm', 'z', -55);
  } else if (name === 'reach') {
    rotateInCharacterSpace('LeftArm', 'x', -65);
    rotateInCharacterSpace('RightArm', 'x', -65);
    for (const side of ['Left', 'Right']) allBones.find(b => alias(b.name) === `${side}ForeArm`).rotateX(THREE.MathUtils.degToRad(-25));
  } else if (name === 'crossed' && ragdollIK) {
    const rad = THREE.MathUtils.degToRad;
    const bone = short => allBones.find(b => alias(b.name) === short);
    bone('LeftShoulder').rotateZ(rad(18));
    bone('RightShoulder').rotateZ(rad(-18));
    model.updateMatrixWorld(true);
    const solL = ragdollIK.solveTwoBoneLimb({
      rootBone: bone('LeftArm'),
      midBone: bone('LeftForeArm'),
      endBone: bone('LeftHand'),
      targetWorld: new THREE.Vector3(-0.04, 1.26, 0.175).applyMatrix4(model.matrixWorld),
      side: 'Left',
      isLeg: false,
      prevMidWorld: new THREE.Vector3(0.24, 1.18, 0.08).applyMatrix4(model.matrixWorld),
      avoidBody: true,
    });
    if (solL) {
      bone('LeftArm').quaternion.copy(solL.rootQ);
      bone('LeftForeArm').quaternion.copy(solL.midQ);
    }
    const solR = ragdollIK.solveTwoBoneLimb({
      rootBone: bone('RightArm'),
      midBone: bone('RightForeArm'),
      endBone: bone('RightHand'),
      targetWorld: new THREE.Vector3(0.055, 1.135, 0.255).applyMatrix4(model.matrixWorld),
      side: 'Right',
      isLeg: false,
      prevMidWorld: new THREE.Vector3(-0.24, 1.16, 0.12).applyMatrix4(model.matrixWorld),
      avoidBody: true,
    });
    if (solR) {
      bone('RightArm').quaternion.copy(solR.rootQ);
      bone('RightForeArm').quaternion.copy(solR.midQ);
    }
    bone('LeftHand').rotateX(rad(-18));
    bone('RightHand').rotateX(rad(-22));
    selectedBone = bone('RightHand').name;
  } else if (name === 'behind' && ragdollIK) {
    for (const [side, x] of [['Left', 0.03], ['Right', -0.03]]) {
      const session = ragdollIK.beginDrag(`${side}Hand`);
      const localTarget = new THREE.Vector3(x, 1.18, -0.06).applyMatrix4(model.matrixWorld);
      for (let i = 1; i <= 12; i++) ragdollIK.solve(`${side}Hand`, session.startWorld.clone().lerp(localTarget, i / 12), session, { avoidBody: true, preferBehind: -1 });
    }
    selectedBone = allBones.find(b => alias(b.name) === 'LeftHand').name;
  } else if (name === 'kneel' && ragdollIK) {
    const session = ragdollIK.beginDrag('Spine2');
    const localTarget = session.startLocal.clone().add(new THREE.Vector3(0, -0.48, 0)).applyMatrix4(model.matrixWorld);
    for (let i = 1; i <= 16; i++) ragdollIK.solve('Spine2', session.startWorld.clone().lerp(localTarget, i / 16), session, { avoidBody: true });
    selectedBone = allBones.find(b => alias(b.name) === 'Spine2').name;
  } else if (name === 'laying') {
    const rad = THREE.MathUtils.degToRad;
    const bone = short => allBones.find(b => alias(b.name) === short);
    const hips = bone('Hips');
    hips.position.set(0, 0.115, -0.06);
    hips.quaternion.setFromEuler(new THREE.Euler(rad(-88), 0, 0, 'XYZ'));
    bone('Spine').rotateX(rad(3));
    bone('Spine1').rotateX(rad(4));
    bone('Spine2').rotateX(rad(5));
    bone('Neck').rotateX(rad(10));
    bone('Head').rotateX(rad(10));
    bone('RightUpLeg').quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(rad(4), rad(-6), rad(-4), 'XYZ')));
    bone('RightLeg').rotateX(rad(-10));
    bone('RightFoot').rotateX(rad(20));
    bone('LeftUpLeg').quaternion.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(rad(24), rad(10), rad(7), 'XYZ')));
    bone('LeftLeg').rotateX(rad(-46));
    bone('LeftFoot').rotateX(rad(24));
    for (const [side, s] of [['Left', 1], ['Right', -1]]) {
      const arm = bone(`${side}Arm`);
      const foreArm = bone(`${side}ForeArm`);
      arm.rotateZ(rad(s * 12));
      arm.rotateX(rad(-2));
      foreArm.rotateX(rad(-12));
    }
    selectedBone = bone('LeftLeg').name;
  }
  model.updateMatrixWorld(true);
  settlePose(before);
  if (mode === 'pose') chooseBone(selectedBone);
  refreshFields(); record(before); frame();
  message('Starter pose applied · adjust any joint');
}
function computeCenteredCameraPlacement(viewDirection, aspect = camera.aspect, marginFactor = 1.35) {
  model.updateMatrixWorld(true);
  const dir = viewDirection.clone().normalize();
  const worldUp = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(worldUp, dir);
  if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
  else right.normalize();
  const up = new THREE.Vector3().crossVectors(dir, right).normalize();

  const points = [];
  const p = new THREE.Vector3();
  if (allBones.length) {
    for (const b of allBones) {
      b.getWorldPosition(p);
      const name = alias(b.name);
      const pad = /Head/.test(name) ? 0.11 : /Hips|Spine/.test(name) ? 0.12 : 0.065;
      points.push({ pos: p.clone(), pad });
    }
  } else {
    const box = new THREE.Box3().setFromObject(model);
    points.push({ pos: box.min.clone(), pad: 0.05 }, { pos: box.max.clone(), pad: 0.05 });
  }

  const origin = new THREE.Vector3();
  for (const item of points) origin.add(item.pos);
  origin.divideScalar(Math.max(1, points.length));

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, maxZ = -Infinity;
  const rel = new THREE.Vector3();
  for (const item of points) {
    rel.subVectors(item.pos, origin);
    const rx = rel.dot(right);
    const ry = rel.dot(up);
    const rz = rel.dot(dir);
    minX = Math.min(minX, rx - item.pad);
    maxX = Math.max(maxX, rx + item.pad);
    minY = Math.min(minY, ry - item.pad);
    maxY = Math.max(maxY, ry + item.pad);
    maxZ = Math.max(maxZ, rz + item.pad);
  }

  const midX = (minX + maxX) * 0.5;
  const midY = (minY + maxY) * 0.5;
  const halfW = Math.max(0.15, (maxX - minX) * 0.5);
  const halfH = Math.max(0.15, (maxY - minY) * 0.5);

  const target = origin.clone()
    .addScaledVector(right, midX)
    .addScaledVector(up, midY);

  const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
  const distY = halfH / tanHalfFov;
  const distX = halfW / (tanHalfFov * Math.max(0.2, aspect));
  const distance = Math.max(distX, distY) * marginFactor + Math.max(0, maxZ * 0.35);
  const position = target.clone().addScaledVector(dir, distance);
  return { target, position };
}

function frame(front = false) {
  if (!model) return;
  model.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const pos = new THREE.Vector3();
  for (const b of allBones) box.expandByPoint(b.getWorldPosition(pos));
  const size = box.getSize(new THREE.Vector3());
  const isHorizontal = size.y < Math.max(size.x, size.z) * 0.65;
  const direction = front
    ? (isHorizontal ? new THREE.Vector3(0, 0.72, 0.68) : new THREE.Vector3(0, 0.04, 1))
    : (isHorizontal ? new THREE.Vector3(0.68, 0.46, 0.58) : new THREE.Vector3(0.4, 0.16, 1));
  const { target, position } = computeCenteredCameraPlacement(direction, camera.aspect, 1.38);
  orbit.target.copy(target);
  camera.position.copy(position);
  orbit.update();
}
function download(data, filename, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function withoutHelpers(action) {
  const posing = mode === 'pose';
  if (posing) clearFK();
  try { return femaleForm ? femaleForm.withoutCosmetics(action) : action(); }
  finally { if (posing) { setupFK(); chooseBone(selectedBone); } }
}
function applyStudioClarityPass(ctx, width, height) {
  const srcData = ctx.getImageData(0, 0, width, height);
  const dstData = ctx.createImageData(width, height);
  const src = srcData.data;
  const dst = dstData.data;
  dst.set(src);

  const stride = width * 4;
  const step = 2;
  for (let y = step; y < height - step; y++) {
    let row = y * stride + step * 4;
    for (let x = step; x < width - step; x++, row += 4) {
      const r = src[row], g = src[row + 1], b = src[row + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      // Skip flat dark studio background pixels
      if (lum < 34) continue;

      const idxN = row - step * stride;
      const idxS = row + step * stride;
      const idxW = row - step * 4;
      const idxE = row + step * 4;

      const lumN = 0.299 * src[idxN] + 0.587 * src[idxN + 1] + 0.114 * src[idxN + 2];
      const lumS = 0.299 * src[idxS] + 0.587 * src[idxS + 1] + 0.114 * src[idxS + 2];
      const lumW = 0.299 * src[idxW] + 0.587 * src[idxW + 1] + 0.114 * src[idxW + 2];
      const lumE = 0.299 * src[idxE] + 0.587 * src[idxE + 1] + 0.114 * src[idxE + 2];

      const avg = 0.25 * (lumN + lumS + lumW + lumE);
      const diff = lum - avg;
      const grad = Math.abs(lumN - lumS) + Math.abs(lumW - lumE);

      // Subtle unsharp micro-contrast (zero net darkening)
      const boost = diff * 0.28;

      dst[row] = Math.max(0, Math.min(255, r + boost));
      dst[row + 1] = Math.max(0, Math.min(255, g + boost));
      dst[row + 2] = Math.max(0, Math.min(255, b + boost));
    }
  }
  ctx.putImageData(dstData, 0, 0);
}

function renderStudioImage({
  femaleMode = $('render-female-form')?.checked ?? true,
  finish = $('render-finish')?.value || (femaleMode ? 'studio' : 'mannequin'),
  width = 1600,
  height = 1200,
} = {}) {
  if (!model) return '';
  const prevFemale = femaleForm?.enabled ?? false;
  const prevFinish = femaleForm?.finish ?? 'mannequin';
  const prevGrid = grid.visible;
  const prevSkel = skeleton.visible;
  const prevFkSkel = fk.skeletonHelper ? fk.skeletonHelper.visible : false;
  const prevTransform = transform.visible;
  const prevJointControl = jointControl.visible;
  const prevSphereVis = fk.targetBoneSpheres.map(s => s.visible);
  const prevBg = scene.background.clone();
  const prevFogNear = scene.fog.near, prevFogFar = scene.fog.far, prevFogColor = scene.fog.color.clone();
  const prevFloorColor = floor.material.color.clone(), prevFloorRoughness = floor.material.roughness;
  const prevHemiIntensity = hemi.intensity;
  const prevKeyIntensity = key.intensity, prevRimIntensity = rim.intensity;
  const prevExposure = renderer.toneMappingExposure;
  const prevPixelRatio = renderer.getPixelRatio();
  const prevSize = renderer.getSize(new THREE.Vector2());
  const prevAspect = camera.aspect;
  const prevCamPos = camera.position.clone();
  const prevCamQuat = camera.quaternion.clone();
  const prevOrbitTarget = orbit.target.clone();

  try {
    if (femaleForm) {
      const effectiveFinish = !femaleMode ? 'mannequin' : (finish === 'mannequin' ? 'studio' : finish);
      femaleForm.setEnabled(femaleMode, effectiveFinish);
    }
    grid.visible = false;
    skeleton.visible = false;
    if (fk.skeletonHelper) fk.skeletonHelper.visible = false;
    transform.visible = false;
    jointControl.visible = false;
    for (const s of fk.targetBoneSpheres) s.visible = false;

    // Keep the exact same scene brightness, lighting, background, and floor as the live posing viewport
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();

    // Automatically center and frame the posed character along the current viewing angle
    const viewDir = prevCamPos.clone().sub(prevOrbitTarget);
    if (viewDir.lengthSq() < 1e-6) viewDir.set(0.4, 0.16, 1);
    const centered = computeCenteredCameraPlacement(viewDir, width / height, 1.32);
    camera.position.copy(centered.position);
    camera.lookAt(centered.target);
    camera.updateMatrixWorld(true);
    model.updateMatrixWorld(true);
    renderer.render(scene, camera);

    const outCanvas = document.createElement('canvas');
    outCanvas.width = width;
    outCanvas.height = height;
    const ctx = outCanvas.getContext('2d');
    ctx.drawImage(renderer.domElement, 0, 0, width, height);

    applyStudioClarityPass(ctx, width, height);

    lastRenderedDataUrl = outCanvas.toDataURL('image/png');
    if ($('render-preview')) $('render-preview').src = lastRenderedDataUrl;
    return lastRenderedDataUrl;
  } finally {
    if (femaleForm) femaleForm.setEnabled(prevFemale, prevFinish);
    grid.visible = prevGrid;
    skeleton.visible = prevSkel;
    if (fk.skeletonHelper) fk.skeletonHelper.visible = prevFkSkel;
    transform.visible = prevTransform;
    jointControl.visible = prevJointControl;
    fk.targetBoneSpheres.forEach((s, i) => { s.visible = prevSphereVis[i]; });
    scene.background.copy(prevBg);
    scene.fog.color.copy(prevFogColor);
    scene.fog.near = prevFogNear;
    scene.fog.far = prevFogFar;
    floor.material.color.copy(prevFloorColor);
    floor.material.roughness = prevFloorRoughness;
    hemi.intensity = prevHemiIntensity;
    key.intensity = prevKeyIntensity;
    rim.intensity = prevRimIntensity;
    renderer.toneMappingExposure = prevExposure;
    renderer.setPixelRatio(prevPixelRatio);
    renderer.setSize(prevSize.x, prevSize.y);
    camera.aspect = prevAspect;
    camera.position.copy(prevCamPos);
    camera.quaternion.copy(prevCamQuat);
    orbit.target.copy(prevOrbitTarget);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    renderer.render(scene, camera);
  }
}
function validateBoneTree(expected, actual) {
  if (!actual || expected.type !== actual.type || expected.name !== actual.name) throw new Error('This pose belongs to a different skeleton.');
  if (!Array.isArray(actual.matrix) || actual.matrix.length !== 16 || !actual.matrix.every(Number.isFinite)) throw new Error('The pose contains an invalid bone transform.');
  const children = expected.children || [], other = actual.children || [];
  if (children.length !== other.length) throw new Error('This pose has a different bone hierarchy.');
  children.forEach((child, i) => validateBoneTree(child, other[i]));
}

for (const button of document.querySelectorAll('[data-mode]')) button.onclick = () => setMode(button.dataset.mode);
for (const id of ['space', 'snap', 'skeleton']) $(id).onchange = updateControls;
$('rings').onchange = () => {
  if ($('rings').checked && !jointControl.object) {
    chooseBone(fk.targetBoneSpheres.find(marker => alias(marker.parent.name) === 'LeftHand')?.parent.name);
  }
  syncJointSelection();
};
if ($('joint-markers')) {
  $('joint-markers').onchange = () => {
    paintJointMarkers();
    message($('joint-markers').checked ? 'Joint markers visible' : 'Joint markers hidden · drag any body part to pose');
  };
}
if ($('female-form')) {
  $('female-form').onchange = () => {
    const enabled = $('female-form').checked;
    const finish = enabled ? ($('render-finish')?.value === 'mannequin' ? 'studio' : ($('render-finish')?.value || 'studio')) : 'mannequin';
    femaleForm?.setEnabled(enabled, finish);
    if ($('render-female-form')) $('render-female-form').checked = enabled;
    if ($('render-finish')) $('render-finish').value = finish;
    message(enabled ? 'Soft female form active' : 'Classic jointed mannequin active');
  };
}
$('collision-guard').onchange = () => { const before = snapshot(); settlePose(before); record(before); };
$('reset-joint').onclick = () => {
  const bone = activeObject(); if (!bone || mode !== 'pose') return;
  const before = snapshot();
  bone.position.fromArray(restTransform(bone).p);
  bone.quaternion.fromArray(restTransform(bone).q);
  model.updateMatrixWorld(true); settlePose(before, [bone.name]); refreshFields(); record(before); message(`${readable(bone.name)} reset`);
};
$('starter-pose').onchange = () => { starterPose($('starter-pose').value); $('starter-pose').value = ''; };
for (const axis of ['x', 'y', 'z']) $(`axis-${axis}`).onchange = (event) => {
  const object = activeObject(), value = event.target.valueAsNumber;
  if (!object || !Number.isFinite(value) || (mode === 'scale' && value <= 0)) { event.target.blur(); refreshFields(); return; }
  const before = snapshot();
  if (mode === 'rotate' || mode === 'pose') object.rotation[axis] = THREE.MathUtils.degToRad(value);
  else if (mode === 'scale') object.scale[axis] = value;
  else object.position[axis] = value;
  model.updateMatrixWorld(true); record(before); event.target.blur(); refreshFields();
};
$('undo').onclick = () => { if (undo.length && !dragStart) { redo.push(snapshot()); restore(undo.pop()); refreshHistory(); previewCollisions(); message('Undone'); } };
$('redo').onclick = () => { if (redo.length && !dragStart) { undo.push(snapshot()); restore(redo.pop()); refreshHistory(); previewCollisions(); message('Redone'); } };
$('reset').onclick = () => { const before = snapshot(); restore(initialState); settlePose(before); record(before); frame(); message('Figure reset · Undo to restore your pose'); };
$('frame').onclick = () => frame();
$('front').onclick = () => frame(true);
$('save-pose').onclick = () => {
  try {
    const bones = withoutHelpers(() => new BoneJSONHelper(model).toJSON());
    if (!bones) throw new Error('The mannequin skeleton could not be saved.');
    const data = { format: 'artcraft-local-pose', version: 1, character: 'female-doll', transform: snapshot()[0], bones };
    download(JSON.stringify(data, null, 2), 'female-mannequin.pose.json', 'application/json');
    message('Pose downloaded');
  } catch (error) { message(error.message); }
};
$('load-pose').onclick = () => $('pose-file').click();
$('pose-file').onchange = async (event) => {
  const file = event.target.files[0]; if (!file) return;
  const before = snapshot();
  try {
    const data = JSON.parse(await file.text());
    if (data.format !== 'artcraft-local-pose' || data.version !== 1 || data.character !== 'female-doll') throw new Error('Choose a female mannequin pose saved by this viewer.');
    const t = data.transform;
    for (const [key, length] of [['p', 3], ['q', 4], ['s', 3]]) if (!Array.isArray(t?.[key]) || t[key].length !== length || !t[key].every(Number.isFinite)) throw new Error('Invalid character transform.');
    if (t.s.some(x => x <= 0) || Math.abs(Math.hypot(...t.q) - 1) > 0.001) throw new Error('Invalid scale or orientation.');
    if (['images', 'textures', 'materials', 'geometries', 'animations'].some(key => data.bones?.[key]?.length)) throw new Error('A pose must contain only bone transforms.');
    withoutHelpers(() => {
      validateBoneTree(new BoneJSONHelper(model).toJSON().object, data.bones?.object);
      new BoneJSONHelper(model).poseFromBoneJSON(data.bones);
      model.position.fromArray(t.p); model.quaternion.fromArray(t.q); model.scale.fromArray(t.s);
    });
    model.updateMatrixWorld(true); settlePose(before); record(before); refreshFields(); frame(); message('Pose loaded');
  } catch (error) { restore(before); message(error.message); }
  finally { event.target.value = ''; }
};
$('export-glb').onclick = async () => {
  $('export-glb').disabled = true;
  try {
    // Clone after removing temporary joint markers; export includes only the rig.
    const copy = withoutHelpers(() => clone(model));
    copy.animations = [];
    const data = await new GLTFExporter().parseAsync(copy, { binary: true, animations: [], onlyVisible: true });
    download(data, 'female-mannequin-posed.glb', 'model/gltf-binary'); message('Posed model downloaded');
  } catch (error) { message(`Export failed: ${error.message}`); }
  finally { $('export-glb').disabled = false; }
};
if ($('render-image')) {
  $('render-image').onclick = () => {
    if (!model) return;
    const modal = $('render-modal');
    const useFemale = $('female-form') ? $('female-form').checked : true;
    if ($('render-female-form')) $('render-female-form').checked = useFemale;
    if ($('render-finish')) {
      if (!useFemale) $('render-finish').value = 'mannequin';
      else if ($('render-finish').value === 'mannequin') $('render-finish').value = 'studio';
    }
    renderStudioImage({
      femaleMode: $('render-female-form')?.checked ?? true,
      finish: $('render-finish')?.value || (useFemale ? 'studio' : 'mannequin'),
    });
    if (modal && typeof modal.showModal === 'function' && !modal.open) modal.showModal();
    message('Studio image rendered · switch Finish or download PNG');
  };
}
if ($('render-female-form')) {
  $('render-female-form').onchange = () => {
    const enabled = $('render-female-form').checked;
    if ($('female-form')) $('female-form').checked = enabled;
    if ($('render-finish')) {
      if (!enabled) $('render-finish').value = 'mannequin';
      else if ($('render-finish').value === 'mannequin') $('render-finish').value = 'studio';
    }
    const finish = $('render-finish')?.value || (enabled ? 'studio' : 'mannequin');
    femaleForm?.setEnabled(enabled, finish);
    renderStudioImage({ femaleMode: enabled, finish });
  };
}
if ($('render-finish')) {
  $('render-finish').onchange = () => {
    const finish = $('render-finish').value;
    const enabled = finish !== 'mannequin';
    if ($('render-female-form')) $('render-female-form').checked = enabled;
    if ($('female-form')) $('female-form').checked = enabled;
    femaleForm?.setEnabled(enabled, finish);
    renderStudioImage({ femaleMode: enabled, finish });
  };
}
if ($('download-render')) {
  $('download-render').onclick = () => {
    const dataUrl = lastRenderedDataUrl || renderStudioImage();
    if (!dataUrl) return;
    const a = document.createElement('a');
    a.href = dataUrl;
    const suffix = ($('render-female-form')?.checked ?? true) ? 'female-form' : 'mannequin';
    a.download = `pose-render-${suffix}.png`;
    a.click();
    message('Rendered PNG downloaded');
  };
}
if ($('close-render')) {
  $('close-render').onclick = () => $('render-modal')?.close();
}
if ($('render-modal')) {
  $('render-modal').addEventListener('click', (event) => {
    if (event.target === $('render-modal')) $('render-modal').close();
  });
}

function setRayFromPointer(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  markerRaycaster.setFromCamera(
    new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1),
    camera,
  );
  return rect;
}

function pickRagdollBone(clientX, clientY, allowMeshHit = spaceHeld || ($('joint-markers') && !$('joint-markers').checked)) {
  const rect = setRayFromPointer(clientX, clientY);
  const direct = markerRaycaster.intersectObjects(fk.targetBoneSpheres, false)[0];
  if (direct) return direct.object.parent;

  // Allow grabbing near a joint marker in screen space
  const projected = new THREE.Vector3();
  let nearestMarker = null, minPx = allowMeshHit ? 24 : 16;
  for (const marker of fk.targetBoneSpheres) {
    marker.parent.getWorldPosition(projected).project(camera);
    if (projected.z < -1 || projected.z > 1) continue;
    const sx = rect.left + (projected.x * 0.5 + 0.5) * rect.width;
    const sy = rect.top + (-projected.y * 0.5 + 0.5) * rect.height;
    const dist = Math.hypot(clientX - sx, clientY - sy);
    if (dist < minPx) { minPx = dist; nearestMarker = marker.parent; }
  }
  if (nearestMarker) return nearestMarker;
  if (!allowMeshHit) return null;

  // When holding Space or when joint markers are hidden, clicking directly on a body part picks the nearest selectable bone
  const meshHit = markerRaycaster.intersectObject(model, true).find(h => h.object.isMesh && h.object.name !== '__FKHelperSphere__');
  if (meshHit) {
    let bestBone = null, bestDist = Infinity;
    const pos = new THREE.Vector3();
    for (const marker of fk.targetBoneSpheres) {
      const d = marker.parent.getWorldPosition(pos).distanceTo(meshHit.point);
      if (d < bestDist) { bestDist = d; bestBone = marker.parent; }
    }
    if (bestBone && bestDist < 0.25) return bestBone;
  }
  return null;
}

function startRagdollDrag(bone, event) {
  if (!ragdollIK || !bone) return;
  chooseBone(bone.name);
  ragdollSession = ragdollIK.beginDrag(bone.name);
  if (!ragdollSession) return;
  ragdollSession.pointerId = event.pointerId;
  ragdollSession.moved = false;
  ragdollSession.lastValidState = poseGuard.capture();
  ragdollDepth = 0;

  const camForward = camera.getWorldDirection(new THREE.Vector3());
  const modelQ = model.getWorldQuaternion(new THREE.Quaternion());
  const localCamDir = camForward.clone().applyQuaternion(modelQ.clone().invert());
  if (Math.abs(localCamDir.z) > 0.72) {
    const symNormal = new THREE.Vector3(0, localCamDir.y * 0.35, Math.sign(localCamDir.z)).normalize();
    ragdollSession.planeNormal = symNormal.applyQuaternion(modelQ).normalize();
  } else {
    ragdollSession.planeNormal = camForward.clone().normalize();
  }
  ragdollSession.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(ragdollSession.planeNormal, ragdollSession.startWorld);
  setRayFromPointer(event.clientX, event.clientY);
  const hitPoint = markerRaycaster.ray.intersectPlane(ragdollSession.plane, new THREE.Vector3());
  ragdollSession.grabOffset = hitPoint ? ragdollSession.startWorld.clone().sub(hitPoint) : new THREE.Vector3();
  ragdollSession.lastRayPoint = hitPoint ? hitPoint.clone() : ragdollSession.startWorld.clone();

  dragStart = snapshot();
  orbit.enabled = false;
  jointControl.enabled = false;
  $('joint-tooltip').hidden = true;
  renderer.domElement.style.cursor = 'grabbing';
  try { renderer.domElement.setPointerCapture(event.pointerId); } catch {}
}

function updateRagdollDrag(event) {
  if (!ragdollSession) return;
  if (event && Number.isFinite(event.clientX)) {
    setRayFromPointer(event.clientX, event.clientY);
    const hitPoint = markerRaycaster.ray.intersectPlane(ragdollSession.plane, new THREE.Vector3());
    if (hitPoint) ragdollSession.lastRayPoint.copy(hitPoint);
  }
  const rawTarget = ragdollSession.lastRayPoint
    .clone()
    .add(ragdollSession.grabOffset)
    .addScaledVector(ragdollSession.planeNormal, ragdollDepth);

  const invModel = model.matrixWorld.clone().invert();
  const localRaw = rawTarget.clone().applyMatrix4(invModel);
  let preferBehind = ragdollSession.preferBehind;
  if (event?.shiftKey) {
    preferBehind = -1;
  } else if (Math.abs(ragdollDepth) > 0.02) {
    preferBehind = localRaw.z <= 0.01 ? -1 : 1;
    ragdollSession.preferBehind = preferBehind;
  }

  const result = ragdollIK.solve(ragdollSession.boneName, rawTarget, ragdollSession, {
    avoidBody: $('collision-guard').checked,
    preferBehind,
  });
  ragdollChain.clear();
  for (const name of result.moved) ragdollChain.add(name);
  if (poseGuard.isValid()) ragdollSession.lastValidState = poseGuard.capture();

  refreshFields();
  previewCollisions();
  const count = Math.max(0, result.moved.length - 1);
  message(`Ragdoll pull: ${readable(ragdollSession.boneName)} · ${count} connected joint${count === 1 ? '' : 's'} following`);
}

function finishRagdollDrag() {
  if (!ragdollSession) return;
  const session = ragdollSession;
  const before = dragStart;
  try { renderer.domElement.releasePointerCapture(session.pointerId); } catch {}
  ragdollSession = null;
  dragStart = null;
  ragdollDepth = 0;
  const movedNames = [...ragdollChain];
  ragdollChain.clear();
  orbit.enabled = true;
  renderer.domElement.style.cursor = isRagdollActive() ? 'grab' : '';
  if (session.moved) {
    if ($('collision-guard').checked && !poseGuard.isValid()) {
      poseGuard.resolve({ names: movedNames, previous: session.lastValidState });
    }
    record(before);
    message(`${readable(session.boneName)} posed · connected joints adjusted`);
  }
  syncJointSelection();
  refreshFields();
  previewCollisions();
}

// Capture the gesture before any upstream listener can start a gizmo drag.
renderer.domElement.addEventListener('pointerdown', (event) => {
  const now = performance.now();
  if (now - lastPointerDownTime > 360) {
    gestureStartBone = selectedBone;
    gestureStartRings = Boolean($('rings')?.checked);
  }
  lastPointerDownTime = now;
  pointerStart = { x: event.clientX, y: event.clientY, button: event.button };
  pointerCurrent = pointerStart;
  pointerWasDrag = false;
  if (event.button !== 0 || !model) return;
  if (spaceHeld && mode !== 'pose' && !dragStart) setMode('pose');
  if (isRagdollActive()) {
    const picked = pickRagdollBone(event.clientX, event.clientY);
    if (picked) {
      startRagdollDrag(picked, event);
      event.stopImmediatePropagation();
    }
  }
}, true);
renderer.domElement.addEventListener('pointermove', (event) => {
  pointerCurrent = { x: event.clientX, y: event.clientY };
  const tooltip = $('joint-tooltip');
  if (ragdollSession) {
    if (!ragdollSession.moved && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) < 3) return;
    ragdollSession.moved = true;
    pointerWasDrag = true;
    updateRagdollDrag(event);
    event.stopImmediatePropagation();
    return;
  }
  if (mode !== 'pose' || dragStart || event.buttons || ($('rings').checked && jointControl.axis)) { tooltip.hidden = true; return; }
  const rect = setRayFromPointer(event.clientX, event.clientY);
  const hitBone = pickRagdollBone(event.clientX, event.clientY, spaceHeld || ($('joint-markers') && !$('joint-markers').checked));
  tooltip.hidden = !hitBone;
  renderer.domElement.style.cursor = hitBone ? (isRagdollActive() ? 'grab' : 'pointer') : 'grab';
  if (hitBone) {
    const label = readable(hitBone.name);
    tooltip.textContent = isRagdollActive()
      ? `${label} · drag to pull · double-click for rings`
      : `${label} · rotation rings · Space+drag for ragdoll`;
    tooltip.style.left = `${Math.min(event.clientX - rect.left + 15, rect.width - 220)}px`;
    tooltip.style.top = `${Math.max(8, event.clientY - rect.top - 36)}px`;
  }
}, true);
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  renderer.domElement.addEventListener(type, () => { if (ragdollSession) finishRagdollDrag(); }, true);
}
renderer.domElement.addEventListener('wheel', (event) => {
  if (!ragdollSession) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  ragdollSession.moved = true;
  pointerWasDrag = true;
  ragdollDepth = THREE.MathUtils.clamp(ragdollDepth + Math.sign(event.deltaY) * 0.035, -0.55, 0.55);
  updateRagdollDrag(event);
}, { capture: true, passive: false });
renderer.domElement.addEventListener('pointerleave', () => { $('joint-tooltip').hidden = true; });
renderer.domElement.addEventListener('click', (event) => {
  if (mode !== 'pose' || !pointerStart || pointerStart.button !== 0 || pointerWasDrag || Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 4) return;
  const rect = renderer.domElement.getBoundingClientRect();
  fk.onMouseClick(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1));
  if (jointControl.object) {
    selectedBone = jointControl.object.name;
    syncJointSelection();
    message(`${readable(selectedBone)} selected · drag any joint or double-click for rotation rings`);
  } else {
    const fallbackBone = pickRagdollBone(event.clientX, event.clientY, $('joint-markers') && !$('joint-markers').checked);
    if (fallbackBone) chooseBone(fallbackBone.name);
    else if (selectedBone) chooseBone(selectedBone);
  }
  $('joint-tooltip').hidden = true;
  refreshFields();
});
renderer.domElement.addEventListener('dblclick', (event) => {
  if (!model || dragStart) return;
  if (mode !== 'pose') setMode('pose');
  const picked = pickRagdollBone(event.clientX, event.clientY, true);
  if (!picked) {
    event.preventDefault();
    $('rings').checked = false;
    selectedBone = '';
    fk.removeControls();
    syncJointSelection();
    $('joint-tooltip').hidden = true;
    renderer.domElement.style.cursor = 'grab';
    refreshFields();
    message('Rotation deselected · drag any joint to pose');
    return;
  }
  event.preventDefault();
  const ringsInput = $('rings');
  if (ringsInput) {
    const alreadyActiveOnJoint = gestureStartRings && gestureStartBone === picked.name;
    ringsInput.checked = !alreadyActiveOnJoint;
  }
  chooseBone(picked.name);
  syncJointSelection();
  $('joint-tooltip').hidden = true;
  message(
    $('rings')?.checked
      ? `Fine-tune rotation rings active on ${readable(picked.name)} · double-click empty space to deselect`
      : `${readable(picked.name)} selected · ragdoll pull active`,
  );
});
addEventListener('keydown', (event) => {
  const tag = document.activeElement?.tagName;
  const isTextInput = (tag === 'INPUT' && document.activeElement.type === 'number') || tag === 'TEXTAREA';
  if (isTextInput || !model) return;
  if (event.code === 'Space') {
    event.preventDefault();
    if (!spaceHeld) {
      spaceHeld = true;
      if (mode !== 'pose' && !dragStart) setMode('pose');
      syncJointSelection();
      message('Ragdoll pull active (Space) · drag any joint or body part');
    }
    return;
  }
  if (tag === 'SELECT' || dragStart) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); $(event.shiftKey ? 'redo' : 'undo').click(); return; }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const next = { w: 'translate', e: 'rotate', r: 'scale', p: 'pose' }[event.key.toLowerCase()];
  if (next) { event.preventDefault(); setMode(next); }
  if (event.key.toLowerCase() === 'f') { event.preventDefault(); frame(); }
});
addEventListener('keyup', (event) => {
  if (event.code !== 'Space' || !spaceHeld) return;
  spaceHeld = false;
  if (!ragdollSession) {
    syncJointSelection();
    message(selectedBone ? `${readable(selectedBone)} selected · drag any joint to pull chain` : 'Ready');
  }
});
addEventListener('blur', () => {
  spaceHeld = false;
  if (ragdollSession) finishRagdollDrag();
  else if (model) syncJointSelection();
});

try {
  const gltf = await new GLTFLoader().loadAsync('./exports/mannequin-female-standing.glb');
  model = gltf.scene;
  model.name = 'Female mannequin';
  model.userData.isCharacter = true;
  model.traverse(object => {
    if (object.isBone) allBones.push(object);
    if (!object.isMesh) return;
    object.castShadow = true; object.receiveShadow = true;
    for (const material of [].concat(object.material)) {
      material.color.set(/joint/i.test(material.name) ? '#59616a' : '#d7cbb7');
      material.metalness = 0.12; material.roughness = 0.63;
    }
  });
  relaxFingers();
  scene.add(model); model.updateMatrixWorld(true);
  skeleton = new THREE.SkeletonHelper(model); skeleton.visible = false; scene.add(skeleton);
  initialState = snapshot();
  poseGuard = new PoseGuard(model, allBones);
  ragdollIK = new RagdollIK(model, allBones, poseGuard);
  femaleForm = new FemaleForm(model, allBones);
  femaleForm.setEnabled($('female-form') ? $('female-form').checked : true);
  setMode('pose'); frame();
  $('loading').hidden = true; document.body.dataset.ready = 'true';
  // Read-only inspection aid for local browser QA; editing still goes through UI.
  window.poseStudio = { model, camera, renderer, scene, transform, fk, snapshot, poseGuard, ragdollIK, femaleForm, renderStudioImage };
} catch (error) {
  $('loading').textContent = `Could not load the mannequin: ${error.message}`;
  document.body.dataset.error = error.message;
  console.error(error);
}
