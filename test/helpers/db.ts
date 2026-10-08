import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const ROOT = join(import.meta.dirname, "..", "..");
const MIGRATIONS = ["supabase/migrations/20261002000001_init.sql"];

/**
 * Cria um banco novo e isolado, aplica o bootstrap (o que o Supabase já tem)
 * e as migrações reais. Cada arquivo de teste recebe o seu banco.
 */
export async function createTestDatabase(name: string): Promise<{ client: pg.Client; drop: () => Promise<void> }> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL não definida. Rode: export TEST_DATABASE_URL=$(bash scripts/test-db.sh up)",
    );
  }
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const dbUrl = new URL(url);
  dbUrl.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: dbUrl.toString() });
  await client.connect();
  await client.query(readFileSync(join(ROOT, "supabase/test-bootstrap.sql"), "utf8"));
  for (const m of MIGRATIONS) await client.query(readFileSync(join(ROOT, m), "utf8"));

  return {
    client,
    drop: async () => {
      await client.end();
      const a = new pg.Client({ connectionString: url });
      await a.connect();
      await a.query(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}
