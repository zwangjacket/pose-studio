import { Vector3, Quaternion, Euler, Matrix4, MathUtils } from 'three';
import { jointLimits } from './pose-guard.js';

const cleanName = name => name.replace(/^mixamorig[:_]?/i, '');
const rad = MathUtils.degToRad;
const X_AXIS = new Vector3(1, 0, 0);

const CHILD_TIP = {
  Spine: 'Spine1',
  Spine1: 'Spine2',
  Spine2: 'Neck',
  Neck: 'Head',
  Head: 'HeadTop_End',
  LeftShoulder: 'LeftArm',
  RightShoulder: 'RightArm',
  LeftArm: 'LeftForeArm',
  RightArm: 'RightForeArm',
  LeftForeArm: 'LeftHand',
  RightForeArm: 'RightHand',
  LeftHand: 'LeftHandMiddle3',
  RightHand: 'RightHandMiddle3',
  LeftUpLeg: 'LeftLeg',
  RightUpLeg: 'RightLeg',
  LeftLeg: 'LeftFoot',
  RightLeg: 'RightFoot',
  LeftFoot: 'LeftToeBase',
  RightFoot: 'RightToeBase',
  LeftToeBase: 'LeftToe_End',
  RightToeBase: 'RightToe_End',
};

export class RagdollIK {
  constructor(model, bones, poseGuard) {
    this.model = model;
    this.bones = bones;
    this.guard = poseGuard;
    this.byName = new Map(bones.map(bone => [cleanName(bone.name), bone]));
    this.rest = poseGuard.rest;
    this.model.updateMatrixWorld(true);
    const invModel = this.model.matrixWorld.clone().invert();
    this.restFootLocal = {
      Left: this.byName.get('LeftFoot')?.getWorldPosition(new Vector3()).applyMatrix4(invModel) || new Vector3(0.082, 0.088, -0.027),
      Right: this.byName.get('RightFoot')?.getWorldPosition(new Vector3()).applyMatrix4(invModel) || new Vector3(-0.082, 0.088, -0.027),
    };
  }

  isUpright() {
    const hips = this.byName.get('Hips');
    if (!hips) return true;
    const modelInvQ = this.model.getWorldQuaternion(new Quaternion()).invert();
    const hipsLocalQ = hips.getWorldQuaternion(new Quaternion()).premultiply(modelInvQ);
    return new Vector3(0, 1, 0).applyQuaternion(hipsLocalQ).y > 0.6;
  }

  beginDrag(boneName) {
    this.model.updateMatrixWorld(true);
    const name = cleanName(boneName);
    const bone = this.byName.get(name);
    if (!bone) return null;
    const invModel = this.model.matrixWorld.clone().invert();
    const startWorld = bone.getWorldPosition(new Vector3());
    const startLocal = startWorld.clone().applyMatrix4(invModel);
    const hips = this.byName.get('Hips');
    const hipsIdx = hips ? this.bones.indexOf(hips) : -1;
    const restHipsP = hipsIdx >= 0 ? new Vector3().fromArray(this.rest[hipsIdx].p) : new Vector3(0, 1.043, 0.016);
    const startDrop = hips ? Math.max(0, restHipsP.y - hips.position.y) : 0;
    const startKneel = MathUtils.clamp(startDrop / 0.48, 0, 1);
    const hipsActualStartLocal = hips ? hips.position.clone() : restHipsP.clone();
    const hipsStartLocal = hips
      ? new Vector3(hips.position.x, hips.position.y, hips.position.z - startKneel * 0.14)
      : restHipsP.clone();
    const leftFoot = this.byName.get('LeftFoot')?.getWorldPosition(new Vector3());
    const rightFoot = this.byName.get('RightFoot')?.getWorldPosition(new Vector3());
    return {
      boneName: name,
      bone,
      startWorld,
      startLocal,
      hipsActualStartLocal,
      hipsStartLocal,
      startState: this.guard.capture(),
      leftFootWorld: leftFoot,
      rightFootWorld: rightFoot,
      preferBehind: startLocal.z <= 0.01 ? -1 : 1,
    };
  }

  solve(boneName, targetWorld, session = null, options = {}) {
    const name = cleanName(boneName);
    const bone = this.byName.get(name);
    if (!bone) return { moved: [] };

    const startState = session?.startState || this.guard.capture();
    const avoidBody = options.avoidBody ?? true;
    const preferBehind = options.preferBehind ?? session?.preferBehind ?? -1;

    // Gentle relaxation of secondary support bones toward the drag-start state
    // prevents cumulative spine/collarbone drift during long circular drags.
    this.relaxSupportBones(name, startState, 0.22);

    let moved = [];
    if (name === 'LeftHand' || name === 'RightHand') {
      const side = name.startsWith('Left') ? 'Left' : 'Right';
      moved = this.solveArmChain(side, targetWorld, startState, { avoidBody, preferBehind });
    } else if (name === 'LeftForeArm' || name === 'RightForeArm') {
      const side = name.startsWith('Left') ? 'Left' : 'Right';
      moved = this.solveElbowChain(side, targetWorld, startState, { avoidBody, preferBehind });
    } else if (name === 'LeftArm' || name === 'RightArm' || name === 'LeftShoulder' || name === 'RightShoulder') {
      const side = name.startsWith('Left') ? 'Left' : 'Right';
      moved = this.solveShoulderChain(side, name, targetWorld, startState, { avoidBody });
    } else if (name === 'LeftFoot' || name === 'RightFoot' || name === 'LeftToeBase' || name === 'RightToeBase') {
      const side = name.startsWith('Left') ? 'Left' : 'Right';
      moved = this.solveLegChain(side, name, targetWorld, startState, { avoidBody });
    } else if (name === 'LeftLeg' || name === 'RightLeg') {
      const side = name.startsWith('Left') ? 'Left' : 'Right';
      moved = this.solveKneeChain(side, targetWorld, startState, { avoidBody });
    } else if (name === 'LeftUpLeg' || name === 'RightUpLeg') {
      const side = name.startsWith('Left') ? 'Left' : 'Right';
      moved = this.solveHipJointChain(side, targetWorld, startState, { avoidBody });
    } else if (name === 'Hips') {
      moved = this.solvePelvisDrag(targetWorld, session, startState, { avoidBody });
    } else {
      moved = this.solveTorsoHeadChain(name, targetWorld, session, startState, { avoidBody });
    }

    this.model.updateMatrixWorld(true);
    return { moved };
  }

  relaxSupportBones(draggedName, startState, alpha) {
    const support = ['Spine', 'Spine1', 'Spine2', 'Neck', 'LeftShoulder', 'RightShoulder', 'Hips'];
    for (const sName of support) {
      if (sName === draggedName) continue;
      const b = this.byName.get(sName);
      if (!b) continue;
      const idx = this.bones.indexOf(b);
      if (idx < 0) continue;
      const startQ = new Quaternion().fromArray(startState[idx].q);
      b.quaternion.slerp(startQ, alpha);
    }
    this.model.updateMatrixWorld(true);
  }

  solveArmChain(side, rawTargetWorld, startState, { avoidBody, preferBehind }) {
    const sign = side === 'Left' ? 1 : -1;
    const shoulder = this.byName.get(`${side}Shoulder`);
    const arm = this.byName.get(`${side}Arm`);
    const foreArm = this.byName.get(`${side}ForeArm`);
    const hand = this.byName.get(`${side}Hand`);
    const spine = this.byName.get('Spine');
    const spine1 = this.byName.get('Spine1');
    const spine2 = this.byName.get('Spine2');

    const prevArmQ = arm.quaternion.clone();
    const prevForeArmQ = foreArm.quaternion.clone();
    const prevMidWorld = foreArm.getWorldPosition(new Vector3());

    // Determine effective target outside body capsules if collision avoidance is active
    const baseTarget = avoidBody
      ? this.projectOutsideBody(rawTargetWorld, preferBehind, 0.088)
      : rawTargetWorld.clone();

    // Check how far the pull is relative to arm length to scale torso/collarbone follow
    const S0 = arm.getWorldPosition(new Vector3());
    const M0 = foreArm.getWorldPosition(new Vector3());
    const E0 = hand.getWorldPosition(new Vector3());
    const armReach = S0.distanceTo(M0) + M0.distanceTo(E0);
    const pullRatio = MathUtils.clamp(S0.distanceTo(baseTarget) / Math.max(0.1, armReach), 0, 1.6);
    const torsoBoost = 1 + Math.max(0, pullRatio - 0.72) * 1.4;

    // 1. Torso & collarbone pre-follow
    const chain = [
      [spine, 0.055 * torsoBoost, 14],
      [spine1, 0.085 * torsoBoost, 18],
      [spine2, 0.125 * torsoBoost, 22],
      [shoulder, 0.42, 35],
    ];
    for (let pass = 0; pass < 2; pass++) {
      for (const [bone, weight, maxDegFromStart] of chain) {
        if (!bone) continue;
        this.stepBoneToward(bone, hand, baseTarget, weight);
        this.clampFromStart(bone, startState, maxDegFromStart);
        this.guard.constrain(bone);
      }
    }

    // 2. Two-bone analytical + pole + collision-avoiding swivel search
    // Try increasing body clearance slightly if a tight behind-back or cross-chest wrap grazes the torso
    const clearances = avoidBody ? [0, 0.03, 0.06, 0.095] : [0];
    let bestSolution = null;

    for (const extraClearance of clearances) {
      const target = extraClearance > 0
        ? this.projectOutsideBody(rawTargetWorld, preferBehind, 0.088 + extraClearance)
        : baseTarget;

      const candidate = this.solveTwoBoneLimb({
        rootBone: arm,
        midBone: foreArm,
        endBone: hand,
        targetWorld: target,
        side,
        isLeg: false,
        prevMidWorld,
        prevRootQ: prevArmQ,
        avoidBody,
      });

      if (!bestSolution || candidate.score < bestSolution.score) {
        bestSolution = candidate;
      }
      if (candidate.collisionCount === 0) break;
    }

    if (bestSolution) {
      arm.quaternion.copy(bestSolution.rootQ);
      foreArm.quaternion.copy(bestSolution.midQ);
    } else {
      arm.quaternion.copy(prevArmQ);
      foreArm.quaternion.copy(prevForeArmQ);
    }

    // Subtly relax wrist toward rest so it follows cleanly within limits
    const handIdx = this.bones.indexOf(hand);
    if (handIdx >= 0) {
      const restHandQ = new Quaternion().fromArray(this.rest[handIdx].q);
      hand.quaternion.slerp(restHandQ, 0.15);
      this.guard.constrain(hand);
    }

    this.model.updateMatrixWorld(true);
    return ['Spine', 'Spine1', 'Spine2', `${side}Shoulder`, `${side}Arm`, `${side}ForeArm`, `${side}Hand`];
  }

  solveElbowChain(side, rawTargetWorld, startState, { avoidBody, preferBehind }) {
    const shoulder = this.byName.get(`${side}Shoulder`);
    const arm = this.byName.get(`${side}Arm`);
    const foreArm = this.byName.get(`${side}ForeArm`);
    const spine = this.byName.get('Spine');
    const spine1 = this.byName.get('Spine1');
    const spine2 = this.byName.get('Spine2');

    const target = avoidBody
      ? this.projectOutsideBody(rawTargetWorld, preferBehind, 0.075)
      : rawTargetWorld.clone();

    for (let pass = 0; pass < 2; pass++) {
      for (const [bone, weight, maxDeg] of [
        [spine, 0.06, 14],
        [spine1, 0.09, 18],
        [spine2, 0.14, 22],
        [shoulder, 0.48, 35],
      ]) {
        if (!bone) continue;
        this.stepBoneToward(bone, foreArm, target, weight);
        this.clampFromStart(bone, startState, maxDeg);
        this.guard.constrain(bone);
      }
    }

    // Aim upper arm so elbow reaches target, then search axial twist for collision-free forearm
    this.model.updateMatrixWorld(true);
    const S = arm.getWorldPosition(new Vector3());
    const E = foreArm.getWorldPosition(new Vector3());
    const curDir = E.clone().sub(S).normalize();
    const tgtDir = target.clone().sub(S).normalize();
    if (curDir.lengthSq() > 1e-6 && tgtDir.lengthSq() > 1e-6) {
      const aimWorld = new Quaternion().setFromUnitVectors(curDir, tgtDir);
      const parentQ = arm.parent.getWorldQuaternion(new Quaternion());
      arm.quaternion.premultiply(parentQ.clone().invert().multiply(aimWorld).multiply(parentQ));
      const baseQ = arm.quaternion.clone();
      let bestQ = baseQ.clone(), bestScore = Infinity;
      for (const deg of [0, -10, 10, -24, 24, -42, 42, -65, 65]) {
        const twist = new Quaternion().setFromAxisAngle(tgtDir, rad(deg));
        arm.quaternion.copy(baseQ).premultiply(parentQ.clone().invert().multiply(twist).multiply(parentQ));
        this.guard.constrain(arm);
        this.model.updateMatrixWorld(true);
        const cols = avoidBody ? this.guard.collisions() : [];
        const pen = cols.reduce((s, c) => s + c.depth, 0);
        const err = foreArm.getWorldPosition(new Vector3()).distanceTo(target);
        const score = (cols.length ? 100 + pen * 500 : 0) + err * 25 + Math.abs(deg) * 0.01;
        if (score < bestScore) { bestScore = score; bestQ.copy(arm.quaternion); }
      }
      arm.quaternion.copy(bestQ);
    }
    this.guard.constrain(foreArm);
    this.model.updateMatrixWorld(true);
    return ['Spine', 'Spine1', 'Spine2', `${side}Shoulder`, `${side}Arm`, `${side}ForeArm`];
  }

  solveShoulderChain(side, draggedName, rawTargetWorld, startState, { avoidBody }) {
    const shoulder = this.byName.get(`${side}Shoulder`);
    const arm = this.byName.get(`${side}Arm`);
    const foreArm = this.byName.get(`${side}ForeArm`);
    const spine = this.byName.get('Spine');
    const spine1 = this.byName.get('Spine1');
    const spine2 = this.byName.get('Spine2');

    const effector = draggedName === `${side}Shoulder` ? arm : arm;
    for (let pass = 0; pass < 3; pass++) {
      for (const [bone, weight, maxDeg] of [
        [spine, 0.12, 18],
        [spine1, 0.18, 22],
        [spine2, 0.25, 26],
        [shoulder, 0.65, 35],
      ]) {
        if (!bone) continue;
        this.stepBoneToward(bone, effector, rawTargetWorld, weight);
        this.clampFromStart(bone, startState, maxDeg);
        this.guard.constrain(bone);
      }
    }
    // Also swing upper arm toward the pull if pulling the shoulder marker beyond collarbone reach
    this.model.updateMatrixWorld(true);
    const S = arm.getWorldPosition(new Vector3());
    if (S.distanceTo(rawTargetWorld) > 0.04) {
      this.stepBoneToward(arm, foreArm, rawTargetWorld, 0.75);
      this.guard.constrain(arm);
    }
    if (avoidBody && this.guard.collisions().length) {
      this.guard.resolve({ names: [`${side}Arm`, `${side}Shoulder`, 'Spine2', 'Spine1', 'Spine'], previous: startState });
    }
    return ['Spine', 'Spine1', 'Spine2', `${side}Shoulder`, `${side}Arm`];
  }

  solveLegChain(side, draggedName, rawTargetWorld, startState, { avoidBody }) {
    const hips = this.byName.get('Hips');
    const spine = this.byName.get('Spine');
    const upLeg = this.byName.get(`${side}UpLeg`);
    const leg = this.byName.get(`${side}Leg`);
    const foot = this.byName.get(`${side}Foot`);
    const toe = this.byName.get(`${side}ToeBase`);

    const prevUpLegQ = upLeg.quaternion.clone();
    const prevLegQ = leg.quaternion.clone();
    const prevMidWorld = leg.getWorldPosition(new Vector3());

    // Subtle pelvis follow + spine counterbalance
    const effector = draggedName.endsWith('ToeBase') ? toe : foot;
    if (hips) {
      const hipsBefore = hips.quaternion.clone();
      this.stepBoneToward(hips, effector, rawTargetWorld, 0.06);
      this.clampFromStart(hips, startState, 10);
      if (spine) {
        const deltaHips = hipsBefore.clone().invert().multiply(hips.quaternion);
        spine.quaternion.premultiply(deltaHips.invert());
        this.guard.constrain(spine);
      }
    }

    // If dragging ToeBase, compute corresponding ankle target first
    let ankleTarget = rawTargetWorld.clone();
    if (draggedName.endsWith('ToeBase') && toe) {
      this.model.updateMatrixWorld(true);
      const footPos = foot.getWorldPosition(new Vector3());
      const toePos = toe.getWorldPosition(new Vector3());
      const footToToe = toePos.sub(footPos);
      ankleTarget = rawTargetWorld.clone().sub(footToToe.multiplyScalar(0.65));
    }

    const sol = this.solveTwoBoneLimb({
      rootBone: upLeg,
      midBone: leg,
      endBone: foot,
      targetWorld: ankleTarget,
      side,
      isLeg: true,
      prevMidWorld,
      prevRootQ: prevUpLegQ,
      avoidBody,
    });

    if (sol) {
      upLeg.quaternion.copy(sol.rootQ);
      leg.quaternion.copy(sol.midQ);
    } else {
      upLeg.quaternion.copy(prevUpLegQ);
      leg.quaternion.copy(prevLegQ);
    }

    if (draggedName.endsWith('ToeBase') && toe) {
      this.stepBoneToward(foot, toe, rawTargetWorld, 0.85);
      this.guard.constrain(foot);
    } else {
      const footIdx = this.bones.indexOf(foot);
      if (footIdx >= 0) {
        foot.quaternion.slerp(new Quaternion().fromArray(this.rest[footIdx].q), 0.2);
        this.guard.constrain(foot);
      }
    }

    this.model.updateMatrixWorld(true);
    return ['Hips', 'Spine', `${side}UpLeg`, `${side}Leg`, `${side}Foot`, `${side}ToeBase`];
  }

  solveKneeChain(side, rawTargetWorld, startState, { avoidBody }) {
    const hips = this.byName.get('Hips');
    const upLeg = this.byName.get(`${side}UpLeg`);
    const leg = this.byName.get(`${side}Leg`);

    if (hips) {
      this.stepBoneToward(hips, leg, rawTargetWorld, 0.05);
      this.clampFromStart(hips, startState, 8);
    }

    this.model.updateMatrixWorld(true);
    const H = upLeg.getWorldPosition(new Vector3());
    const K = leg.getWorldPosition(new Vector3());
    const curDir = K.clone().sub(H).normalize();
    const tgtDir = rawTargetWorld.clone().sub(H).normalize();

    // Natural ragdoll knee flexion when lifting the knee upward
    const modelInv = this.model.matrixWorld.clone().invert();
    const localTarget = rawTargetWorld.clone().applyMatrix4(modelInv);
    const lift = MathUtils.clamp((localTarget.y - 0.53) / 0.45, 0, 1);
    const legIdx = this.bones.indexOf(leg);
    const startLegQ = new Quaternion().fromArray(startState[legIdx].q);
    if (lift > 0.02) {
      const naturalFlex = new Quaternion().setFromAxisAngle(X_AXIS, -rad(15 + lift * 75));
      leg.quaternion.copy(startLegQ).slerp(naturalFlex, MathUtils.clamp(lift * 1.2, 0, 1));
      this.guard.constrain(leg);
    }

    if (curDir.lengthSq() > 1e-6 && tgtDir.lengthSq() > 1e-6) {
      const aimWorld = new Quaternion().setFromUnitVectors(curDir, tgtDir);
      const parentQ = upLeg.parent.getWorldQuaternion(new Quaternion());
      upLeg.quaternion.premultiply(parentQ.clone().invert().multiply(aimWorld).multiply(parentQ));
      const baseQ = upLeg.quaternion.clone();
      let bestQ = baseQ.clone(), bestScore = Infinity;
      for (const deg of [0, -8, 8, -18, 18, -32, 32, -50, 50]) {
        const twist = new Quaternion().setFromAxisAngle(tgtDir, rad(deg));
        upLeg.quaternion.copy(baseQ).premultiply(parentQ.clone().invert().multiply(twist).multiply(parentQ));
        this.guard.constrain(upLeg);
        this.model.updateMatrixWorld(true);
        const cols = avoidBody ? this.guard.collisions() : [];
        const pen = cols.reduce((s, c) => s + c.depth, 0);
        const err = leg.getWorldPosition(new Vector3()).distanceTo(rawTargetWorld);
        const score = (cols.length ? 100 + pen * 500 : 0) + err * 25 + Math.abs(deg) * 0.01;
        if (score < bestScore) { bestScore = score; bestQ.copy(upLeg.quaternion); }
      }
      upLeg.quaternion.copy(bestQ);
    }
    this.model.updateMatrixWorld(true);
    return ['Hips', `${side}UpLeg`, `${side}Leg`];
  }

  solveHipJointChain(side, rawTargetWorld, startState, { avoidBody }) {
    const hips = this.byName.get('Hips');
    const upLeg = this.byName.get(`${side}UpLeg`);
    const leg = this.byName.get(`${side}Leg`);
    if (hips) {
      this.stepBoneToward(hips, upLeg, rawTargetWorld, 0.25);
      this.clampFromStart(hips, startState, 16);
    }
    this.stepBoneToward(upLeg, leg, rawTargetWorld, 0.75);
    this.guard.constrain(upLeg);
    if (avoidBody && this.guard.collisions().length) {
      this.guard.resolve({ names: [`${side}UpLeg`, 'Hips'], previous: startState });
    }
    return ['Hips', `${side}UpLeg`];
  }

  solveTorsoHeadChain(draggedName, rawTargetWorld, session, startState, { avoidBody }) {
    const order = ['Spine', 'Spine1', 'Spine2', 'Neck', 'Head'];
    const stopIdx = order.indexOf(draggedName);
    if (stopIdx < 0) return [];
    const activeBones = order.slice(0, stopIdx + 1).map(n => this.byName.get(n)).filter(Boolean);
    const draggedBone = this.byName.get(draggedName);
    const tipBone = this.byName.get(CHILD_TIP[draggedName]) || draggedBone;

    this.model.updateMatrixWorld(true);
    const invModel = this.model.matrixWorld.clone().invert();
    const targetLocal = rawTargetWorld.clone().applyMatrix4(invModel);
    const startLocal = session?.startLocal || draggedBone.getWorldPosition(new Vector3()).applyMatrix4(invModel);
    const dragDelta = targetLocal.clone().sub(startLocal);

    const hips = this.byName.get('Hips');
    const hipsIdx = hips ? this.bones.indexOf(hips) : -1;
    const restHipsP = hipsIdx >= 0 ? new Vector3().fromArray(this.rest[hipsIdx].p) : new Vector3(0, 1.043, 0.016);
    const hipsStart = session?.hipsStartLocal || (hips ? hips.position.clone() : restHipsP.clone());

    // Pushing any torso bone downward (or pulling back up from a crouch/kneel) drives
    // pelvis compression/extension and bends both knees into a squat or kneel when upright.
    const upright = this.isUpright();
    const isNeckOrHead = draggedName === 'Neck' || draggedName === 'Head';
    const dyAllowance = isNeckOrHead ? 0.035 : 0;
    let dyHips = 0;
    if (upright) {
      if (dragDelta.y < -dyAllowance) dyHips = dragDelta.y + dyAllowance;
      else if (dragDelta.y > dyAllowance && hipsStart.y < restHipsP.y - 0.005) dyHips = dragDelta.y - dyAllowance;
    }

    const horizShare = { Spine: 0.55, Spine1: 0.40, Spine2: 0.28, Neck: 0.16, Head: 0.12 }[draggedName] ?? 0.3;
    const engagedLegs = upright && (Math.abs(dyHips) > 0.004 || hipsStart.y < restHipsP.y - 0.008);
    let crouchMoved = [];
    if (engagedLegs && hips) {
      const desiredHipsLocal = new Vector3(
        hipsStart.x + dragDelta.x * horizShare,
        hipsStart.y + dyHips,
        hipsStart.z + dragDelta.z * horizShare,
      );
      crouchMoved = this.applyLowerBodyCrouch(desiredHipsLocal, startState, { avoidBody });
    }

    // Rotate the spine/neck chain toward the remaining upper-body target
    this.model.updateMatrixWorld(true);
    const hipsActualStart = session?.hipsActualStartLocal || hipsStart;
    const hipsShift = hips ? hips.position.clone().sub(hipsActualStart) : new Vector3();
    const adjustedTargetLocal = new Vector3(
      startLocal.x + hipsShift.x + dragDelta.x * (1 - (engagedLegs ? horizShare : 0)),
      startLocal.y + hipsShift.y + (dragDelta.y - dyHips),
      startLocal.z + hipsShift.z + dragDelta.z * (1 - (engagedLegs ? horizShare : 0)),
    );
    const upperTargetWorld = adjustedTargetLocal.applyMatrix4(this.model.matrixWorld);
    const draggedOrigin = draggedBone.getWorldPosition(new Vector3());
    const tipOrigin = tipBone.getWorldPosition(new Vector3());
    const tipOffset = tipOrigin.clone().sub(draggedOrigin);
    const tipTarget = upperTargetWorld.clone().add(tipOffset);

    for (let pass = 0; pass < 4; pass++) {
      for (let i = 0; i < activeBones.length; i++) {
        const b = activeBones[i];
        const weight = 0.25 + (i / Math.max(1, activeBones.length)) * 0.45;
        const eff = b === draggedBone ? tipBone : draggedBone;
        const tgt = b === draggedBone ? tipTarget : upperTargetWorld;
        this.stepBoneToward(b, eff, tgt, weight);
        this.guard.constrain(b);
      }
    }

    const moved = [...new Set([...crouchMoved, ...order.slice(0, stopIdx + 1)])];
    if (avoidBody && this.guard.collisions().length) {
      this.guard.resolve({ names: ['LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm', ...order.slice(0, stopIdx + 1)], previous: startState });
    }
    this.model.updateMatrixWorld(true);
    return moved;
  }

  solvePelvisDrag(rawTargetWorld, session, startState, { avoidBody }) {
    const hips = this.byName.get('Hips');
    if (!hips) return [];
    const parentInv = hips.parent.matrixWorld.clone().invert();
    const targetLocal = rawTargetWorld.clone().applyMatrix4(parentInv);
    const startLocal = session?.startLocal || targetLocal;
    const hipsStart = session?.hipsStartLocal || hips.position.clone();
    const desiredLocal = hipsStart.clone().add(targetLocal.sub(startLocal));
    if (!this.isUpright()) {
      hips.position.set(
        MathUtils.clamp(desiredLocal.x, -0.45, 0.45),
        MathUtils.clamp(desiredLocal.y, 0.085, 0.45),
        MathUtils.clamp(desiredLocal.z, -0.45, 0.45),
      );
      this.model.updateMatrixWorld(true);
      return ['Hips'];
    }
    return this.applyLowerBodyCrouch(desiredLocal, startState, { avoidBody });
  }

  applyLowerBodyCrouch(desiredHipsLocal, startState, { avoidBody }) {
    const hips = this.byName.get('Hips');
    if (!hips) return [];
    const hipsIdx = this.bones.indexOf(hips);
    const restHipsP = new Vector3().fromArray(this.rest[hipsIdx].p);

    const newY = MathUtils.clamp(desiredHipsLocal.y, restHipsP.y - 0.50, restHipsP.y + 0.03);
    const drop = Math.max(0, restHipsP.y - newY);
    const kneelFactor = MathUtils.clamp(drop / 0.48, 0, 1);

    // As the torso is pushed down toward a kneel, shift pelvis subtly forward so
    // the knees descend to rest on the floor (y ~ 0.06m) while shins lay flat.
    const newX = MathUtils.clamp(desiredHipsLocal.x, restHipsP.x - 0.28, restHipsP.x + 0.28);
    const newZ = MathUtils.clamp(desiredHipsLocal.z + kneelFactor * 0.14, restHipsP.z - 0.26, restHipsP.z + 0.34);
    hips.position.set(newX, newY, newZ);
    this.model.updateMatrixWorld(true);

    for (const side of ['Left', 'Right']) {
      const baseFoot = this.restFootLocal[side];
      const footLocalTarget = new Vector3(
        baseFoot.x,
        baseFoot.y + kneelFactor * 0.024,
        baseFoot.z - kneelFactor * 0.16,
      );
      const footWorldTarget = footLocalTarget.applyMatrix4(this.model.matrixWorld);
      this.solveLegChain(side, `${side}Foot`, footWorldTarget, startState, { avoidBody });
      this.alignFootWithFloor(side);
    }

    return [
      'Hips',
      'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase',
      'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase',
    ];
  }

  alignFootWithFloor(side) {
    const foot = this.byName.get(`${side}Foot`);
    const toe = this.byName.get(`${side}ToeBase`);
    const toeEnd = this.byName.get(`${side}Toe_End`);
    if (!foot || !toe) return;
    const invModel = this.model.matrixWorld.clone().invert();
    const footRest = new Quaternion().fromArray(this.rest[this.bones.indexOf(foot)].q);
    const toeRest = new Quaternion().fromArray(this.rest[this.bones.indexOf(toe)].q);

    let bestFootDeg = 0, bestFootErr = Infinity;
    for (let deg = -68; deg <= 65; deg += 3) {
      foot.quaternion.copy(footRest).multiply(new Quaternion().setFromAxisAngle(X_AXIS, rad(deg)));
      this.guard.constrain(foot);
      this.model.updateMatrixWorld(true);
      const tLocal = toe.getWorldPosition(new Vector3()).applyMatrix4(invModel);
      const fLocal = foot.getWorldPosition(new Vector3()).applyMatrix4(invModel);
      const err = Math.abs(tLocal.y - 0.006) * 20 + (tLocal.y < -0.002 ? 12 : 0) + (tLocal.z < fLocal.z ? 0.5 : 0);
      if (err < bestFootErr) { bestFootErr = err; bestFootDeg = deg; }
    }
    foot.quaternion.copy(footRest).multiply(new Quaternion().setFromAxisAngle(X_AXIS, rad(bestFootDeg)));
    this.guard.constrain(foot);

    if (toeEnd) {
      let bestToeDeg = 0, bestToeErr = Infinity;
      for (let deg = -68; deg <= 65; deg += 3) {
        toe.quaternion.copy(toeRest).multiply(new Quaternion().setFromAxisAngle(X_AXIS, rad(deg)));
        this.guard.constrain(toe);
        this.model.updateMatrixWorld(true);
        const teLocal = toeEnd.getWorldPosition(new Vector3()).applyMatrix4(invModel);
        const err = Math.abs(teLocal.y - 0.004) + (teLocal.y < -0.002 ? 8 : 0);
        if (err < bestToeErr) { bestToeErr = err; bestToeDeg = deg; }
      }
      toe.quaternion.copy(toeRest).multiply(new Quaternion().setFromAxisAngle(X_AXIS, rad(bestToeDeg)));
      this.guard.constrain(toe);
    }
    this.model.updateMatrixWorld(true);
  }

  solveTwoBoneLimb({ rootBone, midBone, endBone, targetWorld, side, isLeg, prevMidWorld, prevRootQ, avoidBody }) {
    const sign = side === 'Left' ? 1 : -1;
    this.model.updateMatrixWorld(true);

    const S = rootBone.getWorldPosition(new Vector3());
    const M = midBone.getWorldPosition(new Vector3());
    const E = endBone.getWorldPosition(new Vector3());
    const L1 = S.distanceTo(M);
    const L2 = M.distanceTo(E);
    const rawDist = S.distanceTo(targetWorld);
    const d = MathUtils.clamp(rawDist, Math.abs(L1 - L2) + 0.008, L1 + L2 - 0.001);

    // 1. Exact Law of Cosines for hinge flexion around local -X
    const cosAlpha = MathUtils.clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1);
    const bendAngle = Math.PI - Math.acos(cosAlpha);
    midBone.quaternion.setFromAxisAngle(X_AXIS, -bendAngle);
    this.guard.constrain(midBone);

    // 2. Aim rootBone so endBone reaches along (targetWorld - S)
    this.model.updateMatrixWorld(true);
    const E2 = endBone.getWorldPosition(new Vector3());
    const curDir = E2.clone().sub(S).normalize();
    const tgtDir = targetWorld.clone().sub(S).normalize();
    if (curDir.lengthSq() < 1e-8 || tgtDir.lengthSq() < 1e-8) return null;

    const parentQ = rootBone.parent.getWorldQuaternion(new Quaternion());
    const parentInv = parentQ.clone().invert();
    const aimWorld = new Quaternion().setFromUnitVectors(curDir, tgtDir);
    rootBone.quaternion.premultiply(parentInv.clone().multiply(aimWorld).multiply(parentQ));
    this.model.updateMatrixWorld(true);

    // 3. Align elbow/knee pole direction around tgtDir
    const upright = this.isUpright();
    const refQ = upright
      ? this.model.getWorldQuaternion(new Quaternion())
      : (this.byName.get('Hips') || this.model).getWorldQuaternion(new Quaternion());
    const localVec = targetWorld.clone().sub(S).applyQuaternion(refQ.clone().invert());
    let poleDir;
    if (isLeg) {
      poleDir = new Vector3(sign * 0.16, 0.12, 1.0).normalize();
    } else {
      const behind = localVec.z < -0.04;
      const high = localVec.y > 0.12;
      poleDir = new Vector3(
        sign * (behind ? 0.88 : 0.62),
        high ? -0.15 : behind ? -0.22 : -0.55,
        behind ? -0.45 : high ? 0.25 : -0.55,
      ).normalize();
    }
    poleDir.applyQuaternion(refQ);

    // Blend anatomical pole with previous frame's mid-joint direction for temporal smoothness
    if (prevMidWorld) {
      const prevDir = prevMidWorld.clone().sub(S).normalize();
      if (prevDir.lengthSq() > 1e-6) poleDir.lerp(prevDir, 0.28).normalize();
    }

    const M2 = midBone.getWorldPosition(new Vector3());
    const midVec = M2.clone().sub(S);
    const midProj = midVec.clone().addScaledVector(tgtDir, -midVec.dot(tgtDir));
    const poleProj = poleDir.clone().addScaledVector(tgtDir, -poleDir.dot(tgtDir));
    if (midProj.lengthSq() > 1e-6 && poleProj.lengthSq() > 1e-6) {
      const alignPole = new Quaternion().setFromUnitVectors(midProj.normalize(), poleProj.normalize());
      rootBone.quaternion.premultiply(parentInv.clone().multiply(alignPole).multiply(parentQ));
    }

    // 4. Search swivel angles around tgtDir for a collision-free, limit-compliant pose
    const baseRootQ = rootBone.quaternion.clone();
    const midQ = midBone.quaternion.clone();
    const invModel = this.model.matrixWorld.clone().invert();
    let best = null;

    const swivelAngles = [0, -6, 6, -14, 14, -24, 24, -36, 36, -50, 50, -68, 68, -90, 90, -115, 115];
    for (const deg of swivelAngles) {
      const twistWorld = new Quaternion().setFromAxisAngle(tgtDir, rad(deg));
      rootBone.quaternion.copy(baseRootQ).premultiply(parentInv.clone().multiply(twistWorld).multiply(parentQ));
      this.guard.constrain(rootBone);
      this.model.updateMatrixWorld(true);

      const cols = avoidBody ? this.guard.collisions() : [];
      const pen = cols.reduce((sum, c) => sum + c.depth, 0);
      const achieved = endBone.getWorldPosition(new Vector3());
      const midLocalY = midBone.getWorldPosition(new Vector3()).applyMatrix4(invModel).y;
      const floorPen = midLocalY < 0.04 ? (0.04 - midLocalY) * 120 : 0;
      const posErr = achieved.distanceTo(targetWorld);
      const continuity = prevRootQ ? prevRootQ.angleTo(rootBone.quaternion) * 0.15 : 0;
      const score = (cols.length ? 200 + pen * 1000 : 0) + posErr * 30 + floorPen + Math.abs(deg) * 0.004 + continuity;

      if (!best || score < best.score) {
        best = {
          rootQ: rootBone.quaternion.clone(),
          midQ: midQ.clone(),
          score,
          collisionCount: cols.length,
          posErr,
        };
      }
    }

    return best;
  }

  stepBoneToward(bone, effector, targetWorld, weight) {
    this.model.updateMatrixWorld(true);
    const pivot = bone.getWorldPosition(new Vector3());
    const effPos = effector.getWorldPosition(new Vector3());
    const v1 = effPos.clone().sub(pivot);
    const v2 = targetWorld.clone().sub(pivot);
    if (v1.lengthSq() < 1e-6 || v2.lengthSq() < 1e-6) return;
    v1.normalize();
    v2.normalize();
    const fullDelta = new Quaternion().setFromUnitVectors(v1, v2);
    const damped = new Quaternion().slerp(fullDelta, MathUtils.clamp(weight, 0, 1));
    const parentQ = bone.parent.getWorldQuaternion(new Quaternion());
    bone.quaternion.premultiply(parentQ.clone().invert().multiply(damped).multiply(parentQ));
    this.model.updateMatrixWorld(true);
  }

  clampFromStart(bone, startState, maxDegrees) {
    const idx = this.bones.indexOf(bone);
    if (idx < 0) return;
    const startQ = new Quaternion().fromArray(startState[idx].q).normalize();
    const curQ = bone.quaternion.clone().normalize();
    const angle = startQ.angleTo(curQ);
    const maxRad = rad(maxDegrees);
    if (angle > maxRad && angle > 1e-6) {
      bone.quaternion.copy(startQ).slerp(curQ, maxRad / angle);
    }
  }

  projectOutsideBody(worldTarget, preferSignZ = -1, clearance = 0.088) {
    this.model.updateMatrixWorld(true);
    const inv = this.model.matrixWorld.clone().invert();
    const p = worldTarget.clone().applyMatrix4(inv);
    for (const name of ['pelvis', 'chest', 'head']) {
      const c = this.guard.capsules.find(item => item.name === name);
      if (!c) continue;
      const a = c.from.getWorldPosition(new Vector3()).applyMatrix4(inv);
      const b = c.to.getWorldPosition(new Vector3()).applyMatrix4(inv);
      const ab = b.clone().sub(a);
      const lenSq = ab.lengthSq();
      const t = lenSq > 1e-8 ? MathUtils.clamp(p.clone().sub(a).dot(ab) / lenSq, 0, 1) : 0;
      const q = a.clone().addScaledVector(ab, t);
      const R = c.radius + clearance;
      const dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < R * R) {
        const signZ = preferSignZ || (dz <= 0.01 ? -1 : 1);
        const rem2 = R * R - dx * dx - dy * dy;
        if (rem2 > 0) {
          p.z = q.z + signZ * Math.sqrt(rem2);
        } else {
          const dir = p.clone().sub(q);
          if (dir.lengthSq() < 1e-8) dir.set(0, 0, signZ);
          p.copy(q).addScaledVector(dir.normalize(), R);
        }
      }
    }
    return p.applyMatrix4(this.model.matrixWorld);
  }
}
