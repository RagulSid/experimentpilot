// The Track 04 skill's SKILL.md frontmatter follows the Agent Skills spec
// (https://agentskills.io/specification). The validator is tested on bad samples first,
// so a pass on the real file means something.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateSkill, validateSkillFile } from './helpers/skill-spec.js';

const SKILL = fileURLToPath(new URL('../skills/flagsmith-experiment-rollout/SKILL.md', import.meta.url));
const ok = (fm, body = '# x\n') => `---\n${fm}\n---\n${body}`;
const GOOD = 'name: my-skill\ndescription: Does a thing. Use when asked to do the thing.';

test('validator accepts a minimal valid skill', () => {
  assert.deepEqual(validateSkill(ok(GOOD), 'my-skill').errors, []);
});

test('validator rejects bad names (uppercase, edge or double hyphens, too long, wrong directory)', () => {
  for (const name of ['My-Skill', '-skill', 'skill-', 'my--skill', 'a'.repeat(65), 'my_skill']) {
    assert.equal(validateSkill(ok(`name: ${name}\ndescription: d`), name).ok, false, name);
  }
  assert.match(validateSkill(ok(GOOD), 'other-dir').errors.join(), /match the directory/);
});

test('validator rejects a missing, empty or over-long description and over-long compatibility', () => {
  assert.equal(validateSkill(ok('name: my-skill'), 'my-skill').ok, false);
  assert.equal(validateSkill(ok('name: my-skill\ndescription: ""'), 'my-skill').ok, false);
  assert.equal(validateSkill(ok(`name: my-skill\ndescription: ${'d'.repeat(1025)}`), 'my-skill').ok, false);
  assert.equal(validateSkill(ok(`${GOOD}\ncompatibility: ${'c'.repeat(501)}`), 'my-skill').ok, false);
});

test('validator rejects no frontmatter, unknown fields and unquoted metadata values', () => {
  assert.equal(validateSkill('# no frontmatter\n', 'my-skill').ok, false);
  assert.match(validateSkill(ok(`${GOOD}\nversion: 1`), 'my-skill').errors.join(), /unknown frontmatter field/);
  assert.match(validateSkill(ok(`${GOOD}\nmetadata:\n  version: 1.0`), 'my-skill').errors.join(), /quoted string/);
  assert.equal(validateSkill(ok(`${GOOD}\nmetadata:\n  version: "1.0"`), 'my-skill').ok, true);
});

test('skills/flagsmith-experiment-rollout/SKILL.md exists and its frontmatter is valid', () => {
  assert.ok(existsSync(SKILL), SKILL);
  const r = validateSkillFile(SKILL);
  assert.deepEqual(r.errors, []);
  assert.equal(r.data.name, 'flagsmith-experiment-rollout');
  assert.equal(r.data.license, 'MIT');
  assert.match(r.data.description, /Use when/, 'the description says when to use the skill');
});
