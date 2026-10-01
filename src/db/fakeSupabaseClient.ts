/**
 * A minimal in-memory stand-in for `@supabase/supabase-js`'s query builder,
 * covering exactly the chain shapes this project actually uses (see
 * `src/whatsapp/auth/supabaseAuthStateProvider.ts`,
 * `src/whatsapp/accountStore.ts`, and the Phase 4+5 repositories under
 * `src/db/`): `select().eq().maybeSingle()`, `select().eq().in()`,
 * `select().order()`, `select().limit()`, `insert()`, `update().eq()`
 * (optionally `.select()` to get back the rows actually updated — the
 * atomic compare-and-set pattern `rule_matches.fired` relies on this),
 * `upsert(rows, {onConflict})`, `delete().eq()`.
 *
 * Test-only. Not part of the production build (excluded in
 * tsconfig.build.json) — it exists so `SupabaseAuthStateProvider` and the
 * Supabase-backed account store can be exercised, including a genuine
 * "process restart" simulation, without live Supabase credentials.
 */

type Row = Record<string, unknown>;

class FakeTable {
  rows: Row[] = [];
  /** Column sets enforced as unique (primary key or UNIQUE constraint) — see `defineUniqueConstraint`. */
  uniqueKeys: string[][] = [];
}

interface FakeError {
  message: string;
  code?: string;
}

class FakeQueryBuilder implements PromiseLike<{
  data: unknown;
  error: FakeError | null;
}> {
  private op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
  private filters: Array<{ col: string; type: 'eq' | 'in'; val: unknown }> = [];
  private payload: Row | Row[] | undefined;
  private upsertConflictCols: string[] = [];
  private singleRow = false;
  private orderBy: { col: string; ascending: boolean } | undefined;
  private limitCount: number | undefined;
  /** Set when `.select()` is chained after a write op — return affected rows instead of `null`. */
  private returning = false;

  constructor(private readonly table: FakeTable) {}

  select(_columns?: string): this {
    if (
      this.op === 'insert' ||
      this.op === 'update' ||
      this.op === 'upsert' ||
      this.op === 'delete'
    ) {
      this.returning = true;
    } else {
      this.op = 'select';
    }
    return this;
  }

  insert(payload: Row | Row[]): this {
    this.op = 'insert';
    this.payload = payload;
    return this;
  }

  update(payload: Row): this {
    this.op = 'update';
    this.payload = payload;
    return this;
  }

  upsert(payload: Row | Row[], options?: { onConflict?: string }): this {
    this.op = 'upsert';
    this.payload = payload;
    this.upsertConflictCols = (options?.onConflict ?? '').split(',').filter(Boolean);
    return this;
  }

  delete(): this {
    this.op = 'delete';
    return this;
  }

  eq(col: string, val: unknown): this {
    this.filters.push({ col, type: 'eq', val });
    return this;
  }

  in(col: string, vals: unknown[]): this {
    this.filters.push({ col, type: 'in', val: vals });
    return this;
  }

  order(col: string, options?: { ascending?: boolean }): this {
    this.orderBy = { col, ascending: options?.ascending ?? true };
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  maybeSingle(): this {
    this.singleRow = true;
    return this;
  }

  single(): this {
    this.singleRow = true;
    return this;
  }

  then<TResult1 = { data: unknown; error: FakeError | null }, TResult2 = never>(
    onfulfilled?:
      | ((value: { data: unknown; error: FakeError | null }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  /** Mirrors real supabase-js: `.select()` after a write returns rows; `.maybeSingle()`/`.single()` collapses that to one row (or null). */
  private returningData(affected: Row[]): Row[] | Row | null {
    if (!this.returning) return null;
    if (this.singleRow) return affected[0] ?? null;
    return affected;
  }

  private matchesFilters(row: Row): boolean {
    return this.filters.every((f) =>
      f.type === 'eq' ? row[f.col] === f.val : (f.val as unknown[]).includes(row[f.col]),
    );
  }

  private execute(): { data: unknown; error: FakeError | null } {
    switch (this.op) {
      case 'select': {
        let matched = this.table.rows.filter((r) => this.matchesFilters(r));
        if (this.orderBy) {
          const { col, ascending } = this.orderBy;
          matched = [...matched].sort((a, b) => {
            const av = String(a[col]);
            const bv = String(b[col]);
            return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
          });
        }
        if (this.limitCount !== undefined) {
          matched = matched.slice(0, this.limitCount);
        }
        if (this.singleRow) {
          if (matched.length > 1) return { data: null, error: { message: 'multiple rows found' } };
          return { data: matched[0] ?? null, error: null };
        }
        return { data: matched, error: null };
      }
      case 'insert': {
        const rows = Array.isArray(this.payload)
          ? this.payload
          : this.payload
            ? [this.payload]
            : [];
        for (const row of rows) {
          const violated = this.table.uniqueKeys.some((cols) =>
            this.table.rows.some((existing) => cols.every((c) => existing[c] === row[c])),
          );
          if (violated) {
            return {
              data: null,
              error: { message: 'duplicate key value violates unique constraint', code: '23505' },
            };
          }
        }
        const inserted = rows.map((r) => ({ ...r }));
        this.table.rows.push(...inserted);
        return { data: this.returningData(inserted), error: null };
      }
      case 'upsert': {
        const rows = Array.isArray(this.payload)
          ? this.payload
          : this.payload
            ? [this.payload]
            : [];
        const affected: Row[] = [];
        for (const row of rows) {
          const idx = this.table.rows.findIndex((existing) =>
            this.upsertConflictCols.every((c) => existing[c] === row[c]),
          );
          if (idx >= 0) {
            this.table.rows[idx] = { ...this.table.rows[idx], ...row };
            affected.push(this.table.rows[idx]!);
          } else {
            const inserted = { ...row };
            this.table.rows.push(inserted);
            affected.push(inserted);
          }
        }
        return { data: this.returningData(affected), error: null };
      }
      case 'update': {
        const affected: Row[] = [];
        for (const row of this.table.rows) {
          if (this.matchesFilters(row)) {
            Object.assign(row, this.payload);
            affected.push(row);
          }
        }
        return { data: this.returningData(affected), error: null };
      }
      case 'delete': {
        const affected = this.table.rows.filter((r) => this.matchesFilters(r));
        this.table.rows = this.table.rows.filter((r) => !this.matchesFilters(r));
        return { data: this.returningData(affected), error: null };
      }
    }
  }
}

export class FakeSupabaseClient {
  private readonly tables = new Map<string, FakeTable>();

  from(tableName: string): FakeQueryBuilder {
    return new FakeQueryBuilder(this.getOrCreateTable(tableName));
  }

  /**
   * Test helper: register a primary key / unique constraint so `.insert()`
   * rejects a duplicate with a Postgres-shaped `{code: '23505'}` error, the
   * same way the real `whatsapp_processed_events`/`rule_match_responders`
   * tables do. Call once per table before inserting.
   */
  defineUniqueConstraint(tableName: string, columns: string[]): void {
    this.getOrCreateTable(tableName).uniqueKeys.push(columns);
  }

  private getOrCreateTable(tableName: string): FakeTable {
    let table = this.tables.get(tableName);
    if (!table) {
      table = new FakeTable();
      this.tables.set(tableName, table);
    }
    return table;
  }

  /** Test helper: inspect raw stored rows directly (bypassing the query builder). */
  rawRows(tableName: string): Row[] {
    return this.tables.get(tableName)?.rows ?? [];
  }
}
