import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Vector3, Quaternion, Euler, MathUtils } from 'three';
import { openSession, closeSession } from '../engine.mjs';
import { PoseGuard, segmentDistance } from '../browser/pose-guard.js';

const fixture = fileURLToPath(new URL('../../exports/mannequin-female-standing.glb', import.meta.url));
async function setup() {
  const session = await openSession(fixture);
  const bones = []; session.model.traverse(object => { if (object.isBone) bones.push(object); });
  const guard = new PoseGuard(session.model, bones);
  return { session, guard };
}
const radians = MathUtils.degToRad;
const q = value => new Quaternion().fromArray(value).normalize();

test('capsule distance handles crossings, parallel segments, and point segments', () => {
  const v = (...args) => new Vector3(...args);
  assert.equal(segmentDistance(v(-1, 0, 0), v(1, 0, 0), v(0, -1, 0), v(0, 1, 0)), 0);
  assert.equal(segmentDistance(v(0, 0, 0), v(2, 0, 0), v(0, 1, 0), v(2, 1, 0)), 1);
  assert.equal(segmentDistance(v(0, 0, 0), v(0, 0, 0), v(0, 2, 0), v(1, 2, 0)), 2);
  assert.equal(segmentDistance(v(0, 0, 0), v(0, 0, 0), v(0, 3, 0), v(0, 3, 0)), 3);
});

test('female rest pose is clear and a valid wrist edit is preserved', async () => {
  const { session, guard } = await setup();
  try {
    assert.equal(guard.capsules.length, 15);
    assert(guard.isValid());
    const before = guard.capture(), wrist = guard.byName.get('LeftHand');
    wrist.rotateY(radians(20)); const wanted = wrist.quaternion.clone();
    const result = guard.resolve({ names: ['LeftHand'], previous: before });
    assert.equal(result.corrected, false);
    assert(wanted.normalize().angleTo(wrist.quaternion.clone().normalize()) < 1e-6);
  } finally { closeSession(session); }
});

test('arm through torso projects to a nearby clear pose and preserves other bones', async () => {
  const { session, guard } = await setup();
  try {
    const before = guard.capture(), arm = guard.byName.get('LeftArm'), index = guard.bones.indexOf(arm);
    arm.rotateX(radians(60)); const wanted = arm.quaternion.clone();
    assert(guard.collisions().some(contact => contact.parts.includes('chest')));
    const result = guard.resolve({ names: ['LeftArm'], previous: before });
    assert(result.corrected && result.contacts.length);
    assert(guard.isValid());
    assert(wanted.normalize().angleTo(arm.quaternion.clone().normalize()) < wanted.angleTo(q(before[index].q)));
    guard.bones.forEach((bone, i) => {
      if (i !== index) assert(q(before[i].q).angleTo(bone.quaternion.clone().normalize()) < 1e-6, bone.name);
    });
  } finally { closeSession(session); }
});

test('crossing thighs are corrected without moving the character root', async () => {
  const { session, guard } = await setup();
  try {
    session.model.position.set(2, 0.5, -3); session.model.rotation.y = 0.7; session.model.scale.set(1.2, 0.8, 1.1);
    const before = guard.capture(), rootMatrix = session.model.matrix.clone();
    session.model.updateMatrix(); rootMatrix.copy(session.model.matrix);
    guard.byName.get('LeftUpLeg').rotateZ(radians(-45));
    assert(guard.collisions().some(contact => contact.parts.includes('Right thigh')));
    guard.resolve({ names: ['LeftUpLeg'], previous: before });
    assert(guard.isValid());
    session.model.updateMatrix(); assert.deepEqual(session.model.matrix.toArray(), rootMatrix.toArray());
  } finally { closeSession(session); }
});

test('hinges and head are clamped to their configured limits', async () => {
  const { session, guard } = await setup();
  try {
    const before = guard.capture();
    guard.byName.get('LeftLeg').rotateX(radians(80));
    guard.byName.get('Head').rotateZ(radians(85));
    assert(guard.limitViolations().length >= 2);
    const result = guard.resolve({ previous: before });
    assert(result.limited.includes('LeftLeg') && result.limited.includes('Head'));
    assert(guard.isValid());
  } finally { closeSession(session); }
});

test('invalid prior state cannot become the safe fallback', async () => {
  const { session, guard } = await setup();
  try {
    guard.byName.get('LeftArm').rotateX(radians(60));
    const invalid = guard.capture(); assert(!guard.isValid());
    guard.byName.get('LeftArm').rotateX(radians(20));
    guard.resolve({ names: ['LeftArm'], previous: invalid });
    assert(guard.isValid());
  } finally { closeSession(session); }
});

test('sampled limb and head edits finish clear and within limits', async () => {
  const { session, guard } = await setup();
  try {
    const start = guard.capture();
    const names = ['LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm', 'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'Head'];
    let seed = 123456;
    const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let i = 0; i < 48; i++) {
      guard.apply(start);
      const name = names[i % names.length], bone = guard.byName.get(name);
      bone.quaternion.multiply(new Quaternion().setFromEuler(new Euler(...Array.from({ length: 3 }, () => radians((random() - 0.5) * 300)))));
      guard.resolve({ names: [name], previous: start });
      assert(guard.isValid(), `${name} sample ${i}`);
    }
  } finally { closeSession(session); }
});
