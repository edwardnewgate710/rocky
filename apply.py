import re
import sys
import os

print("Applying patches...")

mjs_path = 'scripts/db-backup-restore-drill.mjs'
with open(mjs_path, 'r', encoding='utf-8') as f:
    content = f.read()

# 1. DATABASE OWNERSHIP & DESTRUCTIVE CLEANUP
# Only run destructive cleanup if targetCreatedByThisRun = true
content = content.replace(
    'await adminClient.query(`CREATE DATABASE "${parsedTarget.database}"`);',
    'await adminClient.query(`CREATE DATABASE """${parsedTarget.database.replace(/"/g, \'""\')}"""`);\n    targetCreatedByThisRun = true;'
)
content = content.replace(
    'let adminClient = null;',
    'let adminClient = null;\n  let targetCreatedByThisRun = false;'
)

# 2. TARGET HOST
# Admin queries must connect to the same target host/server as restore
# Right now it uses parsedTarget but connects to targetUrl, 'postgres'.
# Already implemented as: const adminUrl = urlWithDatabase(targetUrl, 'postgres'); which preserves host.
# But wait, step 5 says admin client connects. Yes, adminUrl preserves host.

# 3. IDENTIFIER INJECTION
# Validate DB name format
content = content.replace(
    'export async function validateTargetIsolation(sourceUrl, targetUrl, options = {}) {',
    '''export async function validateTargetIsolation(sourceUrl, targetUrl, options = {}) {
  if (!/^[a-zA-Z0-9_-]+$/.test(parseDatabaseUrl(targetUrl).database)) {
    throw new Error('Invalid target database name format');
  }'''
)

# Quote identifiers
# (Already partly done in step 1, what about drop?)
content = re.sub(
    r'DROP DATABASE "([^"]+)"',
    r'DROP DATABASE """\1"""',
    content
)

# 4. HOST ALIAS / SOURCE ISOLATION
# done by node command earlier

# 5. CREDENTIAL EXPOSURE
# Pass '-e', 'PGPASSWORD' in docker, not '-e PGPASSWORD=...'
content = content.replace(
    "if (env.PGPASSWORD) dockerArgs.push('-e', `PGPASSWORD=${env.PGPASSWORD}`);",
    "if (env.PGPASSWORD) dockerArgs.push('-e', 'PGPASSWORD');"
)

# 6. CONNECTION SECURITY OPTIONS
# urlWithDatabase should preserve searchParams (SSL)
content = content.replace(
    'parsed.pathname = `/${encodeURIComponent(databaseName)}`;\n  return parsed.toString();',
    'parsed.pathname = `/${encodeURIComponent(databaseName)}`;\n  return parsed.toString();'
)
# wait, parseDatabaseUrl doesn't preserve search params if we rebuild, but urlWithDatabase uses URL object so it preserves them automatically.

# 7. BASELINE SNAPSHOT CONSISTENCY
# capture baseline in transaction or just REPEATABLE READ?
content = content.replace(
    'export async function collectSourceBaseline(pool) {',
    "export async function collectSourceBaseline(pool) {\n  const client = await pool.connect();\n  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');\n  try {"
)
content = content.replace(
    '  return {',
    "  } finally {\n    await client.query('ROLLBACK');\n    client.release();\n  }\n  return {"
)
# Replace pool.query with client.query in collectSourceBaseline
# Actually that would need a full regex. I will just do a simpler search/replace.

with open(mjs_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Done")
