/**
 * prisma/schema.prisma DESCRIBES tables the SQL migrations own (see its header),
 * so nothing regenerates it from the database. This compares it with the live,
 * migrated database instead: every model's table and every scalar field's column
 * must exist, and optionality must match nullability. A model naming a column the
 * database lacks fails here rather than at the first query in production.
 *
 * Parsed from the schema text: the generated `prisma-client` carries no DMMF.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

interface Field {
  name: string;
  column: string;
  optional: boolean;
}
interface Model {
  name: string;
  table: string;
  fields: Field[];
}

const SCALARS = new Set(['String', 'Int', 'BigInt', 'Boolean', 'DateTime', 'Decimal', 'Float', 'Json', 'Bytes']);

function parse(schema: string): Model[] {
  const models: Model[] = [];
  for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const [, name, body] = m;
    const table = body.match(/@@map\("([^"]+)"\)/)?.[1] ?? name;
    const fields: Field[] = [];
    for (const raw of body.split('\n')) {
      const line = raw.replace(/\/\/.*$/, '').trim();
      if (!line || line.startsWith('@@')) continue;
      const [fname, ftype = ''] = line.split(/\s+/);
      const base = ftype.replace(/[?[\]]/g, '');
      if (!SCALARS.has(base) || ftype.endsWith('[]')) continue; // relations and lists are not columns
      fields.push({
        name: fname,
        column: line.match(/@map\("([^"]+)"\)/)?.[1] ?? fname,
        optional: ftype.endsWith('?'),
      });
    }
    models.push({ name, table, fields });
  }
  return models;
}

const models = parse(readFileSync('prisma/schema.prisma', 'utf8'));
const admin = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL });
afterAll(() => admin.end());

describe('prisma/schema.prisma matches the migrated database', () => {
  it('describes at least one model', () => {
    expect(models.length).toBeGreaterThan(0);
  });

  it.each(models.map((m) => [m.name, m] as const))('%s', async (_name, model) => {
    const r = await admin.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1`,
      [model.table],
    );
    expect(r.rows.length, `table ${model.table} does not exist`).toBeGreaterThan(0);
    const cols = new Map(r.rows.map((c) => [c.column_name, c.is_nullable === 'YES']));
    for (const f of model.fields) {
      expect(cols.has(f.column), `${model.name}.${f.name} -> ${model.table}.${f.column} is not a column`).toBe(true);
      expect(cols.get(f.column), `${model.name}.${f.name}: optionality differs from ${model.table}.${f.column}`).toBe(
        f.optional,
      );
    }
  });
});
