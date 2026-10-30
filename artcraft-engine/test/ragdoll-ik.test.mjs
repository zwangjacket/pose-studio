import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Vector3, Quaternion } from 'three';
import { openSession, closeSession } from '../engine.mjs';
import { PoseGuard } from '../browser/pose-guard.js';
import { RagdollIK } from '../browser/ragdoll-ik.js';
import { FemaleForm } from '../browser/female-form.js';

const fixture = fileURLToPath(new URL('../../exports/mannequin-female-standing.glb', import.meta.url));

async function setup() {
  const session = await openSession(fixture);
  const bones = [];
  session.model.traverse(object => { if (object.isBone) bones.push(object); });
  const guard = new PoseGuard(session.model, bones);
  const ik = new RagdollIK(session.model, bones, guard);
  return { session, bones, guard, ik };
}

function changedBoneNames(bones, restState, threshold = 0.008) {
  return bones
    .filter((bone, i) => {
      const q0 = new Quaternion().fromArray(restState[i].q).normalize();
      const p0 = new Vector3().fromArray(restState[i].p);
      return q0.angleTo(bone.quaternion.clone().normalize()) > threshold || p0.distanceTo(bone.position) > 0.002;
    })
    .map(bone => bone.name.replace(/^mixamorig[:_]?/i, ''));
}

test('pulling hand upward adjusts forearm, shoulder, collarbone, and spine without collisions', async () => {
  const { session, bones, guard, ik } = await setup();
  try {
    const drag = ik.beginDrag('LeftHand');
    const target = new Vector3(0.28, 1.85, 0.05);
    for (let step = 1; step <= 20; step++) {
      ik.solve('LeftHand', drag.startWorld.clone().lerp(target, step / 20), drag);
      assert(guard.isValid(), `step ${step} should remain collision- and limit-free`);
    }
    const wrist = guard.byName.get('LeftHand').getWorldPosition(new Vector3());
    assert(wrist.distanceTo(target) < 0.02, `wrist reached ${wrist.toArray()}`);
    const changed = changedBoneNames(bones, guard.rest);
    for (const expected of ['LeftForeArm', 'LeftArm', 'LeftShoulder', 'Spine2']) {
      assert(changed.includes(expected), `expected ${expected} to follow hand pull, got: ${changed.join(', ')}`);
    }
  } finally {
    closeSession(session);
  }
});

test('pulling left or right hand behind the back wraps around torso and adjusts arm chain', async () => {
  const { session, bones, guard, ik } = await setup();
  try {
    for (const [handName, side, targetX] of [['LeftHand', 'Left', 0.02], ['RightHand', 'Right', -0.02]]) {
      guard.apply(guard.rest);
      const drag = ik.beginDrag(handName);
      const rawBehind = new Vector3(targetX, 1.20, -0.055);
      for (let step = 1; step <= 24; step++) {
        ik.solve(handName, drag.startWorld.clone().lerp(rawBehind, step / 24), drag, { avoidBody: true });
        assert(guard.isValid(), `${handName} step ${step} should remain valid`);
      }
      const wrist = guard.byName.get(handName).getWorldPosition(new Vector3());
      assert(wrist.z < -0.15, `expected ${handName} behind back (z < -0.15), got z=${wrist.z}`);
      assert(Math.abs(wrist.x - targetX) < 0.03, `expected ${handName} near spine x=${targetX}, got x=${wrist.x}`);
      const changed = changedBoneNames(bones, guard.rest);
      for (const expected of [`${side}ForeArm`, `${side}Arm`, `${side}Shoulder`, 'Spine2']) {
        assert(changed.includes(expected), `expected ${expected} to follow ${handName} behind back`);
      }
    }
  } finally {
    closeSession(session);
  }
});

test('pulling elbow, foot, knee, head, and pelvis adjusts connected chains cleanly', async () => {
  const { session, bones, guard, ik } = await setup();
  try {
    // 1. Elbow pull
    let drag = ik.beginDrag('RightForeArm');
    const elbowTarget = new Vector3(-0.42, 1.48, 0.14);
    for (let i = 1; i <= 15; i++) ik.solve('RightForeArm', drag.startWorld.clone().lerp(elbowTarget, i / 15), drag);
    assert(guard.isValid());
    let changed = changedBoneNames(bones, guard.rest);
    assert(changed.includes('RightArm') && changed.includes('RightShoulder'));

    // 2. Foot pull (bends knee and hip)
    guard.apply(guard.rest);
    drag = ik.beginDrag('LeftFoot');
    const footTarget = new Vector3(0.10, 0.46, -0.34);
    for (let i = 1; i <= 15; i++) ik.solve('LeftFoot', drag.startWorld.clone().lerp(footTarget, i / 15), drag);
    assert(guard.isValid());
    assert(guard.byName.get('LeftFoot').getWorldPosition(new Vector3()).distanceTo(footTarget) < 0.02);
    changed = changedBoneNames(bones, guard.rest);
    assert(changed.includes('LeftLeg') && changed.includes('LeftUpLeg'));

    // 3. Head pull (curves neck and spine)
    guard.apply(guard.rest);
    drag = ik.beginDrag('Head');
    const headTarget = new Vector3(0.16, 1.56, 0.16);
    for (let i = 1; i <= 15; i++) ik.solve('Head', drag.startWorld.clone().lerp(headTarget, i / 15), drag);
    assert(guard.isValid());
    changed = changedBoneNames(bones, guard.rest);
    for (const expected of ['Spine', 'Spine1', 'Spine2', 'Neck', 'Head']) {
      assert(changed.includes(expected), `expected ${expected} to follow Head pull`);
    }

    // 4. Pelvis squat (bends both legs while keeping feet planted)
    guard.apply(guard.rest);
    drag = ik.beginDrag('Hips');
    const squatTarget = drag.startWorld.clone().add(new Vector3(0, -0.22, 0));
    for (let i = 1; i <= 15; i++) ik.solve('Hips', drag.startWorld.clone().lerp(squatTarget, i / 15), drag);
    assert(guard.isValid());
    changed = changedBoneNames(bones, guard.rest);
    assert(changed.includes('LeftLeg') && changed.includes('RightLeg'));

    // 5. Pushing torso (Spine2 / Chest) downward bends both knees all the way to a kneel on the floor
    guard.apply(guard.rest);
    drag = ik.beginDrag('Spine2');
    const kneelTarget = drag.startWorld.clone().add(new Vector3(0, -0.48, 0));
    for (let i = 1; i <= 20; i++) ik.solve('Spine2', drag.startWorld.clone().lerp(kneelTarget, i / 20), drag);
    assert(guard.isValid(), 'kneeling pose should be collision- and limit-free');
    const leftKneeY = guard.byName.get('LeftLeg').getWorldPosition(new Vector3()).y;
    const rightKneeY = guard.byName.get('RightLeg').getWorldPosition(new Vector3()).y;
    assert(leftKneeY < 0.085 && rightKneeY < 0.085, `expected both knees near floor (<0.085m), got ${leftKneeY}, ${rightKneeY}`);
    changed = changedBoneNames(bones, guard.rest);
    for (const expected of ['Hips', 'LeftUpLeg', 'LeftLeg', 'RightUpLeg', 'RightLeg']) {
      assert(changed.includes(expected), `expected ${expected} to bend when pushing torso down`);
    }

    // Pulling torso back upward stands the character back up
    const standDrag = ik.beginDrag('Spine2');
    const standTarget = standDrag.startWorld.clone().add(new Vector3(0, 0.48, 0));
    for (let i = 1; i <= 20; i++) ik.solve('Spine2', standDrag.startWorld.clone().lerp(standTarget, i / 20), standDrag);
    assert(guard.isValid());
    assert(guard.byName.get('LeftLeg').getWorldPosition(new Vector3()).y > 0.50);
  } finally {
    closeSession(session);
  }
});

test('FemaleForm sculpts softer female contours and restores original mannequin cleanly', async () => {
  const { session, bones } = await setup();
  try {
    const form = new FemaleForm(session.model, bones);
    const jointsItem = form.meshes.find(m => m.isJoints);
    const surfaceItem = form.meshes.find(m => !m.isJoints);
    assert(jointsItem && surfaceItem, 'expected both Beta_Joints and Beta_Surface');

    form.setEnabled(true, 'skin');
    assert.equal(form.enabled, true);
    assert.equal(form.hairGroup.visible, true);

    // Verify waist on Beta_Joints was widened from skeletal ball joint (~0.064m) to female waist (>0.105m)
    const pos = jointsItem.mesh.geometry.attributes.position;
    let maxWaistX = 0;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i), x = Math.abs(pos.getX(i));
      if (y > 1.15 && y < 1.21 && x < 0.17) maxWaistX = Math.max(maxWaistX, x);
    }
    assert(maxWaistX > 0.105, `expected sculpted waist half-width > 0.105m, got ${maxWaistX}`);

    // Verify withoutCosmetics detaches hair group temporarily for bone tree serialization
    const headChildrenDuring = form.withoutCosmetics(() => form.headBone.children.includes(form.hairGroup));
    assert.equal(headChildrenDuring, false);
    assert.equal(form.headBone.children.includes(form.hairGroup), true);

    // Verify disabling restores original bind positions
    form.setEnabled(false);
    assert.equal(form.hairGroup.visible, false);
    assert.deepEqual(Array.from(pos.array.slice(0, 30)), Array.from(jointsItem.origPos.slice(0, 30)));
  } finally {
    closeSession(session);
  }
});
