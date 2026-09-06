const fs = require('fs');
let content = fs.readFileSync('scripts/test/backup-restore-drill.test.mjs', 'utf8');

// validateBackupFile is async now
content = content.replace(
  /test\('backup validation: validateBackupFile rejects non-existent file', \(\) => {/g,
  "test('backup validation: validateBackupFile rejects non-existent file', async () => {"
);
content = content.replace(
  /assert\.throws\(\n\s*\(\) => validateBackupFile\(nonExistent, 'custom'\),/g,
  "await assert.rejects(\n    async () => await validateBackupFile(nonExistent, 'custom'),"
);

content = content.replace(
  /test\('backup validation: validateBackupFile rejects 0-byte empty file', \(\) => {/g,
  "test('backup validation: validateBackupFile rejects 0-byte empty file', async () => {"
);
content = content.replace(
  /assert\.throws\(\n\s*\(\) => validateBackupFile\(emptyFile, 'custom'\),/g,
  "await assert.rejects(\n      async () => await validateBackupFile(emptyFile, 'custom'),"
);

content = content.replace(
  /test\('backup validation: validateBackupFile rejects corrupted custom format archive without PGDMP header', \(\) => {/g,
  "test('backup validation: validateBackupFile rejects corrupted custom format archive without PGDMP header', async () => {"
);
content = content.replace(
  /assert\.throws\(\n\s*\(\) => validateBackupFile\(corruptFile, 'custom'\),/g,
  "await assert.rejects(\n      async () => await validateBackupFile(corruptFile, 'custom'),"
);

content = content.replace(
  /test\('backup validation: validateBackupFile accepts valid custom format archive with PGDMP header', \(\) => {/g,
  "test('backup validation: validateBackupFile accepts valid custom format archive with PGDMP header', async () => {"
);
content = content.replace(
  /const meta = validateBackupFile\(validFile, 'custom'\);/g,
  "const meta = await validateBackupFile(validFile, 'custom');"
);

// Checksum regex fix
content = content.replace(
  /\/Migration 1 checksum mismatch\//g,
  "/Migration 1 mismatch/"
);

// Missing tables due to CRITICAL_APPLICATION_TABLES checking all of them
content = content.replace(
  /\{ tablename: 'users' \}, \{ tablename: 'game_events' \}/g,
  "{ tablename: 'users' }, { tablename: 'game_events' }, ...CRITICAL_APPLICATION_TABLES.map(t => ({ tablename: t }))"
);

content = content.replace(
  /\{ tablename: 'schema_migrations' \}, \{ tablename: 'users' \}, \{ tablename: 'game_events' \}/g,
  "...CRITICAL_APPLICATION_TABLES.map(t => ({ tablename: t }))"
);

content = content.replace(
  /rows: \[\n\s*\{ tablename: 'schema_migrations' \},\n\s*\{ tablename: 'users' \},\n\s*\{ tablename: 'game_events' \},\n\s*\{ tablename: 'variants' \},\n\s*\]/g,
  "rows: CRITICAL_APPLICATION_TABLES.map(t => ({ tablename: t }))"
);

fs.writeFileSync('scripts/test/backup-restore-drill.test.mjs', content);
