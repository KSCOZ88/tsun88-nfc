'use strict';

const {readFileSync} = require('node:fs');
const {join} = require('node:path');

let connection;
let client;

function postgres(connectionString) {
  if (!connectionString) throw new Error('PostgreSQL connection is not configured');
  if (connection === connectionString && client) return client;
  const {Pool} = require('pg');
  const options = {connectionString, max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, allowExitOnIdle: true};
  const url = new URL(connectionString);
  if (url.hostname.endsWith('.pooler.supabase.com') && url.searchParams.get('sslmode') === 'verify-full') {
    // node-postgres lets sslmode in the URL replace the SSL options object.
    url.searchParams.delete('sslmode');
    options.connectionString = url.toString();
    options.ssl = {
      ca: readFileSync(join(__dirname, 'supabase-root-ca.pem'), 'utf8'),
      rejectUnauthorized: true
    };
  }
  const pool = new Pool(options);
  pool.on('error', () => console.error('Idle PostgreSQL connection closed unexpectedly'));

  const statements = new WeakMap();
  const execute = async (db, statement) => (await db.query(statement)).rows;
  function sql(strings, ...values) {
    const text = strings.reduce((query, segment, index) => query + (index ? '$' + index : '') + segment, '');
    const statement = {text, values};
    // Delay execution so transaction statements run on the same checked-out connection.
    let pending;
    const query = {
      then(resolve, reject) {
        pending ||= execute(pool, statement);
        return pending.then(resolve, reject);
      },
      catch(reject) {
        return this.then(undefined, reject);
      }
    };
    statements.set(query, statement);
    return query;
  }
  sql.transaction = async queries => {
    const batch = queries.map(query => {
      const statement = statements.get(query);
      if (!statement) throw new TypeError('Expected a PostgreSQL query from this client');
      return statement;
    });
    const db = await pool.connect();
    let discard = false;
    try {
      await db.query('BEGIN');
      const rows = [];
      for (const statement of batch) rows.push(await execute(db, statement));
      await db.query('COMMIT');
      return rows;
    } catch (error) {
      try { await db.query('ROLLBACK'); } catch { discard = true; }
      throw error;
    } finally {
      db.release(discard);
    }
  };
  connection = connectionString;
  client = sql;
  return sql;
}

module.exports = {postgres};
