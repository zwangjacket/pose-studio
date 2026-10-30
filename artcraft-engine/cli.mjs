#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openSession, listBones, rotateBone, capturePose, applyPose, exportGlb, closeSession, UPSTREAM_COMMIT } from './engine.mjs';

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      input: { type: 'string' }, output: { type: 'string' },
      rotate: { type: 'string', multiple: true },
      'pose-in': { type: 'string' }, 'pose-out': { type: 'string' },
      space: { type: 'string', default: 'local' }, snap: { type: 'string' },
      json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(`ArtCraft upstream pose CLI\n\n` +
      `bones --input model.glb [--json]\n` +
      `pose --input model.glb --rotate Head:y:25 --output edited.glb\n` +
      `     [--rotate RightForeArm:z:60] [--space local|world] [--snap 15]\n` +
      `     [--pose-in saved.pose.json] [--pose-out new.pose.json]\n\n` +
      `Uses ArtCraft FKHelper, TransformControls, and BoneJSONHelper at ${UPSTREAM_COMMIT}.\n`);
    return;
  }
  if (!['bones', 'pose'].includes(command) || positionals.length !== 1) throw new Error('Expected bones or pose. Use --help.');
  if (!values.input) throw new Error('--input is required.');
  if (command === 'pose' && !values.output && !values['pose-out']) throw new Error('Provide --output and/or --pose-out.');
  if (command === 'pose' && !values.rotate?.length && !values['pose-in']) throw new Error('Provide --rotate or --pose-in.');
  if (values.output && !values.output.toLowerCase().endsWith('.glb')) throw new Error('--output must end with .glb.');
  if (!['local', 'world'].includes(values.space)) throw new Error('--space must be local or world.');
  const outputs = [values.output, values['pose-out']].filter(Boolean).map(p => resolve(p));
  if (new Set(outputs).size !== outputs.length) throw new Error('GLB and pose outputs must be different files.');
  for (const output of outputs) {
    try { await access(output); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error(`Output already exists: ${output}. Choose a new filename.`);
  }
  const session = await openSession(values.input);
  try {
    if (command === 'bones') {
      const bones = listBones(session);
      if (values.json) process.stdout.write(JSON.stringify({ engine: UPSTREAM_COMMIT, bones }, null, 2) + '\n');
      else process.stdout.write(bones.map(b => `${b.alias.padEnd(18)} ${b.name}`).join('\n') + `\n\n${bones.length} editable bones, filtered by ArtCraft FKHelper.\n`);
      return;
    }
    if (values['pose-in']) applyPose(session, JSON.parse(await readFile(values['pose-in'], 'utf8')));
    for (const specification of values.rotate ?? []) {
      const parts = specification.split(':');
      if (parts.length < 3) throw new Error(`Invalid rotation '${specification}'; expected Bone:axis:degrees.`);
      const degrees = parts.pop(), axis = parts.pop(), bone = parts.join(':');
      if (!bone || !axis || degrees.trim() === '') throw new Error(`Invalid rotation '${specification}'; expected Bone:axis:degrees.`);
      rotateBone(session, bone, axis, Number(degrees), values.space, values.snap === undefined ? null : Number(values.snap));
    }
    const nativePose = capturePose(session);
    const changed = values.output ? await exportGlb(session, values.output) : null;
    if (values['pose-out']) await writeFile(values['pose-out'], JSON.stringify(nativePose, null, 2) + '\n', { flag: 'wx' });
    process.stdout.write(JSON.stringify({
      engine: 'ArtCraft upstream FKHelper + TransformControls + BoneJSONHelper',
      upstream_commit: UPSTREAM_COMMIT, changes: session.events, changed_glb_nodes: changed,
      output: values.output ? resolve(values.output) : null,
      native_pose: values['pose-out'] ? resolve(values['pose-out']) : null,
      desktop_app_modified: false, generation_jobs: 0,
    }, null, 2) + '\n');
  } finally { closeSession(session); }
}

main().catch(error => { process.stderr.write(`error: ${error.message}\n`); process.exitCode = 1; });
