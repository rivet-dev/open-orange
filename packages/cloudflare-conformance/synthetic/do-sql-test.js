import assert from 'node:assert';
import { DurableObject } from 'cloudflare:workers';

const scenarios = {
  // sqlite-test.c++: "SQLite Regulator", "SQLite Regulator blocks RENAME TO reserved name"
  async regulatorReservedNames(ctx) {
    const sql = ctx.storage.sql;
    await ctx.storage.put('k', 'v');
    assert.throws(() => sql.exec('SELECT * FROM _cf_KV'), /access to _cf_KV\.key is prohibited/);
    assert.throws(() => sql.exec('CREATE TABLE _cf_mine (x)'), /not authorized/);
    assert.throws(() => sql.exec("ATTACH DATABASE 'other.db' AS other"), /not authorized/);
    assert.throws(() => sql.exec('PRAGMA writable_schema = ON'), /not authorized/);

    sql.exec('CREATE TABLE user_data (key TEXT PRIMARY KEY, value BLOB)');
    sql.exec("INSERT INTO user_data VALUES ('k', x'deadbeef')");
    sql.exec('ALTER TABLE user_data RENAME TO other_data');
    assert.equal(sql.exec('SELECT value FROM other_data').one().value.byteLength, 4);

    assert.throws(() => sql.exec('ALTER TABLE other_data RENAME TO _cf_renamed'), /not authorized/);
    assert.throws(() => sql.exec('ALTER TABLE other_data RENAME TO _CF_evil'), /not authorized/);
    assert.equal(sql.exec('SELECT value FROM other_data').one().value.byteLength, 4);
    assert.equal(await ctx.storage.get('k'), 'v');

    // A schema change forces re-preparing cached statements; they must keep working.
    sql.exec('CREATE TABLE baz (value INTEGER)');
    assert.equal(sql.exec('SELECT value FROM other_data').one().value.byteLength, 4);
  },

  // sqlite-test.c++: "SQLite read row counters (basic)"
  async readRowCounters(ctx) {
    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE things (id INTEGER PRIMARY KEY, unindexed_int INTEGER, value TEXT)');
    const n = 1000;
    for (let i = 0; i < n; i++) {
      const c = sql.exec('INSERT INTO things VALUES (?, ?, ?)', i, i * 1000, `value${i}`);
      assert.equal(c.rowsRead, 1);
      assert.equal(c.rowsWritten, 1);
    }
    assert.equal(sql.exec('SELECT COUNT(*) AS c FROM things').one().c, n);

    const count = (query, ...args) => {
      const c = sql.exec(query, ...args);
      const found = c.toArray().length;
      return { found, read: c.rowsRead, written: c.rowsWritten };
    };
    assert.deepEqual(count('SELECT * FROM things'), { found: n, read: n, written: 0 });
    assert.deepEqual(count('SELECT * FROM things WHERE id = ?', 5), { found: 1, read: 1, written: 0 });
    assert.deepEqual(count('SELECT * FROM things WHERE id = ?', n / 2), {
      found: 1,
      read: 1,
      written: 0,
    });
    assert.deepEqual(count('SELECT * FROM things WHERE unindexed_int = ?', 5000), {
      found: 1,
      read: n,
      written: 0,
    });
    assert.deepEqual(count('SELECT MAX(unindexed_int) FROM things'), {
      found: 1,
      read: n,
      written: 0,
    });
    assert.deepEqual(count('SELECT MIN(id) FROM things'), { found: 1, read: 1, written: 0 });
    assert.deepEqual(count('SELECT * FROM things LIMIT 5'), { found: 5, read: 5, written: 0 });
  },

  // sqlite-test.c++: "SQLite write row counters (basic)"
  async writeRowCounters(ctx) {
    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE things (id INTEGER PRIMARY KEY)');
    sql.exec('CREATE TABLE unindexed_things (id INTEGER)');
    const count = (query, ...args) => {
      const c = sql.exec(query, ...args);
      c.toArray();
      return { read: c.rowsRead, written: c.rowsWritten };
    };

    assert.deepEqual(count('INSERT INTO unindexed_things (id) VALUES (?)', 1), {
      read: 0,
      written: 1,
    });
    // A primary key insert also reads to check for a duplicate key.
    assert.deepEqual(count('INSERT INTO things (id) VALUES (?)', 1), { read: 1, written: 1 });

    assert.equal(count('INSERT INTO things (id) VALUES (?)', 123).written, 1);
    assert.deepEqual(count('DELETE FROM things WHERE id = ?', 123), { read: 1, written: 1 });
    assert.equal(count('DELETE FROM things WHERE id = ?', 998877112233).written, 0);

    sql.exec('DELETE FROM things');
    sql.exec('INSERT INTO things (id) VALUES (1), (3), (5)');
    assert.deepEqual(count('INSERT INTO unindexed_things (id) SELECT id FROM things'), {
      read: 3,
      written: 3,
    });

    sql.exec('DELETE FROM unindexed_things');
    sql.exec('INSERT INTO unindexed_things (id) VALUES (1), (2), (3), (4)');
    assert.equal(count('UPDATE unindexed_things SET id = id * 10 WHERE id >= 3').written, 2);

    sql.exec('DELETE FROM things');
    sql.exec('INSERT INTO things (id) VALUES (1), (2), (3), (4)');
    const indexed = count('UPDATE things SET id = id * 10 WHERE id >= 3');
    assert.ok(indexed.read >= 4, `rowsRead ${indexed.read}`);
    assert.equal(indexed.written, 2);
  },

  // sqlite-test.c++: "SQLite read/write row counters (large row insert)"
  async largeRowCounters(ctx) {
    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE large_things (id INTEGER PRIMARY KEY, large_value TEXT)');
    const large = 'A'.repeat(100000);
    const ins = sql.exec('INSERT INTO large_things (id, large_value) VALUES (?, ?)', 1, large);
    assert.equal(ins.toArray().length, 0);
    assert.equal(ins.rowsRead, 1);
    assert.equal(ins.rowsWritten, 1);

    const sel = sql.exec('SELECT * FROM large_things WHERE id = ?', 1);
    const rows = sel.toArray();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].large_value.length, 100000);
    assert.equal(sel.rowsRead, 1);
    assert.equal(sel.rowsWritten, 0);
  },

  // sqlite-test.c++: "SQLite row counters with triggers"
  async triggerRowCounters(ctx) {
    const sql = ctx.storage.sql;
    sql.exec(`
      CREATE TABLE things (id INTEGER PRIMARY KEY);
      CREATE TABLE log (id INTEGER, verb TEXT);
      CREATE TRIGGER log_inserts AFTER INSERT ON things
      BEGIN
        INSERT INTO log (id, verb) VALUES (NEW.id, 'INSERT');
      END;
      CREATE TRIGGER log_deletes AFTER DELETE ON things
      BEGIN
        INSERT INTO log (id, verb) VALUES (OLD.id, 'DELETE');
      END;
    `);
    assert.equal(sql.exec('INSERT INTO things (id) VALUES (1)').rowsWritten, 2);

    sql.exec('DELETE FROM things');
    sql.exec('INSERT INTO things (id) VALUES (1)');
    sql.exec('INSERT INTO things (id) VALUES (2)');
    sql.exec('INSERT INTO things (id) VALUES (3)');
    assert.equal(sql.exec('DELETE FROM things').rowsWritten, 6);
    assert.deepEqual(
      sql.exec("SELECT id FROM log WHERE verb = 'DELETE' ORDER BY id").toArray(),
      [{ id: 1 }, { id: 1 }, { id: 2 }, { id: 3 }]
    );
  },

  // sqlite-test.c++: "DELETE with LIMIT"
  async deleteWithLimit(ctx) {
    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE things (id INTEGER PRIMARY KEY)');
    sql.exec('INSERT INTO things (id) VALUES (1), (2), (3), (4), (5)');
    assert.equal(sql.exec('DELETE FROM things LIMIT 2').rowsWritten, 2);
    assert.equal(sql.exec('SELECT COUNT(*) AS c FROM things').one().c, 3);
  },

  // sqlite-test.c++: "reset database"
  async resetDatabase(ctx) {
    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE things (id INTEGER PRIMARY KEY)');
    sql.exec('INSERT INTO things VALUES (123), (321)');

    const cursor = sql.exec('SELECT * FROM things ORDER BY id');
    assert.deepEqual(cursor.next().value, { id: 123 });

    await ctx.storage.deleteAll();
    assert.throws(() => cursor.next(), /canceled because the database was deleted/);

    assert.throws(() => sql.exec('SELECT * FROM things'), /no such table: things: SQLITE_ERROR/);

    sql.exec('CREATE TABLE things (id INTEGER PRIMARY KEY)');
    sql.exec('INSERT INTO things VALUES (456)');
    assert.deepEqual(sql.exec('SELECT * FROM things ORDER BY id').toArray(), [{ id: 456 }]);
  },

  // sqlite-test.c++: "SQLite failed statement reset"
  async failedStatementReset(ctx) {
    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE things (id INTEGER PRIMARY KEY)');
    const insert = 'INSERT INTO things VALUES (?)';
    sql.exec(insert, 1);
    sql.exec(insert, 2);
    assert.throws(() => sql.exec(insert, 1), /UNIQUE constraint failed: things\.id/);
    sql.exec(insert, 3);
    assert.throws(() => sql.exec(insert, 1), /UNIQUE constraint failed: things\.id/);
    sql.exec(insert, 4);
    assert.equal(sql.exec('SELECT COUNT(*) AS c FROM things').one().c, 4);
  },

  // sqlite-test.c++: "SQLite extended error codes in messages"
  async extendedErrorCodes(ctx) {
    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    sql.exec("INSERT INTO things VALUES (1, 'alice')");
    assert.throws(
      () => sql.exec("INSERT INTO things VALUES (1, 'bob')"),
      /UNIQUE constraint failed: things\.id: SQLITE_CONSTRAINT/
    );
    assert.throws(
      () => sql.exec('INSERT INTO things VALUES (2, NULL)'),
      /NOT NULL constraint failed: things\.name: SQLITE_CONSTRAINT/
    );
    let err;
    try {
      sql.exec('SELECT * FROM nonexistent');
    } catch (e) {
      err = e;
    }
    assert.match(err.message, /SQLITE_ERROR/);
    assert.doesNotMatch(err.message, /\(SQLITE_ERROR_/);
    assert.equal(sql.exec('SELECT COUNT(*) AS c FROM things').one().c, 1);
  },

  // sqlite-test.c++: "SQLite prepareMulti"
  async execMulti(ctx) {
    const sql = ctx.storage.sql;
    const multi = `
      CREATE TABLE IF NOT EXISTS things (id INTEGER PRIMARY KEY AUTOINCREMENT, value INTEGER);
      INSERT INTO things(value) VALUES (123);
      INSERT INTO things(value) VALUES (456);
      INSERT INTO things(value) VALUES (789);
      SELECT id, value FROM things;
    `;
    const first = sql.exec(multi);
    assert.deepEqual(first.columnNames, ['id', 'value']);
    assert.deepEqual(first.raw().toArray(), [
      [1, 123],
      [2, 456],
      [3, 789],
    ]);

    assert.deepEqual(sql.exec(multi).raw().toArray(), [
      [1, 123],
      [2, 456],
      [3, 789],
      [4, 123],
      [5, 456],
      [6, 789],
    ]);

    await ctx.storage.deleteAll();
    assert.deepEqual(sql.exec(multi).raw().toArray(), [
      [1, 123],
      [2, 456],
      [3, 789],
    ]);
  },

  // sqlite-test.c++: "SQLite prepareMulti with failure"
  async execMultiWithFailure(ctx) {
    const sql = ctx.storage.sql;
    const multi = `
      CREATE TABLE IF NOT EXISTS things (id INTEGER PRIMARY KEY AUTOINCREMENT, value INTEGER);
      INSERT INTO things(value) VALUES (123);
      INSERT INTO things(id, value) VALUES (1, 456);
    `;
    assert.throws(() => sql.exec(multi), /SQLITE_CONSTRAINT/);
    assert.throws(() => sql.exec(multi), /SQLITE_CONSTRAINT/);
    assert.throws(() => sql.exec(multi), /SQLITE_CONSTRAINT/);
    // No duplicated prefix statements across runs.
    assert.deepEqual(sql.exec('SELECT value FROM things ORDER BY id').raw().toArray(), [
      [123],
      [123],
      [123],
    ]);
  },

  // sqlite-test.c++: "SQLite prepareMulti w/BEGIN TRANSACTION"
  async execMultiRejectsBeginTransaction(ctx) {
    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE things (id INTEGER PRIMARY KEY AUTOINCREMENT, value INTEGER)');
    const multi = `
      INSERT INTO things(value) VALUES (123);
      BEGIN TRANSACTION;
      INSERT INTO things(value) VALUES (456);
      SELECT id, value FROM things;
    `;
    assert.throws(() => sql.exec(multi), /storage\.transaction\(\)/);
    assert.throws(() => sql.exec(multi), /storage\.transaction\(\)/);
    const rows = sql.exec('SELECT value FROM things').raw().toArray();
    assert.ok(
      rows.every(([v]) => v === 123),
      `no statement after BEGIN ran: ${JSON.stringify(rows)}`
    );
  },

  // sqlite-test.c++: "SQLite restrict internal functions to nested parse"
  async internalFunctionsBlocked(ctx) {
    const sql = ctx.storage.sql;
    sql.exec(
      "CREATE TABLE users (name TEXT DEFAULT (sqlite_drop_column(0, 'CREATE TABLE target(a, b)', 0)))"
    );
    assert.throws(
      () => sql.exec('INSERT INTO users DEFAULT VALUES'),
      /unknown function: sqlite_drop_column\(\): SQLITE_ERROR/
    );
    assert.equal(sql.exec('SELECT COUNT(*) AS c FROM users').one().c, 0);
    assert.throws(
      () => sql.exec("SELECT sqlite_drop_column(0, 'CREATE TABLE target(a, b)', 0)"),
      /sqlite_drop_column/
    );
  },

  // sqlite-test.c++: "SQLite authorizer matches default function names case-insensitively".
  // "SQLite authorizer is called in default column expressions" is not ported: it asserts that
  // workerd's SQL function allow-list refuses `sqlite_version()`, a Cloudflare refusal that Orange
  // does not copy.
  async authorizerDefaultExpressions(ctx) {
    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE users (created TEXT DEFAULT CURRENT_TIMESTAMP)');
    sql.exec('INSERT INTO users DEFAULT VALUES');
    const created = sql.exec('SELECT created FROM users').one().created;
    assert.equal(typeof created, 'string');
    assert.ok(created.length > 0);
  },

  // sqlite-test.c++: "SQLite R*Tree extension is enabled"
  async rtreeEnabled(ctx) {
    const sql = ctx.storage.sql;
    sql.exec('CREATE VIRTUAL TABLE demo_index USING rtree(id, minX, maxX, minY, maxY)');
    sql.exec(`
      INSERT INTO demo_index VALUES
        (1, -1.0, 1.0, -1.0, 1.0),
        (2, 10.0, 12.0, 10.0, 12.0),
        (3, -5.0, -3.0, -5.0, -3.0)
    `);
    const ids = sql
      .exec(
        `SELECT id FROM demo_index
         WHERE minX <= 2.0 AND maxX >= -2.0 AND minY <= 2.0 AND maxY >= -2.0
         ORDER BY id`
      )
      .raw()
      .toArray();
    assert.deepEqual(ids, [[1]]);
    assert.ok(sql.databaseSize > 0);
  },
};

export class TestDurableObject extends DurableObject {
  async run(name) {
    await scenarios[name](this.ctx);
  }
}

function makeTest(name) {
  return {
    async test(ctrl, env) {
      const stub = env.ns.get(env.ns.idFromName(`do-sql-${name}`));
      await stub.run(name);
    },
  };
}

export const regulatorReservedNames = makeTest('regulatorReservedNames');
export const readRowCounters = makeTest('readRowCounters');
export const writeRowCounters = makeTest('writeRowCounters');
export const largeRowCounters = makeTest('largeRowCounters');
export const triggerRowCounters = makeTest('triggerRowCounters');
export const deleteWithLimit = makeTest('deleteWithLimit');
export const resetDatabase = makeTest('resetDatabase');
export const failedStatementReset = makeTest('failedStatementReset');
export const extendedErrorCodes = makeTest('extendedErrorCodes');
export const execMulti = makeTest('execMulti');
export const execMultiWithFailure = makeTest('execMultiWithFailure');
export const execMultiRejectsBeginTransaction = makeTest('execMultiRejectsBeginTransaction');
export const internalFunctionsBlocked = makeTest('internalFunctionsBlocked');
export const authorizerDefaultExpressions = makeTest('authorizerDefaultExpressions');
export const rtreeEnabled = makeTest('rtreeEnabled');
