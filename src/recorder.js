// Saves each Flagsmith call (already redacted by the client) as a numbered JSON file,
// so real responses can become test fixtures. Used by `pilot apply --record <folder>`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function createRecorder(dir) {
  let n = 0;
  return (entry) => {
    n += 1;
    mkdirSync(dir, { recursive: true });
    let response = entry.response;
    if (typeof response === 'string' && response !== '') {
      try { response = JSON.parse(response); } catch { /* keep the text as it came */ }
    }
    const file = join(dir, `${String(n).padStart(2, '0')}-${entry.route}.json`);
    writeFileSync(file, `${JSON.stringify({ ...entry, response }, null, 2)}\n`);
    return file;
  };
}
