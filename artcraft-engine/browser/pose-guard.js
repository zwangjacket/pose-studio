import { Vector3, Quaternion, Euler, Matrix4, MathUtils } from 'three';

const EPS = 0.001;
const cleanName = name => name.replace(/^mixamorig[:_]?/i, '');
const rad = MathUtils.degToRad;
const axes = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];

// Conservative collision proxies for this mannequin, in character-space meters.
// Adjacent segments share a joint and intentionally overlap; their pair is ignored.
// These are not exact mesh surfaces or a biomechanical model.
const definitions = [
  ['pelvis', 'Hips', 'Spine', 0.115, 0, 0.025, 'torso'],
  ['chest', 'Spine1', 'Neck', 0.115, 0, 0.075, 'torso'],
  ['head', 'Head', 'HeadTop_End', 0.078, 0.035, 0.035, 'head'],
];
for (const side of ['Left', 'Right']) {
  definitions.push(
    [`${side} upper arm`, `${side}Arm`, `${side}ForeArm`, 0.046, 0.045, 0.015, `${side} arm`],
    [`${side} forearm`, `${side}ForeArm`, `${side}Hand`, 0.038, 0.015, 0.015, `${side} arm`],
    [`${side} hand`, `${side}Hand`, `${side}HandMiddle3`, 0.033, 0.018, 0, `${side} arm`],
    [`${side} thigh`, `${side}UpLeg`, `${side}Leg`, 0.069, 0.055, 0.035, `${side} leg`],
    [`${side} shin`, `${side}Leg`, `${side}Foot`, 0.047, 0.03, 0.025, `${side} leg`],
    [`${side} foot`, `${side}Foot`, `${side}Toe_End`, 0.041, 0.015, 0.015, `${side} leg`],
  );
}

export function jointLimits(name) {
  name = cleanName(name);
  if (/ForeArm$/.test(name)) return [[-150, 8], [-90, 90], [-12, 12]];
  if (/^(Left|Right)Leg$/.test(name)) return [[-150, 5], [-12, 12], [-10, 10]];
  if (/UpLeg$/.test(name)) return [[-35, 120], [-60, 60], [-65, 65]];
  if (/Shoulder$/.test(name)) return [[-35, 35], [-35, 35], [-35, 35]];
  if (/^(Left|Right)Arm$/.test(name)) return [[-170, 170], [-90, 90], [-170, 170]];
  if (/Hand$/.test(name)) return [[-80, 80], [-75, 75], [-80, 80]];
  if (/Foot$/.test(name)) return [[-68, 65], [-30, 30], [-30, 30]];
  if (/ToeBase$/.test(name)) return [[-68, 65], [-10, 10], [-10, 10]];
  if (name === 'Head') return [[-60, 60], [-75, 75], [-45, 45]];
  if (name === 'Neck') return [[-40, 40], [-50, 50], [-35, 35]];
  if (/Spine/.test(name)) return [[-35, 35], [-40, 40], [-30, 30]];
  return null;
}

export class PoseGuard {
  constructor(model, bones) {
    this.model = model;
    this.bones = bones;
    this.byName = new Map(bones.map(bone => [cleanName(bone.name), bone]));
    this.rest = this.capture();
    this.good = this.capture();
    this.inverse = new Matrix4();
    this.capsules = definitions.map(([name, from, to, radius, trimStart, trimEnd, group]) => ({
      name, from: this.byName.get(from), to: this.byName.get(to), radius, trimStart, trimEnd, group,
      a: new Vector3(), b: new Vector3(),
    })).filter(capsule => capsule.from && capsule.to);
    this.pairs = [];
    for (let i = 0; i < this.capsules.length; i++) for (let j = i + 1; j < this.capsules.length; j++) {
      const a = this.capsules[i], b = this.capsules[j];
      if (a.to === b.from || b.to === a.from || a.from === b.from) continue;
      if (a.group === 'torso' && b.group === 'torso') continue;
      if ((a.name === 'pelvis' && /thigh/.test(b.name)) || (b.name === 'pelvis' && /thigh/.test(a.name))) continue;
      this.pairs.push([a, b]);
    }
    const overlap = this.collisions();
    if (overlap.length) throw new Error(`Default collision volumes overlap: ${overlap.map(pair => pair.parts.join(' / ')).join(', ')}`);
  }

  capture() {
    return this.bones.map(bone => ({ p: bone.position.toArray(), q: bone.quaternion.toArray(), s: bone.scale.toArray() }));
  }

  apply(state) {
    this.bones.forEach((bone, i) => {
      bone.position.fromArray(state[i].p);
      bone.quaternion.fromArray(state[i].q);
      bone.scale.fromArray(state[i].s);
    });
    this.model.updateMatrixWorld(true);
  }

  constrain(bone) {
    const bounds = jointLimits(bone.name);
    if (!bounds) return false;
    const rest = new Quaternion().fromArray(this.rest[this.bones.indexOf(bone)].q).normalize();
    const relative = rest.clone().invert().multiply(bone.quaternion.clone().normalize());
    const angles = new Euler().setFromQuaternion(relative, 'XYZ');
    let changed = false;
    for (let i = 0; i < 3; i++) {
      const key = ['x', 'y', 'z'][i];
      const value = MathUtils.clamp(angles[key], rad(bounds[i][0]), rad(bounds[i][1]));
      changed ||= Math.abs(value - angles[key]) > 1e-6;
      angles[key] = value;
    }
    if (changed) bone.quaternion.copy(rest).multiply(new Quaternion().setFromEuler(angles));
    return changed;
  }

  collisions() {
    this.model.updateMatrixWorld(true);
    this.inverse.copy(this.model.matrixWorld).invert();
    for (const c of this.capsules) {
      c.from.getWorldPosition(c.a).applyMatrix4(this.inverse);
      c.to.getWorldPosition(c.b).applyMatrix4(this.inverse);
      const length = c.a.distanceTo(c.b);
      if (length > c.trimStart + c.trimEnd) {
        const direction = c.b.clone().sub(c.a).divideScalar(length);
        c.a.addScaledVector(direction, c.trimStart);
        c.b.addScaledVector(direction, -c.trimEnd);
      }
    }
    const result = [];
    for (const [a, b] of this.pairs) {
      const depth = a.radius + b.radius - segmentDistance(a.a, a.b, b.a, b.b);
      if (depth > EPS) result.push({ parts: [a.name, b.name], depth });
    }
    return result;
  }

  limitViolations() {
    return this.bones.filter((bone, index) => {
      const bounds = jointLimits(bone.name); if (!bounds) return false;
      const relative = new Quaternion().fromArray(this.rest[index].q).normalize().invert().multiply(bone.quaternion.clone().normalize());
      const angles = new Euler().setFromQuaternion(relative, 'XYZ');
      return ['x', 'y', 'z'].some((axis, i) => angles[axis] < rad(bounds[i][0]) - 1e-6 || angles[axis] > rad(bounds[i][1]) + 1e-6);
    }).map(bone => cleanName(bone.name));
  }

  isValid() { return this.collisions().length === 0 && this.limitViolations().length === 0; }

  // Project to a nearby feasible configuration, keeping the edited joint local
  // when possible. A previously verified pose provides a safe fallback. We search
  // nearby rotations and refine toward the request; no global-nearest claim.
  resolve({ names = [], previous } = {}) {
    const requested = this.capture();
    const candidates = names.length ? names.map(name => this.byName.get(cleanName(name))).filter(Boolean) : this.bones;
    const limited = this.bones.filter(bone => this.constrain(bone)).map(bone => cleanName(bone.name));
    const target = this.capture();
    const contacts = this.collisions();
    if (!contacts.length) {
      this.good = target;
      return { corrected: limited.length > 0, limited, contacts: [], adjusted: limited, fallback: false };
    }

    // Prefer the immediately preceding valid configuration over an older one.
    let safe = this.good;
    if (previous?.length === this.bones.length) {
      this.apply(previous);
      if (this.isValid()) safe = previous;
    }
    this.apply(safe);
    if (!this.isValid()) safe = this.rest;
    this.apply(target);

    let best = this.boundary(target, safe);
    let bestCost = poseDistance(requested, best);

    // Search a small sphere of angular offsets around the requested joint.
    // This lets an arm slide to either side of the torso rather than only undoing
    // part of the drag. Other body parts remain unchanged in these candidates.
    if (candidates.length === 1) {
      const bone = candidates[0], index = this.bones.indexOf(bone);
      const desiredQ = new Quaternion().fromArray(target[index].q);
      const maximum = Math.min(100, MathUtils.radToDeg(Math.sqrt(bestCost)) + 8);
      const directions = [];
      for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
        if (x || y || z) directions.push(new Vector3(x, y, z).normalize());
      }
      for (const degrees of [3, 7, 15, 28, 45, 70, 100].filter(angle => angle <= maximum)) {
        let found = false;
        for (const direction of directions) {
          this.apply(target);
          bone.quaternion.copy(desiredQ).multiply(new Quaternion().setFromAxisAngle(direction, rad(degrees)));
          this.constrain(bone);
          if (!this.isValid()) continue;
          const refined = this.boundary(target, this.capture());
          const cost = poseDistance(requested, refined);
          if (cost < bestCost) { best = refined; bestCost = cost; found = true; }
        }
        if (found) break;
      }
      // Local refinement around the best feasible result.
      for (const degrees of [4, 2, 1, 0.5]) {
        for (const axis of axes) for (const sign of [-1, 1]) {
          this.apply(best);
          bone.quaternion.multiply(new Quaternion().setFromAxisAngle(axis, rad(degrees * sign)));
          this.constrain(bone);
          if (!this.isValid()) continue;
          const candidate = this.capture(), cost = poseDistance(requested, candidate);
          if (cost < bestCost) { best = candidate; bestCost = cost; }
        }
      }
    }

    this.apply(best);
    // Numerical safety check. Boundary/refinement must never leave an overlap.
    if (!this.isValid()) { best = safe; this.apply(best); }
    this.good = this.capture();
    const adjusted = this.bones.filter((bone, i) => new Quaternion().fromArray(requested[i].q).normalize().angleTo(bone.quaternion.clone().normalize()) > 1e-4).map(bone => cleanName(bone.name));
    return { corrected: true, limited, contacts, adjusted, fallback: poseDistance(best, safe) < 1e-8 };
  }

  boundary(target, safe) {
    // Walk from the request towards a safe configuration to find the nearest
    // safe interval on this path, then binary-refine its boundary.
    let blocked = 0, clear = 1;
    for (let step = 1; step <= 16; step++) {
      const t = step / 16;
      this.interpolate(target, safe, t);
      this.bones.forEach(bone => this.constrain(bone));
      if (this.isValid()) { clear = t; break; }
      blocked = t;
    }
    // If clamping changed the fallback, the unmodified safe state still wins.
    this.interpolate(target, safe, clear);
    this.bones.forEach(bone => this.constrain(bone));
    if (!this.isValid()) { this.apply(safe); return this.capture(); }
    let best = this.capture();
    for (let i = 0; i < 12; i++) {
      const middle = (blocked + clear) / 2;
      this.interpolate(target, safe, middle);
      this.bones.forEach(bone => this.constrain(bone));
      if (this.isValid()) { clear = middle; best = this.capture(); }
      else blocked = middle;
    }
    this.apply(best);
    return best;
  }

  interpolate(a, b, t) {
    this.bones.forEach((bone, i) => {
      bone.position.fromArray(a[i].p).lerp(new Vector3().fromArray(b[i].p), t);
      bone.scale.fromArray(a[i].s).lerp(new Vector3().fromArray(b[i].s), t);
      bone.quaternion.fromArray(a[i].q).normalize().slerp(new Quaternion().fromArray(b[i].q).normalize(), t);
    });
  }
}

function poseDistance(a, b) {
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    const angle = new Quaternion().fromArray(a[i].q).normalize().angleTo(new Quaternion().fromArray(b[i].q).normalize());
    distance += angle * angle;
    distance += new Vector3().fromArray(a[i].p).distanceToSquared(new Vector3().fromArray(b[i].p)) * 10;
  }
  return distance;
}

// Closest distance between finite line segments, including degenerate points.
export function segmentDistance(p1, q1, p2, q2) {
  const d1 = q1.clone().sub(p1), d2 = q2.clone().sub(p2), r = p1.clone().sub(p2);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
  let s, t;
  if (a <= 1e-12 && e <= 1e-12) return p1.distanceTo(p2);
  if (a <= 1e-12) { s = 0; t = MathUtils.clamp(f / e, 0, 1); }
  else {
    const c = d1.dot(r);
    if (e <= 1e-12) { t = 0; s = MathUtils.clamp(-c / a, 0, 1); }
    else {
      const b = d1.dot(d2), denominator = a * e - b * b;
      s = denominator > 1e-12 ? MathUtils.clamp((b * f - c * e) / denominator, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = MathUtils.clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = MathUtils.clamp((b - c) / a, 0, 1); }
    }
  }
  return p1.clone().addScaledVector(d1, s).distanceTo(p2.clone().addScaledVector(d2, t));
}
