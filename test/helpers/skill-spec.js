// Agent Skills frontmatter checks, from https://agentskills.io/specification (read 2026-11-27):
//   name         required, 1-64 chars, a-z 0-9 and hyphens, no leading/trailing/consecutive
//                hyphen, must match the parent directory name
//   description  required, 1-1024 chars, non-empty
//   license      optional; compatibility optional, 1-500 chars; metadata optional, string -> string
//   allowed-tools optional, space-separated string (experimental)
// Stricter than the spec (our choice, labelled): unknown top-level fields are rejected, and
// only the simple YAML this skill uses is accepted (key: value, quoted strings, one nested map).
import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

export const FIELDS = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function scalar(raw) {
  const v = raw.trim();
  if (/^".*"$/.test(v)) return JSON.parse(v);
  if (/^'.*'$/.test(v)) return v.slice(1, -1).replaceAll("''", "'");
  return v;
}

export function splitSkill(text) {
  const m = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  return { frontmatter: m[1], body: m[2] };
}

export function parseFrontmatter(yaml) {
  const out = {};
  const errors = [];
  let map = null;
  for (const line of yaml.split('\n')) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const nested = line.match(/^ {2}([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (nested && map) {
      const raw = nested[2].trim();
      map[nested[1]] = /^(".*"|'.*')$/.test(raw) ? scalar(raw) : { notQuoted: raw };
      continue;
    }
    const top = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!top) { errors.push(`unsupported frontmatter line: ${JSON.stringify(line)}`); continue; }
    map = null;
    if (top[2].trim() === '') { out[top[1]] = {}; map = out[top[1]]; } else out[top[1]] = scalar(top[2]);
  }
  return { data: out, errors };
}

export function validateSkill(text, dirName) {
  const errors = [];
  const parts = splitSkill(text);
  if (!parts) return { ok: false, errors: ['SKILL.md must start with a --- frontmatter block closed by ---'] };
  const { data, errors: parseErrors } = parseFrontmatter(parts.frontmatter);
  errors.push(...parseErrors);
  for (const k of Object.keys(data)) if (!FIELDS.includes(k)) errors.push(`unknown frontmatter field ${JSON.stringify(k)}`);

  const { name, description, compatibility, metadata, license } = data;
  if (typeof name !== 'string' || name.length < 1 || name.length > 64) errors.push('name must be 1-64 characters');
  else {
    if (!NAME_RE.test(name)) errors.push(`name ${JSON.stringify(name)} must use a-z, 0-9 and single hyphens, not at the start or end`);
    if (dirName !== undefined && name !== dirName) errors.push(`name ${JSON.stringify(name)} must match the directory name ${JSON.stringify(dirName)}`);
  }
  if (typeof description !== 'string' || description.trim() === '' || description.length > 1024) errors.push('description must be 1-1024 characters and non-empty');
  if (compatibility !== undefined && (typeof compatibility !== 'string' || compatibility.length < 1 || compatibility.length > 500)) errors.push('compatibility must be 1-500 characters');
  if (license !== undefined && typeof license !== 'string') errors.push('license must be a string');
  if (data['allowed-tools'] !== undefined && typeof data['allowed-tools'] !== 'string') errors.push('allowed-tools must be a space-separated string');
  if (metadata !== undefined) {
    if (typeof metadata !== 'object' || metadata === null) errors.push('metadata must be a map');
    else for (const [k, v] of Object.entries(metadata)) if (typeof v !== 'string') errors.push(`metadata.${k} must be a quoted string`);
  }
  return { ok: errors.length === 0, errors, data, body: parts.body };
}

export function validateSkillFile(path) {
  return validateSkill(readFileSync(path, 'utf8'), basename(dirname(path)));
}
