import { promises as fs } from 'node:fs';
import path from 'node:path';
import { FileMigrationProvider, Migrator } from 'kysely/migration';
import { loadConfig } from '../config.ts';
import { createDb, type Db } from './index.ts';

export async function migrateToLatest(db: Db): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(import.meta.dirname, 'migrations'),
    }),
  });
  const { error, results } = await migrator.migrateToLatest();
  for (const r of results ?? []) {
    if (r.status === 'Error') console.error(`migration ${r.migrationName} failed`);
  }
  if (error) throw error;
}

// CLI entry: `node src/db/migrate.ts`
if (process.argv[1] && import.meta.filename === path.resolve(process.argv[1])) {
  const cfg = loadConfig();
  const db = createDb(cfg.DATABASE_URL, { poolMax: 2 });
  try {
    await migrateToLatest(db);
    console.log('migrations up to date');
  } finally {
    await db.destroy();
  }
}
