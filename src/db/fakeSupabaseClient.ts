/**
 * A minimal in-memory stand-in for `@supabase/supabase-js`'s query builder,
 * covering exactly the chain shapes this project actually uses (see
 * `src/whatsapp/auth/supabaseAuthStateProvider.ts` and
 * `src/whatsapp/accountStore.ts`): `select().eq().maybeSingle()`,
 * `select().eq().in()`, `select().order()`, `insert()`, `update().eq()`,
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
}

class FakeQueryBuilder implements PromiseLike<{
  data: unknown;
  error: { message: string } | null;
}> {
  private op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
  private filters: Array<{ col: string; type: 'eq' | 'in'; val: unknown }> = [];
  private payload: Row | Row[] | undefined;
  private upsertConflictCols: string[] = [];
  private single = false;
  private orderBy: { col: string; ascending: boolean } | undefined;

  constructor(private readonly table: FakeTable) {}

  select(_columns?: string): this {
    this.op = 'select';
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

  maybeSingle(): this {
    this.single = true;
    return this;
  }

  then<TResult1 = { data: unknown; error: { message: string } | null }, TResult2 = never>(
    onfulfilled?:
      | ((value: {
          data: unknown;
          error: { message: string } | null;
        }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  private matchesFilters(row: Row): boolean {
    return this.filters.every((f) =>
      f.type === 'eq' ? row[f.col] === f.val : (f.val as unknown[]).includes(row[f.col]),
    );
  }

  private execute(): { data: unknown; error: { message: string } | null } {
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
        if (this.single) {
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
        this.table.rows.push(...rows.map((r) => ({ ...r })));
        return { data: null, error: null };
      }
      case 'upsert': {
        const rows = Array.isArray(this.payload)
          ? this.payload
          : this.payload
            ? [this.payload]
            : [];
        for (const row of rows) {
          const idx = this.table.rows.findIndex((existing) =>
            this.upsertConflictCols.every((c) => existing[c] === row[c]),
          );
          if (idx >= 0) {
            this.table.rows[idx] = { ...this.table.rows[idx], ...row };
          } else {
            this.table.rows.push({ ...row });
          }
        }
        return { data: null, error: null };
      }
      case 'update': {
        for (const row of this.table.rows) {
          if (this.matchesFilters(row)) Object.assign(row, this.payload);
        }
        return { data: null, error: null };
      }
      case 'delete': {
        this.table.rows = this.table.rows.filter((r) => !this.matchesFilters(r));
        return { data: null, error: null };
      }
    }
  }
}

export class FakeSupabaseClient {
  private readonly tables = new Map<string, FakeTable>();

  from(tableName: string): FakeQueryBuilder {
    let table = this.tables.get(tableName);
    if (!table) {
      table = new FakeTable();
      this.tables.set(tableName, table);
    }
    return new FakeQueryBuilder(table);
  }

  /** Test helper: inspect raw stored rows directly (bypassing the query builder). */
  rawRows(tableName: string): Row[] {
    return this.tables.get(tableName)?.rows ?? [];
  }
}
