import { readFile, writeFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FKHelper } from './dist/FKHelper.js';
import { BoneJSONHelper } from './dist/BoneJSONHelper.js';

export const UPSTREAM_COMMIT = 'd4e4ac69bbd93d237eaf5d0260bc6a5ff3a5e373';

export async function openSession(path) {
  const source = await readFile(path);
  const { document, binaryChunks } = parseGlb(source);
  if (!document.skins?.length) throw new Error('The input GLB has no skinned skeleton.');
  if (document.buffers?.some(b => b.uri) || document.images?.some(i => i.uri)) {
    throw new Error('The input must be a self-contained GLB.');
  }
  const loader = new GLTFLoader();
  const gltf = await loader.parseAsync(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength), '');
  const model = gltf.scene;
  model.userData.isCharacter = true;
  const scene = new THREE.Scene();
  scene.add(model);
  scene.updateMatrixWorld(true);
  const originalTransforms = new Map();
  model.traverse(object => originalTransforms.set(object, {
    position: object.position.clone(), quaternion: object.quaternion.clone(), scale: object.scale.clone(),
  }));
  // TransformControls only needs event registration/style from its DOM element.
  // Pointer geometry and every bone quaternion change execute in upstream code.
  const domElement = { style: {}, addEventListener() {}, removeEventListener() {} };
  const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.01, 100);
  camera.position.set(4, 3, 5);
  camera.lookAt(0, 1, 0);
  camera.updateMatrixWorld(true);
  const fk = new FKHelper({ camera, domElement, scene, onDragChange() {} });
  silenceUpstreamLogs(() => fk.setTarget(model));
  // These markers are created and filtered by ArtCraft's own FKHelper.setTarget.
  const bones = fk.targetBoneSpheres.map(sphere => sphere.parent);
  return { document, binaryChunks, gltf, model, scene, camera, fk, bones, originalTransforms, events: [] };
}

export function listBones(session) {
  return session.bones.map(bone => ({
    name: bone.name,
    alias: bone.name.replace(/^mixamorig[:_]?/i, ''),
    parent: bone.parent?.name,
    rotation_degrees_xyz: [bone.rotation.x, bone.rotation.y, bone.rotation.z].map(THREE.MathUtils.radToDeg),
  }));
}

export function rotateBone(session, name, axis, degrees, space = 'local', snapDegrees = null) {
  const bone = resolveBone(session, name);
  axis = axis.toUpperCase();
  if (!['X', 'Y', 'Z'].includes(axis)) throw new Error('Rotation axis must be x, y or z.');
  if (!Number.isFinite(degrees) || Math.abs(degrees) > 360) throw new Error('Rotation must be finite and between -360 and 360 degrees.');
  if (!['local', 'world'].includes(space)) throw new Error('Space must be local or world.');
  if (snapDegrees !== null && (!Number.isFinite(snapDegrees) || snapDegrees <= 0 || snapDegrees > 180)) {
    throw new Error('Snap must be greater than zero and no more than 180 degrees.');
  }
  session.scene.updateMatrixWorld(true);
  // This is the same attach path called by FKHelper.onMouseClick. Its TS
  // private members are accessible in emitted JS; the upstream revision is pinned.
  session.fk.showControls(bone);
  const controls = session.fk.transformControls;
  controls.setSpace(space);
  controls.setRotationSnap(snapDegrees === null ? null : THREE.MathUtils.degToRad(snapDegrees));
  controls.axis = axis;
  const pivot = bone.getWorldPosition(new THREE.Vector3());
  const worldAxis = new THREE.Vector3(...({ X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] }[axis]));
  if (space === 'local') worldAxis.applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion()));
  let view = new THREE.Vector3(4, 3, 5).normalize();
  if (Math.abs(view.dot(worldAxis)) > 0.95) view = new THREE.Vector3(5, -4, 3).normalize();
  session.camera.position.copy(pivot).addScaledVector(view, 5);
  session.camera.lookAt(pivot);
  session.camera.updateMatrixWorld(true);
  controls.updateMatrixWorld(true);
  // Map a numeric angle to an equivalent synthetic pointer drag on the
  // actual control plane. This is input adaptation, not replacement FK math.
  const start = pivot.clone().add(new THREE.Vector3(0.2, 0.1, 0).applyQuaternion(session.camera.quaternion));
  const tangent = worldAxis.clone().cross(controls.eye).normalize();
  const speed = 20 / pivot.distanceTo(session.camera.position);
  const end = start.clone().addScaledVector(tangent, THREE.MathUtils.degToRad(degrees) / speed);
  const pointer = (point, button) => {
    const projected = point.clone().project(session.camera);
    return { x: projected.x, y: projected.y, button };
  };
  let changed = 0;
  const onChange = () => changed++;
  controls.addEventListener('objectChange', onChange);
  try {
    controls.pointerDown(pointer(start, 0));
    if (!controls.dragging) throw new Error('ArtCraft TransformControls did not begin the drag.');
    controls.pointerMove(pointer(end, -1));
    if (!changed) throw new Error('ArtCraft TransformControls did not emit an objectChange event.');
    const result = {
      bone: bone.name, axis: axis.toLowerCase(), space,
      requested_degrees: degrees,
      applied_degrees: THREE.MathUtils.radToDeg(controls.rotationAngle),
      quaternion: bone.quaternion.toArray(), objectChange_events: changed,
      implementation: 'upstream TransformControls.pointerDown/pointerMove/pointerUp',
    };
    session.events.push(result);
    return result;
  } finally {
    controls.pointerUp({ button: 0 });
    controls.removeEventListener('objectChange', onChange);
    session.scene.updateMatrixWorld(true);
  }
}

export function capturePose(session) {
  // ArtCraft adds temporary FK marker meshes to bones. Remove them using
  // its own clear() before invoking the native pose serializer.
  session.fk.clear();
  const pose = new BoneJSONHelper(session.model).toJSON();
  if (!pose) throw new Error('ArtCraft BoneJSONHelper could not find the Mixamo hip root.');
  return pose;
}

export function applyPose(session, pose) {
  const expected = capturePose(session);
  if (['images', 'textures', 'materials', 'geometries'].some(key => pose?.[key]?.length)) {
    throw new Error('A saved pose must contain only the bone tree, without external resources.');
  }
  validatePoseTree(expected.object, pose?.object);
  // No custom quaternion application here: ArtCraft's helper restores the tree.
  new BoneJSONHelper(session.model).poseFromBoneJSON(pose);
  session.scene.updateMatrixWorld(true);
  silenceUpstreamLogs(() => session.fk.setTarget(session.model));
}

export async function exportGlb(session, output) {
  const doc = structuredClone(session.document);
  // Preserve exact geometry/skin buffers. Only persist the transforms changed
  // by the upstream runtime, using GLTFLoader's object-to-node associations.
  const changed = [];
  session.model.traverse(object => {
    const index = session.gltf.parser.associations.get(object)?.nodes;
    const original = session.originalTransforms.get(object);
    if (index === undefined || !original) return;
    const node = doc.nodes[index];
    const fields = [];
    if (object.position.distanceTo(original.position) > 1e-8) {
      node.translation = object.position.toArray(); fields.push('translation');
    }
    if (1 - Math.abs(object.quaternion.clone().normalize().dot(original.quaternion.clone().normalize())) > 1e-12) {
      node.rotation = object.quaternion.toArray(); fields.push('rotation');
    }
    // ObjectLoader's matrix decomposition introduces small scale roundoff
    // when restoring ArtCraft pose JSON. Do not persist that as a pose edit.
    if (object.scale.distanceTo(original.scale) > 1e-6) {
      node.scale = object.scale.toArray(); fields.push('scale');
    }
    if (fields.length) { delete node.matrix; changed.push({ node: index, name: object.name, fields }); }
  });
  delete doc.animations;
  doc.asset.generator = `ArtCraft upstream FK CLI adapter (${UPSTREAM_COMMIT.slice(0, 12)})`;
  await writeFile(output, encodeGlb(doc, session.binaryChunks), { flag: 'wx' });
  return changed;
}

export function closeSession(session) {
  session.fk.clear();
  session.fk.transformControls.dispose();
  session.model.traverse(object => {
    object.geometry?.dispose();
    for (const material of [].concat(object.material ?? [])) material.dispose();
  });
}

function resolveBone(session, name) {
  const key = value => value.replace(/^mixamorig[:_]?/i, '').toLowerCase();
  const bone = session.bones.find(b => key(b.name) === key(name));
  if (!bone) throw new Error(`Bone '${name}' is not exposed by ArtCraft's FK pose tool. Run bones to see editable bones.`);
  return bone;
}

function validatePoseTree(expected, actual) {
  if (!actual || actual.type !== expected.type || actual.name !== expected.name) {
    throw new Error('Pose skeleton does not match this model.');
  }
  const children = actual.children ?? [];
  const expectedChildren = expected.children ?? [];
  if (children.length !== expectedChildren.length) throw new Error('Pose skeleton has a different bone hierarchy.');
  if (!Array.isArray(actual.matrix) || actual.matrix.length !== 16 || actual.matrix.some(x => !Number.isFinite(x))) {
    throw new Error(`Invalid transform in saved pose bone '${actual.name}'.`);
  }
  children.forEach((child, i) => validatePoseTree(expectedChildren[i], child));
}

function silenceUpstreamLogs(action) {
  const log = console.log;
  try { console.log = () => {}; return action(); } finally { console.log = log; }
}

export function parseGlb(data) {
  if (data.length < 20 || data.toString('ascii', 0, 4) !== 'glTF' || data.readUInt32LE(4) !== 2 || data.readUInt32LE(8) !== data.length) {
    throw new Error('Expected a valid glTF 2.0 binary file.');
  }
  const chunks = [];
  for (let offset = 12; offset < data.length;) {
    if (offset + 8 > data.length) throw new Error('Truncated GLB chunk header.');
    const size = data.readUInt32LE(offset), kind = data.readUInt32LE(offset + 4);
    offset += 8;
    if (size % 4 || offset + size > data.length) throw new Error('Invalid GLB chunk length.');
    chunks.push({ kind, data: data.subarray(offset, offset + size) });
    offset += size;
  }
  if (chunks[0]?.kind !== 0x4e4f534a) throw new Error('Missing GLB JSON chunk.');
  return { document: JSON.parse(chunks[0].data.toString('utf8')), binaryChunks: chunks.slice(1) };
}

function encodeGlb(doc, binaryChunks) {
  const json = Buffer.from(JSON.stringify(doc));
  const padded = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
  const chunks = [{ kind: 0x4e4f534a, data: padded }, ...binaryChunks].map(({ kind, data }) => {
    const header = Buffer.alloc(8); header.writeUInt32LE(data.length); header.writeUInt32LE(kind, 4);
    return Buffer.concat([header, data]);
  });
  const payload = Buffer.concat(chunks), header = Buffer.alloc(12);
  header.write('glTF'); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + payload.length, 8);
  return Buffer.concat([header, payload]);
}
