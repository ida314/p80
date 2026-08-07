import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { afterEach, describe, expect, it } from 'vitest';
import * as tables from '../src/schema/index.js';
import { createTempDatabase, type TempDatabase } from './helpers.js';

/**
 * The SQL in `migrations/0001_initial.sql` is the authority (`02-database.md` §3 rule 1).
 * The Drizzle definitions are a typed mirror of it, and a mirror nobody checks is just
 * two sources of truth.
 *
 * This walks every exported table and compares its columns against SQLite's own
 * introspection, so a column added to one side and not the other fails here rather than
 * at a runtime `no such column` three stages later.
 */
let temp: TempDatabase;
afterEach(() => temp?.dispose());

describe('Drizzle schema mirrors the migration', () => {
  it('matches table and column names exactly', () => {
    temp = createTempDatabase();

    const mismatches: string[] = [];

    for (const value of Object.values(tables)) {
      const config = getTableConfig(value);
      const declared = config.columns.map((c) => c.name).sort();

      const actual = (
        temp.sqlite.prepare(`PRAGMA table_info(${config.name})`).all() as Array<{
          name: string;
        }>
      )
        .map((r) => r.name)
        .sort();

      if (actual.length === 0) {
        mismatches.push(`${config.name}: table missing from the migration`);
        continue;
      }

      const onlyInCode = declared.filter((c) => !actual.includes(c));
      const onlyInSql = actual.filter((c) => !declared.includes(c));
      if (onlyInCode.length > 0 || onlyInSql.length > 0) {
        mismatches.push(
          `${config.name}: only in schema.ts [${onlyInCode.join(', ')}], ` +
            `only in SQL [${onlyInSql.join(', ')}]`,
        );
      }
    }

    expect(mismatches).toEqual([]);
  });

  it('declares NOT NULL consistently with the migration', () => {
    temp = createTempDatabase();

    const mismatches: string[] = [];

    for (const value of Object.values(tables)) {
      const config = getTableConfig(value);
      const actual = new Map(
        (
          temp.sqlite.prepare(`PRAGMA table_info(${config.name})`).all() as Array<{
            name: string;
            notnull: number;
            pk: number;
          }>
        ).map((r) => [r.name, r.notnull === 1 || r.pk === 1]),
      );

      for (const column of config.columns) {
        const sqlRequired = actual.get(column.name);
        if (sqlRequired === undefined) continue;
        const codeRequired = column.notNull || column.primary;
        if (sqlRequired !== codeRequired) {
          mismatches.push(
            `${config.name}.${column.name}: schema.ts says ` +
              `${codeRequired ? 'NOT NULL' : 'nullable'}, SQL says ` +
              `${sqlRequired ? 'NOT NULL' : 'nullable'}`,
          );
        }
      }
    }

    expect(mismatches).toEqual([]);
  });
});
