import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pi = path.resolve(process.argv[2] || path.join(here, '../pi'));
const bundle = path.resolve(process.argv[3] || path.join(here, 'bundle'));
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const previous = {
  'lib.php': 'dbd73a5fb4b4cf45df1e7311a44986e0e43dd84054cd932fc1bf097c533d4ca3',
  'remote.php': '9ece56204bdbc2e7da6eb1cf27264d8ccaa9ec7dbac6a19865aac88630c0682f',
};
const files = {};
fs.mkdirSync(bundle, { recursive: true });
for (const name of ['lib.php', 'remote.php', 'worker.php', 'supervisor.py', 'init-wemo-worker', 'cron-wemo-worker', 'logrotate-wemo-worker']) {
  const data = fs.readFileSync(path.join(name.endsWith('.php') ? pi : here, name));
  fs.writeFileSync(path.join(bundle, name), data);
  files[name] = { sha256: hash(data), beforeSha256: previous[name] || null };
}
const manifest = Buffer.from(JSON.stringify({ schema: 1, files }, null, 2) + '\n');
fs.writeFileSync(path.join(bundle, 'manifest.json'), manifest);
fs.copyFileSync(path.join(here, 'install.py'), path.join(bundle, 'install.py'));
console.log(JSON.stringify({ bundle, manifestSha256: hash(manifest), installerSha256: hash(fs.readFileSync(path.join(bundle, 'install.py'))), files: Object.keys(files).length }));
