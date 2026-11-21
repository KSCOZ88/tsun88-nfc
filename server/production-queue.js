'use strict';

// Payment alone does not establish that the artwork is ready for printing.
const schemas = new WeakMap();

async function ensureProductionQueue(sql) {
  if (!schemas.has(sql)) {
    schemas.set(sql, sql.transaction([
      sql`SELECT pg_advisory_xact_lock(8828, 1)`,
      sql`CREATE TABLE IF NOT EXISTS tsun_production_jobs (
      merchant_order_id text PRIMARY KEY,
      payment_provider text NOT NULL CHECK (payment_provider IN ('stripe', 'paypal', 'airwallex')),
      status text NOT NULL DEFAULT 'awaiting_assets',
      created_at timestamptz NOT NULL DEFAULT now()
    )`
    ]).catch(error => {
      schemas.delete(sql);
      throw error;
    }));
  }
  await schemas.get(sql);
}

module.exports = {ensureProductionQueue};
