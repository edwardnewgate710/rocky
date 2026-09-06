const fs = require('fs');
let content = fs.readFileSync('scripts/test/backup-restore-drill.test.mjs', 'utf8');

content = content.replace(
  /if \(text\.includes\('search_embeddings'\)\) \{\n\s*return \{ rows: \[\] \};\n\s*\}/g,
  "if (text.includes('search_embeddings')) {\n        return { rows: [{ index_name: 'search_embeddings_hnsw_idx', access_method: 'hnsw' }] };\n      }"
);

fs.writeFileSync('scripts/test/backup-restore-drill.test.mjs', content);
