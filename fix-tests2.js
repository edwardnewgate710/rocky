const fs = require('fs');
let content = fs.readFileSync('scripts/test/backup-restore-drill.test.mjs', 'utf8');

content = content.replace(
  /validateTargetIsolation\(source, target\)/g,
  'await validateTargetIsolation(source, target)'
);
content = content.replace(
  /validateTargetIsolation\(source, target, /g,
  'await validateTargetIsolation(source, target, '
);

content = content.replace(
  /const validated = /g,
  'const validated = await '
);

content = content.replace(
  /test\('isolation:.*\(\) => \{/g,
  (match) => match.replace('() => {', 'async () => {')
);

// fix assert.throws for validateTargetIsolation
content = content.replace(
  /assert\.throws\(\n\s*\(\) => await validateTargetIsolation/g,
  "await assert.rejects(\n    async () => await validateTargetIsolation"
);
content = content.replace(
  /assert\.throws\(\n\s*\(\) => validateTargetIsolation/g,
  "await assert.rejects(\n    async () => await validateTargetIsolation"
);

// fix missing awaits for validateTargetIsolation inside blocks
content = content.replace(
  /await await validateTargetIsolation/g,
  "await validateTargetIsolation"
);

// Mock pool connect
content = content.replace(
  /async query\(text, params\) \{/g,
  "async connect() { return { query: this.query, release: () => {} }; },\n    async query(text, params) {"
);

fs.writeFileSync('scripts/test/backup-restore-drill.test.mjs', content);
