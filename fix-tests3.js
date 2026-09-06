const fs = require('fs');
let content = fs.readFileSync('scripts/test/backup-restore-drill.test.mjs', 'utf8');

content = content.replace(/async async \(\) =>/g, 'async () =>');

fs.writeFileSync('scripts/test/backup-restore-drill.test.mjs', content);
