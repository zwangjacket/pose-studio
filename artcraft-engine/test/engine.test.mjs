import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { openSession, listBones, rotateBone, capturePose, applyPose, exportGlb, closeSession, parseGlb } from '../engine.mjs';

const INPUT = fileURLToPath(new URL('../../models/artcraft-male-doll.glb', import.meta.url));

test('upstream modules are unchanged from their pinned source hashes', async () => {
  const manifest = JSON.parse(await readFile(new URL('../upstream/SOURCE.json', import.meta.url), 'utf8'));
  for (const file of manifest.files) {
    const data = await readFile(new URL('../upstream/' + file.local_path, import.meta.url));
    assert.equal(createHash('sha256').update(data).digest('hex'), file.sha256, file.local_path);
  }
});

test('ArtCraft itself selects the 22 editable bones and filters fingers', async () => {
  const s = await openSession(INPUT);
  try {
    const bones = listBones(s);
    assert.equal(bones.length, 22);
    assert.ok(bones.some(b => b.alias === 'Head'));
    assert.ok(!bones.some(b => /thumb|index|pinky/i.test(b.name)));
    assert.throws(() => rotateBone(s, 'LeftHandThumb1', 'z', 30), /not exposed/);
  } finally { closeSession(s); }
});

test('native pointer control applies requested rotations and emits its events', async () => {
  const s = await openSession(INPUT);
  try {
    for (const [bone, axis, degrees, space] of [
      ['Head', 'y', 25, 'local'], ['RightForeArm', 'z', -70, 'local'],
      ['Head', 'x', 10, 'local'], ['LeftArm', 'x', 40, 'world'],
      ['Head', 'y', -20, 'world'], ['Spine2', 'z', -15, 'world'],
    ]) {
      const change = rotateBone(s, bone, axis, degrees, space);
      assert.ok(Math.abs(change.applied_degrees - degrees) < 1e-7);
      assert.equal(change.objectChange_events, 1);
    }
  } finally { closeSession(s); }
});

test('native snapping and opposite drags preserve the original orientation', async () => {
  const s = await openSession(INPUT);
  try {
    const bone = s.bones.find(b => b.name === 'mixamorigHead');
    const before = bone.quaternion.clone().normalize();
    assert.ok(Math.abs(rotateBone(s, 'Head', 'y', 23, 'local', 15).applied_degrees - 30) < 1e-7);
    rotateBone(s, 'Head', 'y', -30);
    assert.ok(1 - Math.abs(before.dot(bone.quaternion)) < 1e-12);
  } finally { closeSession(s); }
});

test('ArtCraft pose JSON saves and restores the same complete bone tree', async () => {
  const first = await openSession(INPUT), second = await openSession(INPUT);
  try {
    rotateBone(first, 'Head', 'y', 25);
    rotateBone(first, 'RightForeArm', 'z', 70);
    const pose = capturePose(first);
    assert.equal(pose.object.type, 'Bone');
    assert.equal(pose.object.name, 'mixamorigHips');
    assert.ok(!JSON.stringify(pose).includes('__FKHelperSphere__'));
    applyPose(second, pose);
    const restored = capturePose(second);
    const compare = (a, b) => {
      assert.equal(a.name, b.name);
      a.matrix.forEach((value, i) => assert.ok(Math.abs(value - b.matrix[i]) < 1e-7));
      (a.children ?? []).forEach((child, i) => compare(child, b.children[i]));
    };
    compare(pose.object, restored.object);
    const wrong = structuredClone(pose); wrong.object.name = 'other_rig';
    assert.throws(() => applyPose(second, wrong), /does not match/);
  } finally { closeSession(first); closeSession(second); }
});

test('native GLB export changes only edited nodes and preserves binary skin data', async () => {
  const s = await openSession(INPUT);
  const restored = await openSession(INPUT);
  const folder = await mkdtemp(join(tmpdir(), 'artcraft-fk-test-'));
  try {
    rotateBone(s, 'Head', 'y', 25);
    rotateBone(s, 'RightForeArm', 'z', 70);
    const pose = capturePose(s);
    const output = join(folder, 'pose.glb');
    const changed = await exportGlb(s, output);
    assert.deepEqual(changed.map(c => c.name).sort(), ['mixamorigHead', 'mixamorigRightForeArm']);
    const exported = parseGlb(await readFile(output));
    assert.deepEqual(exported.document.skins, s.document.skins);
    assert.deepEqual(exported.document.meshes, s.document.meshes);
    assert.deepEqual(exported.binaryChunks, s.binaryChunks);
    assert.equal(exported.document.animations, undefined);
    await assert.rejects(exportGlb(s, output), { code: 'EEXIST' });
    applyPose(restored, pose);
    capturePose(restored);
    const restoredChanges = await exportGlb(restored, join(folder, 'restored.glb'));
    assert.deepEqual(restoredChanges.map(c => c.name).sort(), ['mixamorigHead', 'mixamorigRightForeArm']);
  } finally { closeSession(s); closeSession(restored); await rm(folder, { recursive: true }); }
});
