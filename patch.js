const fs = require('fs');

function patchFile(file, edits) {
  let content = fs.readFileSync(file, 'utf8');
  for (const [search, replace] of edits) {
    if (!content.includes(search)) {
      console.error(`Could not find search string in ${file}:\n${search.substring(0, 50)}...`);
    } else {
      content = content.replace(search, replace);
    }
  }
  fs.writeFileSync(file, content);
  console.log(`Patched ${file}`);
}

const editsMjs = [
  // 1. STREAM HASHING for validateBackupFile
  [
    `export function validateBackupFile`,
    `import { pipeline } from 'node:stream/promises';\nexport async function validateBackupFile`
  ],
  [
    `  // Compute SHA-256 digest\n  const fileBytes = readFileSync(filePath);\n  const sha256 = createHash('sha256').update(fileBytes).digest('hex');\n\n  return {`,
    `  // Compute SHA-256 digest\n  const hash = createHash('sha256');\n  await pipeline(fs.createReadStream(filePath), hash);\n  const sha256 = hash.digest('hex');\n\n  return {`
  ]
];

patchFile('scripts/db-backup-restore-drill.mjs', editsMjs);
