import * as THREE from 'three';

function smoothstep(edge0, edge1, x) {
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function bandWindow(y, yMin, yPeakLow, yPeakHigh, yMax) {
  if (y <= yMin || y >= yMax) return 0;
  if (y < yPeakLow) return smoothstep(yMin, yPeakLow, y);
  if (y > yPeakHigh) return 1 - smoothstep(yPeakHigh, yMax, y);
  return 1;
}

function gaussian(x, mean, sigma) {
  const d = (x - mean) / sigma;
  return Math.exp(-0.5 * d * d);
}

function normalizeWeights(indices, weights) {
  const map = new Map();
  for (let i = 0; i < indices.length; i++) {
    const w = weights[i];
    if (w <= 1e-5) continue;
    const idx = indices[i];
    map.set(idx, (map.get(idx) || 0) + w);
  }
  const sorted = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  while (sorted.length < 4) sorted.push([0, 0]);
  const sum = sorted.reduce((acc, item) => acc + item[1], 0) || 1;
  return {
    idx: sorted.map((item) => item[0]),
    wt: sorted.map((item) => item[1] / sum),
  };
}

/**
 * Replaces the segmented robot armor plates and exposed ball joints with a
 * continuous, seamless, high-resolution female SkinnedMesh bound to the
 * same Mixamo skeleton, complete with per-vertex anatomical shading,
 * optional studio athletic attire, and sculpted hair.
 */
export class FemaleForm {
  constructor(model, allBones) {
    this.model = model;
    this.allBones = allBones;
    this.enabled = false;
    this.finish = 'studio'; // 'studio' | 'skin' | 'clay' | 'mannequin'
    this.meshes = [];
    this.seamlessMesh = null;
    this.vertexMeta = [];
    this.hairGroup = null;
    this.prepareMeshes();
    this.createSeamlessBodyMesh();
    this.createHeadCosmetics();
  }

  findBoneIndex(skeleton, shortName) {
    return skeleton.bones.findIndex(
      (b) => b.name.replace(/^mixamorig[:_]?/i, '') === shortName,
    );
  }

  prepareMeshes() {
    this.model.traverse((obj) => {
      if (!obj.isMesh || obj.userData.isCosmetic) return;
      const geom = obj.geometry;
      const posAttr = geom.attributes.position;
      const normAttr = geom.attributes.normal;
      const indexAttr = geom.index;
      if (!posAttr || !normAttr || !indexAttr) return;

      const origPos = new Float32Array(posAttr.array);
      const origNorm = new Float32Array(normAttr.array);
      const origIndex = new Uint32Array(indexAttr.array);
      const isJoints = /joint/i.test(obj.name);

      const sculptedPos = new Float32Array(origPos);
      this.sculptBindPositions(sculptedPos, isJoints);
      const sculptedNorm = this.computeWeldedNormals(geom, sculptedPos);

      // In FemaleForm mode, keep the Head (cy > 1.515) and Feet (cy < 0.102) from the base mesh;
      // the torso, neck, pelvis, legs, arms, hands, palms, and all 10 fingers are sculpted in FemaleSeamlessBody.
      const kept = [];
      for (let i = 0; i < origIndex.length; i += 3) {
        const i0 = origIndex[i] * 3;
        const i1 = origIndex[i + 1] * 3;
        const i2 = origIndex[i + 2] * 3;
        const cx = (origPos[i0] + origPos[i1] + origPos[i2]) / 3;
        const cy = (origPos[i0 + 1] + origPos[i1 + 1] + origPos[i2 + 1]) / 3;
        const isHead = !isJoints && cy > 1.515 && Math.abs(cx) < 0.12;
        const isFoot = cy < 0.102 && Math.abs(cx) < 0.18;
        if (isHead || isFoot) {
          kept.push(origIndex[i], origIndex[i + 1], origIndex[i + 2]);
        }
      }
      const extremitiesIndex = new Uint32Array(kept);
      if (!isJoints) this.surfaceMesh = obj;

      this.meshes.push({
        mesh: obj,
        isJoints,
        origPos,
        origNorm,
        origIndex,
        extremitiesIndex,
        sculptedPos,
        sculptedNorm,
      });
    });
  }

  createSeamlessBodyMesh() {
    if (!this.surfaceMesh || !this.surfaceMesh.skeleton) return;
    const skeleton = this.surfaceMesh.skeleton;
    const B = {
      Hips: this.findBoneIndex(skeleton, 'Hips'),
      Spine: this.findBoneIndex(skeleton, 'Spine'),
      Spine1: this.findBoneIndex(skeleton, 'Spine1'),
      Spine2: this.findBoneIndex(skeleton, 'Spine2'),
      Neck: this.findBoneIndex(skeleton, 'Neck'),
      Head: this.findBoneIndex(skeleton, 'Head'),
      LeftShoulder: this.findBoneIndex(skeleton, 'LeftShoulder'),
      RightShoulder: this.findBoneIndex(skeleton, 'RightShoulder'),
      LeftArm: this.findBoneIndex(skeleton, 'LeftArm'),
      RightArm: this.findBoneIndex(skeleton, 'RightArm'),
      LeftForeArm: this.findBoneIndex(skeleton, 'LeftForeArm'),
      RightForeArm: this.findBoneIndex(skeleton, 'RightForeArm'),
      LeftHand: this.findBoneIndex(skeleton, 'LeftHand'),
      RightHand: this.findBoneIndex(skeleton, 'RightHand'),
      LeftUpLeg: this.findBoneIndex(skeleton, 'LeftUpLeg'),
      RightUpLeg: this.findBoneIndex(skeleton, 'RightUpLeg'),
      LeftLeg: this.findBoneIndex(skeleton, 'LeftLeg'),
      RightLeg: this.findBoneIndex(skeleton, 'RightLeg'),
      LeftFoot: this.findBoneIndex(skeleton, 'LeftFoot'),
      RightFoot: this.findBoneIndex(skeleton, 'RightFoot'),
    };

    const positions = [];
    const skinIndices = [];
    const skinWeights = [];
    const indices = [];
    this.vertexMeta = [];

    const addVertex = (x, y, z, boneIds, weights, meta = {}) => {
      const idx = positions.length / 3;
      positions.push(x, y, z);
      const nw = normalizeWeights(boneIds, weights);
      skinIndices.push(...nw.idx);
      skinWeights.push(...nw.wt);
      this.vertexMeta.push({
        part: meta.part || 'body',
        y,
        x,
        z,
        u: meta.u || 0,
        shade: meta.shade ?? 1,
        attire: meta.attire ?? 0,
        trim: meta.trim ?? 0,
        blush: meta.blush ?? 0,
      });
      return idx;
    };

    const addTubeGrid = (vSteps, uSteps, sampleFn, capStart = false, capEnd = false) => {
      const rings = [];
      const ringCenters = [];
      for (let iv = 0; iv <= vSteps; iv++) {
        const v = iv / vSteps;
        const ring = [];
        let sumCx = 0, sumCy = 0, sumCz = 0;
        for (let iu = 0; iu < uSteps; iu++) {
          const theta = (iu / uSteps) * Math.PI * 2;
          const pt = sampleFn(v, theta);
          sumCx += pt.cx ?? 0;
          sumCy += pt.cy ?? pt.y;
          sumCz += pt.cz ?? 0;
          ring.push(addVertex(pt.x, pt.y, pt.z, pt.bones, pt.weights, pt.meta));
        }
        ringCenters.push([sumCx / uSteps, sumCy / uSteps, sumCz / uSteps]);
        rings.push(ring);
      }

      // Check whether (a, c, b) has outward-pointing normal relative to the tube centerline
      const midIv = Math.floor(vSteps * 0.5);
      const ia = rings[midIv][0];
      const ib = rings[midIv][1];
      const ic = rings[midIv + 1][0];
      const ax = positions[ia * 3], ay = positions[ia * 3 + 1], az = positions[ia * 3 + 2];
      const bx = positions[ib * 3], by = positions[ib * 3 + 1], bz = positions[ib * 3 + 2];
      const cxp = positions[ic * 3], cyp = positions[ic * 3 + 1], czp = positions[ic * 3 + 2];
      const ux = cxp - ax, uy = cyp - ay, uz = czp - az;
      const vx = bx - ax, vy = by - ay, vz = bz - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const [rcx, rcy, rcz] = ringCenters[midIv];
      const flipWinding = (ax - rcx) * nx + (ay - rcy) * ny + (az - rcz) * nz < 0;

      for (let iv = 0; iv < vSteps; iv++) {
        const r0 = rings[iv];
        const r1 = rings[iv + 1];
        for (let iu = 0; iu < uSteps; iu++) {
          const iuNext = (iu + 1) % uSteps;
          const a = r0[iu];
          const b = r0[iuNext];
          const c = r1[iu];
          const d = r1[iuNext];
          if (flipWinding) {
            indices.push(a, b, c, b, d, c);
          } else {
            indices.push(a, c, b, b, c, d);
          }
        }
      }
      if (capStart) {
        const p0 = sampleFn(0, 0);
        const centerIdx = addVertex(p0.cx ?? 0, p0.cy ?? p0.y, p0.cz ?? 0, p0.bones, p0.weights, p0.meta);
        const r0 = rings[0];
        for (let iu = 0; iu < uSteps; iu++) {
          if (flipWinding) {
            indices.push(centerIdx, r0[iu], r0[(iu + 1) % uSteps]);
          } else {
            indices.push(centerIdx, r0[(iu + 1) % uSteps], r0[iu]);
          }
        }
      }
      if (capEnd) {
        const p1 = sampleFn(1, 0);
        const centerIdx = addVertex(p1.cx ?? 0, p1.cy ?? p1.y, p1.cz ?? 0, p1.bones, p1.weights, p1.meta);
        const rLast = rings[vSteps];
        for (let iu = 0; iu < uSteps; iu++) {
          if (flipWinding) {
            indices.push(centerIdx, rLast[(iu + 1) % uSteps], rLast[iu]);
          } else {
            indices.push(centerIdx, rLast[iu], rLast[(iu + 1) % uSteps]);
          }
        }
      }
    };

    // 1. SEAMLESS TORSO + PELVIS + NECK (y = 0.865 .. 1.615)
    addTubeGrid(116, 80, (v, theta) => {
      let y = THREE.MathUtils.lerp(0.865, 1.615, v);
      const cosT = Math.cos(theta); // +1 left (+X), -1 right (-X)
      const sinT = Math.sin(theta); // +1 front (+Z), -1 back (-Z)
      const absCos = Math.abs(cosT);

      const centerZ =
        -0.036 * smoothstep(1.30, 1.50, y) +
        0.012 * smoothstep(1.50, 1.60, y) +
        0.010 * gaussian(y, 1.15, 0.085) -
        0.008 * gaussian(y, 0.96, 0.065);

      const neckBlend = smoothstep(1.435, 1.500, y);
      const hipCurve = 0.048 * gaussian(y, 0.965, 0.082);
      const waistWidth = 0.105;
      const ribWidth = 0.030 * smoothstep(1.17, 1.38, y) * (1 - smoothstep(1.42, 1.48, y));
      const shoulderCurve = 0.012 * gaussian(y, 1.415, 0.032);
      const bodyHalfX = (waistWidth + hipCurve + ribWidth + shoulderCurve) * (1 - neckBlend) + 0.043 * neckBlend;

      const pelvisTaper = smoothstep(0.0, 0.055, v);
      const halfX = THREE.MathUtils.lerp(0.058, bodyHalfX, pelvisTaper);

      const bodyFrontZ =
        (0.090 + 0.012 * gaussian(y, 1.12, 0.065) + 0.012 * gaussian(y, 1.34, 0.075)) * (1 - neckBlend) +
        0.043 * neckBlend;
      const bodyBackZ =
        (0.086 + 0.022 * gaussian(y, 1.36, 0.075) + 0.016 * gaussian(y, 0.96, 0.065)) * (1 - neckBlend) +
        0.044 * neckBlend;
      const depthScale = THREE.MathUtils.lerp(0.62, 1.0, pelvisTaper);

      const nPower = 1.0 - 0.10 * bandWindow(y, 0.96, 1.05, 1.36, 1.43);
      const rCos = Math.sign(cosT) * Math.pow(absCos, nPower);
      const rSin = Math.sign(sinT) * Math.pow(Math.abs(sinT), nPower);

      let x = halfX * rCos;
      let z = centerZ + (sinT >= 0 ? bodyFrontZ * depthScale * rSin : bodyBackZ * depthScale * rSin);

      let bustFactor = 0;
      let underbustCrease = 0;
      if (sinT > 0 && y > 1.23 && y < 1.43) {
        const dy = y - 1.330;
        const sigmaY = dy >= 0 ? 0.050 : 0.035;
        const vProfile = Math.exp(-0.5 * (dy / sigmaY) * (dy / sigmaY));
        const leftBreast = gaussian(x, 0.058, 0.041);
        const rightBreast = gaussian(x, -0.058, 0.041);
        const sternumBridge = 0.15 * gaussian(x, 0, 0.024);
        bustFactor = (leftBreast + rightBreast + sternumBridge) * vProfile * Math.pow(sinT, 0.65);

        z += 0.052 * bustFactor;
        x += Math.sign(x) * 0.008 * bustFactor * smoothstep(0.02, 0.07, Math.abs(x));
        y -= 0.006 * bustFactor * (dy < 0 ? 1.2 : 0.5);
        underbustCrease = gaussian(y, 1.275, 0.016) * (leftBreast + rightBreast) * sinT;
      }

      let linea = 0, navel = 0;
      if (sinT > 0.4 && y > 1.08 && y < 1.28) {
        linea = 0.0035 * gaussian(x, 0, 0.012) * bandWindow(y, 1.12, 1.15, 1.25, 1.28);
        navel = 0.0045 * gaussian(x, 0, 0.010) * gaussian(y, 1.132, 0.010);
        z -= (linea + navel) * sinT;
      }

      let gluteCrease = 0, spineGroove = 0;
      if (sinT < 0) {
        const backSin = -sinT;
        spineGroove = 0.006 * gaussian(x, 0, 0.016) * bandWindow(y, 1.02, 1.08, 1.38, 1.44);
        z += spineGroove * backSin;

        if (y < 1.06) {
          const gluteY = gaussian(y, 0.945, 0.054) * smoothstep(0.01, 0.12, v);
          const gluteLobe = gaussian(Math.abs(x), 0.058, 0.046);
          const cleft = 1 - 0.42 * gaussian(x, 0, 0.014);
          const glute = 0.033 * gluteY * gluteLobe * cleft * Math.pow(backSin, 0.7);
          z -= glute;
          x += Math.sign(x) * 0.005 * gluteY * gluteLobe;
          gluteCrease = (gaussian(x, 0, 0.014) * 0.6 + gaussian(y, 0.892, 0.016) * 0.7) * backSin;
        }
      }

      const sternumValley = sinT > 0.3 ? gaussian(x, 0, 0.018) * bandWindow(y, 1.27, 1.30, 1.38, 1.41) * 0.15 : 0;
      const waistContour = gaussian(y, 1.185, 0.045) * (0.06 * absCos + 0.04);
      const clavicleHighlight = sinT > 0.2 ? gaussian(y, 1.430, 0.014) * bandWindow(Math.abs(x), 0.025, 0.045, 0.09, 0.12) * 0.08 : 0;
      const shade = 1.0
        - 0.20 * underbustCrease
        - sternumValley
        - waistContour
        - 16 * (linea + navel * 1.8)
        - 12 * spineGroove
        - 0.18 * gluteCrease
        + 0.07 * bustFactor
        + clavicleHighlight;

      // Pure horizontal ring-aligned studio bandeau top & high-waisted shorts
      const vY = THREE.MathUtils.lerp(0.865, 1.615, v);
      const topBand = bandWindow(vY, 1.260, 1.266, 1.376, 1.382);
      const shortsBand = 1 - smoothstep(1.082, 1.088, vY);
      const attire = Math.max(topBand, shortsBand);
      const trim = Math.max(
        gaussian(vY, 1.264, 0.0045),
        gaussian(vY, 1.379, 0.0045),
        gaussian(vY, 1.085, 0.0048),
      );

      const wHips = 1 - smoothstep(1.02, 1.13, y);
      const wSpine = smoothstep(1.02, 1.13, y) * (1 - smoothstep(1.16, 1.24, y));
      const wSpine1 = smoothstep(1.16, 1.24, y) * (1 - smoothstep(1.26, 1.34, y));
      const wSpine2 = smoothstep(1.26, 1.34, y) * (1 - smoothstep(1.45, 1.51, y));
      const wNeck = smoothstep(1.45, 1.51, y) * (1 - smoothstep(1.56, 1.61, y));
      const wHead = smoothstep(1.56, 1.61, y);

      const bones = [B.Hips, B.Spine, B.Spine1, B.Spine2, B.Neck, B.Head];
      const weights = [wHips, wSpine, wSpine1, wSpine2, wNeck, wHead];

      if (y < 0.99 && Math.abs(x) > 0.025) {
        const legShare = (1 - smoothstep(0.865, 0.99, y)) * smoothstep(0.025, 0.10, Math.abs(x)) * 0.65;
        bones.push(x >= 0 ? B.LeftUpLeg : B.RightUpLeg);
        weights.push(legShare);
      }
      if (y > 1.36 && y < 1.48 && Math.abs(x) > 0.06) {
        const shShare = bandWindow(y, 1.36, 1.40, 1.45, 1.48) * smoothstep(0.06, 0.14, Math.abs(x)) * 0.65;
        bones.push(x >= 0 ? B.LeftShoulder : B.RightShoulder);
        weights.push(shShare);
      }

      return {
        x, y, z, cx: 0, cy: y, cz: centerZ, bones, weights,
        meta: { part: 'torso', y, x, z, shade, attire, trim },
      };
    }, true, true);

    // 2. SEAMLESS LEFT & RIGHT LEGS (Ankle y = 0.055 .. Hip/Pelvis blend y = 1.035)
    for (const side of [1, -1]) {
      const upLegBone = side > 0 ? B.LeftUpLeg : B.RightUpLeg;
      const legBone = side > 0 ? B.LeftLeg : B.RightLeg;
      const footBone = side > 0 ? B.LeftFoot : B.RightFoot;

      addTubeGrid(76, 44, (v, theta) => {
        const y = THREE.MathUtils.lerp(0.055, 1.035, v);
        const cosT = Math.cos(theta); // +1 outer, -1 inner
        const sinT = Math.sin(theta); // +1 front, -1 back

        const ankleBlend = 1 - smoothstep(0.055, 0.18, y);
        const hipInward = smoothstep(0.88, 1.035, y);
        const cx = side * THREE.MathUtils.lerp(0.0821, 0.064, hipInward);
        const cz = -0.022 * ankleBlend + 0.003 * gaussian(y, 0.53, 0.16) - 0.005 * smoothstep(0.82, 1.02, y);

        const calfBulge = gaussian(y, 0.345, 0.068);
        const kneeZone = gaussian(y, 0.525, 0.042);
        const thighCurve = smoothstep(0.50, 0.93, y);
        const topCapTaper = 1 - 0.15 * smoothstep(0.98, 1.035, y);

        const rOuter = (0.034 + 0.020 * calfBulge + 0.015 * kneeZone + 0.047 * Math.pow(thighCurve, 0.80)) * topCapTaper;
        const rInner = (0.033 + 0.016 * calfBulge + 0.014 * kneeZone + 0.046 * Math.pow(thighCurve, 0.68)) * (1 - 0.18 * smoothstep(0.95, 1.035, y));
        const rFront = (0.038 + 0.013 * calfBulge + 0.015 * kneeZone + 0.048 * Math.pow(thighCurve, 0.80)) * topCapTaper;
        const rBack = (0.040 + 0.028 * calfBulge + 0.012 * kneeZone + 0.058 * Math.pow(thighCurve, 0.80)) * topCapTaper;

        const rx = cosT >= 0 ? rOuter : rInner;
        const rz = sinT >= 0 ? rFront : rBack;

        const x = cx + side * rx * cosT;
        const z = cz + rz * sinT;

        const innerThighAO = (cosT < 0 ? -cosT : 0) * smoothstep(0.62, 0.92, y) * 0.14;
        const kneeHollowAO = (sinT < 0 ? -sinT : 0) * gaussian(y, 0.525, 0.032) * 0.15;
        const kneeCapHighlight = (sinT > 0 ? sinT : 0) * gaussian(y, 0.53, 0.032) * 0.06;
        const shinHighlight = (sinT > 0.5 ? sinT : 0) * bandWindow(y, 0.18, 0.24, 0.44, 0.49) * 0.04;
        const shade = 1.0 - innerThighAO - kneeHollowAO + kneeCapHighlight + shinHighlight;

        const attire = smoothstep(0.832, 0.838, y);
        const trim = gaussian(y, 0.835, 0.0045);

        const wFoot = 1 - smoothstep(0.065, 0.135, y);
        const wKnee = smoothstep(0.065, 0.135, y) * (1 - smoothstep(0.475, 0.585, y));
        const wThigh = smoothstep(0.475, 0.585, y) * (1 - smoothstep(0.88, 1.00, y));
        const wHip = smoothstep(0.88, 1.00, y);

        return {
          x, y, z, cx, cy: y, cz,
          bones: [footBone, legBone, upLegBone, B.Hips],
          weights: [wFoot, wKnee, wThigh, wHip],
          meta: { part: 'leg', y, x, z, shade, attire, trim },
        };
      }, false, true);
    }

    // 3. SEAMLESS LEFT & RIGHT ARMS (Pivot-centered deltoid & elbow hemispheres so 90°+ bends never pinch)
    for (const side of [1, -1]) {
      const shoulderBone = side > 0 ? B.LeftShoulder : B.RightShoulder;
      const armBone = side > 0 ? B.LeftArm : B.RightArm;
      const foreArmBone = side > 0 ? B.LeftForeArm : B.RightForeArm;
      const handBone = side > 0 ? B.LeftHand : B.RightHand;

      const cy = 1.4406;
      const cz = -0.0555;

      // 3a. Clavicle / Trapezius / Shoulder Socket (from chest u=0.050 to a hemisphere centered on Arm pivot u=0.1516)
      addTubeGrid(28, 36, (v, theta) => {
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);

        let u, ry, rz, curCy, curCz;
        if (v <= 0.72) {
          const t = v / 0.72;
          u = THREE.MathUtils.lerp(0.050, 0.1516, t);
          curCy = THREE.MathUtils.lerp(1.418, cy, smoothstep(0.0, 0.85, t));
          curCz = THREE.MathUtils.lerp(-0.024, cz, smoothstep(0.0, 0.85, t));
          ry = THREE.MathUtils.lerp(0.060, 0.050, smoothstep(0.0, 0.9, t));
          rz = THREE.MathUtils.lerp(0.066, 0.051, smoothstep(0.0, 0.9, t));
        } else {
          // Outer hemisphere centered on the exact Arm pivot (u=0.1516, cy=1.4406, cz=-0.0555)
          const phi = ((v - 0.72) / 0.28) * (Math.PI * 0.5);
          u = 0.1516 + 0.050 * Math.sin(phi);
          curCy = cy;
          curCz = cz;
          ry = 0.050 * Math.cos(phi);
          rz = 0.051 * Math.cos(phi);
        }

        const x = side * u;
        const y = curCy + ry * cosT;
        const z = curCz + rz * sinT;

        const trapHighlight = (cosT > 0 ? cosT : 0) * 0.05;
        const axillaAO = (cosT < 0 ? -cosT : 0) * smoothstep(0.08, 0.15, u) * 0.14;
        const shade = 1.0 + trapHighlight - axillaAO;

        const wSpine = 1 - smoothstep(0.050, 0.115, u);
        const wShoulder = smoothstep(0.050, 0.115, u);

        return {
          x, y, z, cx: x, cy: curCy, cz: curCz,
          bones: [B.Spine2, shoulderBone],
          weights: [wSpine, wShoulder],
          meta: { part: 'arm', y, x, z, u, shade, attire: 0, trim: 0 },
        };
      }, true, true);

      // 3b. Upper Arm + Spherical Deltoid Cap (centered at u=0.1516) + Spherical Elbow Condyle (centered at u=0.4300)
      addTubeGrid(44, 36, (v, theta) => {
        const cosT = Math.cos(theta); // +1 top (+Y), -1 bottom (-Y)
        const sinT = Math.sin(theta); // +1 front (+Z), -1 back (-Z)

        let u, ry, rz;
        if (v < 0.26) {
          // Spherical deltoid cap centered on the exact Arm pivot (u = 0.1516)
          const phi = (v / 0.26) * (Math.PI * 0.5); // 0 (medial pole) .. pi/2 (equator at u=0.1516)
          const sinP = Math.sin(phi);
          const cosP = Math.cos(phi);
          u = 0.1516 - 0.050 * cosP;
          ry = 0.050 * sinP;
          rz = 0.051 * sinP;
        } else if (v <= 0.82) {
          // Upper arm shaft from u = 0.1516 to u = 0.4300
          const t = (v - 0.26) / (0.82 - 0.26);
          u = THREE.MathUtils.lerp(0.1516, 0.4300, t);
          const deltoidTaper = 1 - smoothstep(0.0, 0.34, t);
          const bicep = bandWindow(t, 0.12, 0.28, 0.68, 0.88);
          ry = THREE.MathUtils.lerp(0.041, 0.035, t) + 0.009 * deltoidTaper + 0.004 * bicep;
          rz = THREE.MathUtils.lerp(0.042, 0.036, t) + 0.009 * deltoidTaper + 0.004 * bicep;
        } else {
          // Spherical elbow condyle cap centered at u = 0.4300
          const phi = ((v - 0.82) / 0.18) * (Math.PI * 0.5); // 0 (equator at u=0.4300) .. pi/2 (distal pole)
          const sinP = Math.sin(phi);
          const cosP = Math.cos(phi);
          u = 0.4300 + 0.035 * sinP;
          ry = 0.035 * cosP;
          rz = 0.036 * cosP;
        }

        const x = side * u;
        const y = cy + ry * cosT;
        const z = cz + rz * sinT;

        const deltoid = gaussian(u, 0.155, 0.042);
        const axillaAO = (cosT < 0 ? -cosT : 0) * gaussian(u, 0.16, 0.04) * 0.15;
        const deltoidHighlight = (cosT > 0 ? cosT : 0) * deltoid * 0.06;
        const shade = 1.0 - axillaAO + deltoidHighlight;

        return {
          x, y, z, cx: x, cy, cz,
          bones: [armBone],
          weights: [1.0],
          meta: { part: 'arm', y, x, z, u, shade, attire: 0, trim: 0 },
        };
      }, true, true);

      // 3b. Forearm + Spherical Olecranon (Elbow) Cap (centered at u=0.4300) + Wrist (u=0.726)
      addTubeGrid(40, 34, (v, theta) => {
        const cosT = Math.cos(theta);
        const sinT = Math.sin(theta);

        let u, ry, rz;
        if (v < 0.22) {
          // Spherical elbow cap centered at u = 0.4300
          const phi = (v / 0.22) * (Math.PI * 0.5);
          const sinP = Math.sin(phi);
          const cosP = Math.cos(phi);
          u = 0.4300 - 0.035 * cosP;
          ry = 0.035 * sinP;
          rz = 0.036 * sinP;
        } else {
          const t = (v - 0.22) / (1.0 - 0.22);
          u = THREE.MathUtils.lerp(0.4300, 0.726, t);
          const forearmBelly = gaussian(t, 0.22, 0.18);
          const wristTaper = smoothstep(0.15, 0.95, t);
          ry = THREE.MathUtils.lerp(0.035, 0.022, wristTaper) + 0.0035 * forearmBelly;
          rz = THREE.MathUtils.lerp(0.036, 0.029, wristTaper) + 0.0035 * forearmBelly;
        }

        const x = side * u;
        const y = cy + ry * cosT;
        const z = cz + rz * sinT;

        const elbowCreaseAO = (sinT > 0 ? sinT : 0) * gaussian(u, 0.44, 0.028) * 0.10;
        const shade = 1.0 - elbowCreaseAO;

        const wForeArm = 1 - smoothstep(0.685, 0.718, u);
        const wHand = smoothstep(0.685, 0.718, u);

        return {
          x, y, z, cx: x, cy, cz,
          bones: [foreArmBone, handBone],
          weights: [wForeArm, wHand],
          meta: { part: 'arm', y, x, z, u, shade, attire: 0, trim: 0 },
        };
      }, true, true);

      // 3c. Seamless Sculpted Palm & Back of Hand (u = 0.704 .. 0.808)
      addTubeGrid(24, 32, (v, theta) => {
        const cosT = Math.cos(theta); // +1 dorsal (top, +Y), -1 palmar (bottom, -Y)
        const sinT = Math.sin(theta); // +1 thumb/index side (+Z), -1 pinky side (-Z)

        const u = THREE.MathUtils.lerp(0.704, 0.808, v);
        const spread = smoothstep(0.0, 0.78, v);
        const knuckleCap = v <= 0.86 ? 1.0 : Math.cos(((v - 0.86) / 0.14) * (Math.PI * 0.42));

        const curCy = THREE.MathUtils.lerp(cy, 1.4382, spread);
        const curCz = THREE.MathUtils.lerp(cz, -0.0632, spread);

        const ry = THREE.MathUtils.lerp(0.0215, 0.0138, spread) * knuckleCap;
        const rz = THREE.MathUtils.lerp(0.0285, 0.0415, spread) * knuckleCap;

        // Flattened oval cross-section for a natural hand silhouette
        const rCos = Math.sign(cosT) * Math.pow(Math.abs(cosT), 0.86);
        const rSin = Math.sign(sinT) * Math.pow(Math.abs(sinT), 0.86);

        const x = side * u;
        let y = curCy + ry * rCos;
        let z = curCz + rz * rSin;

        // Soft thenar (thumb-base) fullness on the front-palmar side and subtle palm hollow
        const thenar = gaussian(u, 0.742, 0.022) * Math.max(0, sinT) * Math.max(0, -cosT + 0.35);
        const palmHollow = gaussian(u, 0.768, 0.022) * Math.max(0, -cosT) * (1 - Math.abs(sinT) * 0.7);
        y += -0.0055 * thenar + 0.0030 * palmHollow;
        z += 0.0095 * thenar;

        const shade = 1.0 - 0.10 * palmHollow + (cosT > 0 ? 0.03 * cosT : -0.04 * -cosT);
        const wForeArm = 1 - smoothstep(0.704, 0.724, u);
        const wHand = smoothstep(0.704, 0.724, u);

        return {
          x, y, z, cx: x, cy: curCy, cz: curCz,
          bones: [foreArmBone, handBone],
          weights: [wForeArm, wHand],
          meta: { part: 'hand', y, x, z, u, shade, attire: 0, trim: 0 },
        };
      }, true, true);

      // 3d. Seamless Sculpted Fingers (Index, Middle, Ring, Pinky — no skeletal gaps!)
      const sidePrefix = side > 0 ? 'LeftHand' : 'RightHand';
      const fingerSpecs = [
        { name: 'Index', uStart: 0.792, u1: 0.8044, u2: 0.8414, u3: 0.8699, uEnd: 0.903, fy: 1.4354, fz: -0.0329, rBase: 0.0094, rTip: 0.0064 },
        { name: 'Middle', uStart: 0.796, u1: 0.8087, u2: 0.8457, u3: 0.8752, uEnd: 0.910, fy: 1.4406, fz: -0.0555, rBase: 0.0098, rTip: 0.0066 },
        { name: 'Ring', uStart: 0.792, u1: 0.8044, u2: 0.8370, u3: 0.8662, uEnd: 0.898, fy: 1.4402, fz: -0.0741, rBase: 0.0092, rTip: 0.0062 },
        { name: 'Pinky', uStart: 0.784, u1: 0.7941, u2: 0.8301, u3: 0.8511, uEnd: 0.878, fy: 1.4357, fz: -0.0935, rBase: 0.0082, rTip: 0.0055 },
      ];

      for (const f of fingerSpecs) {
        const b1 = this.findBoneIndex(skeleton, `${sidePrefix}${f.name}1`);
        const b2 = this.findBoneIndex(skeleton, `${sidePrefix}${f.name}2`);
        const b3 = this.findBoneIndex(skeleton, `${sidePrefix}${f.name}3`);
        if (b1 < 0 || b2 < 0 || b3 < 0) continue;

        addTubeGrid(20, 16, (v, theta) => {
          const cosT = Math.cos(theta);
          const sinT = Math.sin(theta);

          const u = THREE.MathUtils.lerp(f.uStart, f.uEnd, v);
          const tipDome = v <= 0.85 ? 1.0 : Math.cos(((v - 0.85) / 0.15) * (Math.PI * 0.48));
          const r = THREE.MathUtils.lerp(f.rBase, f.rTip, smoothstep(0.0, 0.85, v)) * tipDome;
          // Subtle knuckle contour and pad fullness
          const jointContour = 1 + 0.05 * (gaussian(u, f.u2, 0.006) + gaussian(u, f.u3, 0.005));
          const ry = r * 0.92 * jointContour;
          const rz = r * 1.04 * jointContour;

          const x = side * u;
          const y = f.fy + ry * cosT;
          const z = f.fz + rz * sinT;

          // Subtle crease shading between adjacent fingers and on palmar creases
          const interFingerAO = (1 - Math.abs(cosT)) * (1 - smoothstep(0.0, 0.45, v)) * 0.12;
          const palmarCrease = (cosT < 0 ? -cosT : 0) * (gaussian(u, f.u2, 0.004) + gaussian(u, f.u3, 0.004)) * 0.10;
          const shade = 1.0 - interFingerAO - palmarCrease + (cosT > 0 ? 0.03 * cosT : 0);

          const wHand = 1 - smoothstep(f.uStart, f.u1 + 0.008, u);
          const w1 = smoothstep(f.uStart, f.u1 + 0.008, u) * (1 - smoothstep(f.u2 - 0.006, f.u2 + 0.006, u));
          const w2 = smoothstep(f.u2 - 0.006, f.u2 + 0.006, u) * (1 - smoothstep(f.u3 - 0.005, f.u3 + 0.005, u));
          const w3 = smoothstep(f.u3 - 0.005, f.u3 + 0.005, u);

          return {
            x, y, z, cx: x, cy: f.fy, cz: f.fz,
            bones: [handBone, b1, b2, b3],
            weights: [wHand, w1, w2, w3],
            meta: { part: 'finger', y, x, z, u, shade, attire: 0, trim: 0, blush: smoothstep(0.65, 0.98, v) * 0.5 },
          };
        }, true, true);
      }

      // 3e. Seamless Sculpted Thumb (Thumb1 -> Thumb4)
      const tb1 = this.findBoneIndex(skeleton, `${sidePrefix}Thumb1`);
      const tb2 = this.findBoneIndex(skeleton, `${sidePrefix}Thumb2`);
      const tb3 = this.findBoneIndex(skeleton, `${sidePrefix}Thumb3`);
      if (tb1 >= 0 && tb2 >= 0 && tb3 >= 0) {
        const pStart = new THREE.Vector3(side * 0.725, 1.433, -0.038);
        const pEnd = new THREE.Vector3(side * 0.821, 1.377, 0.019);
        const axis = pEnd.clone().sub(pStart).normalize();
        const upRef = new THREE.Vector3(0, 1, 0);
        const n2 = new THREE.Vector3().crossVectors(axis, upRef).normalize();
        const n1 = new THREE.Vector3().crossVectors(n2, axis).normalize();

        addTubeGrid(18, 16, (v, theta) => {
          const cosT = Math.cos(theta);
          const sinT = Math.sin(theta);

          const center = pStart.clone().lerp(pEnd, v);
          const tipDome = v <= 0.84 ? 1.0 : Math.cos(((v - 0.84) / 0.16) * (Math.PI * 0.48));
          const r = THREE.MathUtils.lerp(0.0138, 0.0074, smoothstep(0.0, 0.84, v)) * tipDome;

          const x = center.x + r * (cosT * n1.x + sinT * n2.x);
          const y = center.y + r * (cosT * n1.y + sinT * n2.y);
          const z = center.z + r * (cosT * n1.z + sinT * n2.z);

          const shade = 1.0 + (cosT > 0 ? 0.03 * cosT : -0.05 * -cosT);
          const wHand = 1 - smoothstep(0.0, 0.22, v);
          const w1 = smoothstep(0.0, 0.22, v) * (1 - smoothstep(0.42, 0.56, v));
          const w2 = smoothstep(0.42, 0.56, v) * (1 - smoothstep(0.70, 0.82, v));
          const w3 = smoothstep(0.70, 0.82, v);

          return {
            x, y, z, cx: center.x, cy: center.y, cz: center.z,
            bones: [handBone, tb1, tb2, tb3],
            weights: [wHand, w1, w2, w3],
            meta: { part: 'finger', y, x, z, u: Math.abs(center.x), shade, attire: 0, trim: 0, blush: smoothstep(0.65, 0.98, v) * 0.5 },
          };
        }, true, true);
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
    geom.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
    const colors = new Float32Array(positions.length);
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();

    const mat = this.surfaceMesh.material.clone();
    mat.name = 'FemaleSeamlessSkinMaterial';
    mat.color.set('#ffffff');
    mat.vertexColors = true;
    mat.roughness = 0.52;
    mat.metalness = 0.03;

    const skinned = new THREE.SkinnedMesh(geom, mat);
    skinned.name = 'FemaleSeamlessBody';
    skinned.userData.isCosmetic = true;
    skinned.castShadow = true;
    skinned.receiveShadow = true;
    skinned.bind(skeleton, this.surfaceMesh.bindMatrix);
    skinned.visible = false;

    this.seamlessMesh = skinned;
    this.updateSeamlessVertexColors('studio');
    this.surfaceMesh.parent.add(skinned);
  }

  updateSeamlessVertexColors(finish = 'studio') {
    if (!this.seamlessMesh) return;
    const colorAttr = this.seamlessMesh.geometry.attributes.color;
    const normAttr = this.seamlessMesh.geometry.attributes.normal;
    if (!colorAttr) return;

    const baseSkin = new THREE.Color(finish === 'clay' ? '#c99374' : '#dfa88c');
    const warmBlush = new THREE.Color('#d47d6a');
    const shadowTone = new THREE.Color(finish === 'clay' ? '#7d5038' : '#965d47');
    const attireColor = new THREE.Color('#252932');
    const trimColor = new THREE.Color('#c4a47c');
    const fabricC = new THREE.Color();
    const c = new THREE.Color();

    for (let i = 0; i < this.vertexMeta.length; i++) {
      const m = this.vertexMeta[i];
      const ny = normAttr ? normAttr.getY(i) : 0;
      const nz = normAttr ? normAttr.getZ(i) : 0;

      c.copy(baseSkin);
      const kneeBlush = m.part === 'leg' ? gaussian(m.y, 0.53, 0.04) * Math.max(0, nz) * 0.20 : 0;
      const shBlush = m.part === 'arm' && m.u ? gaussian(m.u, 0.16, 0.04) * 0.16 : 0;
      const chestGlow = m.part === 'torso' ? gaussian(m.y, 1.38, 0.06) * Math.max(0, nz) * 0.14 : 0;
      const tipBlush = (m.blush || 0) * 0.28;
      c.lerp(warmBlush, Math.min(0.38, kneeBlush + shBlush + chestGlow + tipBlush));

      const hemi = THREE.MathUtils.clamp(0.95 + 0.08 * ny + 0.04 * nz, 0.82, 1.06);
      const totalShade = THREE.MathUtils.clamp(m.shade * hemi, 0.68, 1.08);
      if (totalShade < 1.0) {
        c.lerp(shadowTone, (1.0 - totalShade) * 1.45);
      } else {
        c.multiplyScalar(totalShade);
      }

      if (finish === 'studio' && m.attire > 0.001) {
        fabricC.copy(attireColor).lerp(trimColor, Math.min(1, m.trim * 0.9));
        const fabricShade = THREE.MathUtils.clamp(0.88 + 0.14 * m.shade + 0.06 * ny, 0.72, 1.12);
        fabricC.multiplyScalar(fabricShade);
        c.lerp(fabricC, Math.min(1, m.attire));
      }

      colorAttr.setXYZ(i, c.r, c.g, c.b);
    }
    colorAttr.needsUpdate = true;
  }

  sculptBindPositions(positions, isJoints) {
    const count = positions.length / 3;
    for (let i = 0; i < count; i++) {
      const idx = i * 3;
      let x = positions[idx];
      let y = positions[idx + 1];
      let z = positions[idx + 2];
      const absX = Math.abs(x);
      const signX = x >= 0 ? 1 : -1;

      if (absX < 0.175 && y > 1.04 && y < 1.34) {
        const wWaist = bandWindow(y, 1.04, 1.11, 1.26, 1.34);
        const waistCurve = Math.pow((y - 1.185) / 0.13, 2);
        const targetHalfX = 0.114 + 0.032 * Math.min(1.2, waistCurve);
        if (absX < targetHalfX) {
          x = signX * THREE.MathUtils.lerp(absX, targetHalfX, 0.85 * wWaist);
        }
      }
      if (!isJoints && y > 1.58 && y < 1.70 && z > 0.01) {
        const jawTaper = 0.007 * bandWindow(y, 1.58, 1.60, 1.66, 1.69) * smoothstep(0.025, 0.08, absX);
        x -= signX * jawTaper;
      }

      positions[idx] = x;
      positions[idx + 1] = y;
      positions[idx + 2] = z;
    }
  }

  computeWeldedNormals(geom, positions) {
    const index = geom.index ? geom.index.array : null;
    const count = positions.length / 3;
    const normals = new Float32Array(positions.length);
    if (!index) return normals;

    const pA = new THREE.Vector3(), pB = new THREE.Vector3(), pC = new THREE.Vector3();
    const cb = new THREE.Vector3(), ab = new THREE.Vector3();

    for (let i = 0; i < index.length; i += 3) {
      const vA = index[i] * 3, vB = index[i + 1] * 3, vC = index[i + 2] * 3;
      pA.fromArray(positions, vA);
      pB.fromArray(positions, vB);
      pC.fromArray(positions, vC);
      cb.subVectors(pC, pB);
      ab.subVectors(pA, pB);
      cb.cross(ab);
      normals[vA] += cb.x; normals[vA + 1] += cb.y; normals[vA + 2] += cb.z;
      normals[vB] += cb.x; normals[vB + 1] += cb.y; normals[vB + 2] += cb.z;
      normals[vC] += cb.x; normals[vC + 1] += cb.y; normals[vC + 2] += cb.z;
    }

    const buckets = new Map();
    for (let i = 0; i < count; i++) {
      const idx = i * 3;
      const key = `${Math.round(positions[idx] * 2500)},${Math.round(positions[idx + 1] * 2500)},${Math.round(positions[idx + 2] * 2500)}`;
      let entry = buckets.get(key);
      if (!entry) {
        entry = { nx: 0, ny: 0, nz: 0, indices: [] };
        buckets.set(key, entry);
      }
      entry.nx += normals[idx];
      entry.ny += normals[idx + 1];
      entry.nz += normals[idx + 2];
      entry.indices.push(idx);
    }

    for (const entry of buckets.values()) {
      const len = Math.hypot(entry.nx, entry.ny, entry.nz) || 1;
      const nx = entry.nx / len, ny = entry.ny / len, nz = entry.nz / len;
      for (const idx of entry.indices) {
        normals[idx] = nx;
        normals[idx + 1] = ny;
        normals[idx + 2] = nz;
      }
    }
    return normals;
  }

  createHeadCosmetics() {
    const headBone = this.allBones.find((b) => b.name.replace(/^mixamorig[:_]?/i, '') === 'Head');
    if (!headBone) return;
    this.model.updateMatrixWorld(true);
    const invHead = headBone.matrixWorld.clone().invert();

    const group = new THREE.Group();
    group.name = 'FemaleHairCosmetic';
    group.userData.isCosmetic = true;
    group.visible = false;

    const hairMat = new THREE.MeshStandardMaterial({
      name: 'FemaleHairMaterial',
      color: '#2c1e18',
      roughness: 0.42,
      metalness: 0.08,
    });
    this.hairMat = hairMat;

    const addWorldPart = (geom, mat) => {
      geom.applyMatrix4(invHead);
      geom.computeVertexNormals();
      const mesh = new THREE.Mesh(geom, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.isCosmetic = true;
      group.add(mesh);
      return mesh;
    };

    // Sculpted Hair Crown + Side Curtain Bangs + Chignon Bun
    const crownGeom = new THREE.SphereGeometry(1, 32, 24);
    const crownPos = crownGeom.attributes.position;
    for (let i = 0; i < crownPos.count; i++) {
      const ux = crownPos.getX(i);
      const uy = crownPos.getY(i);
      const uz = crownPos.getZ(i);
      let x = ux * 0.095;
      let y = 1.708 + uy * 0.108;
      let z = -0.006 + uz * 0.132;

      if (uz > 0.05 && uy < 0.25) {
        const faceCut = smoothstep(0.05, 0.55, uz) * smoothstep(0.28, -0.45, uy);
        y += 0.085 * faceCut;
        z -= 0.055 * faceCut;
      }
      if (uy > 0.2) y += 0.008 * uy;
      if (uz < -0.2 && uy < -0.2) {
        x *= 0.88;
        z -= 0.008;
      }
      crownPos.setXYZ(i, x, y, z);
    }
    addWorldPart(crownGeom, hairMat);

    for (const side of [-1, 1]) {
      const sweepGeom = new THREE.SphereGeometry(1, 22, 16);
      sweepGeom.applyMatrix4(
        new THREE.Matrix4()
          .makeTranslation(side * 0.048, 1.742, 0.072)
          .multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.18, side * 0.38, -side * 0.46)))
          .multiply(new THREE.Matrix4().makeScale(0.052, 0.034, 0.064)),
      );
      addWorldPart(sweepGeom, hairMat);
    }

    const bunGeom = new THREE.SphereGeometry(1, 24, 18);
    bunGeom.applyMatrix4(
      new THREE.Matrix4()
        .makeTranslation(0, 1.668, -0.142)
        .multiply(new THREE.Matrix4().makeRotationX(-0.18))
        .multiply(new THREE.Matrix4().makeScale(0.058, 0.054, 0.062)),
    );
    addWorldPart(bunGeom, hairMat);

    this.hairGroup = group;
    this.headBone = headBone;
    headBone.add(group);
  }

  withoutCosmetics(callback) {
    const wasHairAttached = this.hairGroup && this.hairGroup.parent === this.headBone;
    if (wasHairAttached) this.headBone.remove(this.hairGroup);
    try {
      return callback();
    } finally {
      if (wasHairAttached) this.headBone.add(this.hairGroup);
    }
  }

  setEnabled(enabled, finish = enabled ? 'studio' : 'mannequin') {
    this.enabled = Boolean(enabled);
    this.finish = finish;
    const useFemaleBody = this.enabled && finish !== 'mannequin';
    const skinColor = finish === 'clay' ? '#c99374' : '#dfa88c';
    const skinRoughness = finish === 'clay' ? 0.44 : 0.52;

    for (const item of this.meshes) {
      const geom = item.mesh.geometry;
      const posAttr = geom.attributes.position;
      const normAttr = geom.attributes.normal;
      posAttr.array.set(useFemaleBody ? item.sculptedPos : item.origPos);
      normAttr.array.set(useFemaleBody ? item.sculptedNorm : item.origNorm);
      posAttr.needsUpdate = true;
      normAttr.needsUpdate = true;

      if (item.extremitiesIndex) {
        geom.setIndex(new THREE.BufferAttribute(useFemaleBody ? item.extremitiesIndex : item.origIndex, 1));
      }

      for (const material of [].concat(item.mesh.material)) {
        if (!useFemaleBody) {
          material.color.set(item.isJoints ? '#59616a' : '#d7cbb7');
          material.roughness = 0.63;
          material.metalness = 0.12;
        } else {
          material.color.set(skinColor);
          material.roughness = skinRoughness;
          material.metalness = finish === 'clay' ? 0.08 : 0.03;
        }
        material.needsUpdate = true;
      }
    }

    if (this.seamlessMesh) {
      this.seamlessMesh.visible = useFemaleBody;
      if (useFemaleBody) {
        this.updateSeamlessVertexColors(finish);
        this.seamlessMesh.material.roughness = skinRoughness;
        this.seamlessMesh.material.metalness = finish === 'clay' ? 0.08 : 0.03;
        this.seamlessMesh.material.needsUpdate = true;
      }
    }

    if (this.hairGroup) {
      this.hairGroup.visible = useFemaleBody;
      if (this.hairMat) {
        this.hairMat.color.set(finish === 'clay' ? '#9e6d52' : '#2c1e18');
      }
    }
  }
}
