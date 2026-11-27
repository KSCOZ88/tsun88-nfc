'use strict';

const {waitUntil}=require('@vercel/functions');
const {postgres}=require('./postgres');
let schemaPromise;

async function ensureProductionQueue(sql) {
  schemaPromise ||= sql.transaction([
    sql`SELECT pg_advisory_xact_lock(8828, 3)`,
    sql`CREATE TABLE IF NOT EXISTS tsun_production_outbox (
      merchant_order_id text PRIMARY KEY,
      payment_provider text NOT NULL CHECK (payment_provider IN ('stripe', 'paypal', 'airwallex')),
      created_at timestamptz NOT NULL DEFAULT now(),
      synced_at timestamptz
    )`,
    sql`ALTER TABLE tsun_production_outbox ADD COLUMN IF NOT EXISTS sales_items jsonb NOT NULL DEFAULT '[]'::jsonb`,
    sql`ALTER TABLE tsun_production_outbox ENABLE ROW LEVEL SECURITY`
  ]).catch(error => {
    schemaPromise = undefined;
    throw error;
  });
  await schemaPromise;
}

async function syncProductionQueue(source, orderId = null) {
  const connection = process.env.PRODUCTION_QUEUE_DATABASE_URL;
  if (process.env.VERCEL_ENV !== 'production' || !connection) return;
  await ensureProductionQueue(source);
  const jobs = await source`SELECT merchant_order_id, payment_provider, created_at, sales_items
    FROM tsun_production_outbox
    WHERE synced_at IS NULL AND (${orderId}::text IS NULL OR merchant_order_id = ${orderId})
    ORDER BY created_at, merchant_order_id LIMIT 50`;
  if (!jobs.length) return;

  // If the source acknowledgement fails after delivery, the remote conflict
  // check makes replay safe and preserves the job's current production status.
  await postgres(connection)`INSERT INTO public.tsun_production_jobs (merchant_order_id, payment_provider, created_at, sales_items)
    SELECT merchant_order_id, payment_provider, created_at, sales_items FROM jsonb_to_recordset(${JSON.stringify(jobs)}::jsonb)
      AS jobs(merchant_order_id text, payment_provider text, created_at timestamptz, sales_items jsonb)
    ON CONFLICT DO NOTHING`;
  await source`UPDATE tsun_production_outbox SET synced_at=now()
    WHERE synced_at IS NULL AND merchant_order_id IN
      (SELECT jsonb_array_elements_text(${JSON.stringify(jobs.map(job => job.merchant_order_id))}::jsonb))`;
}

function scheduleProductionSync(sql, orderId) {
  if (process.env.VERCEL_ENV !== 'production' || !process.env.PRODUCTION_QUEUE_DATABASE_URL) return;
  waitUntil(syncProductionQueue(sql, orderId).catch(error => {
    const code = String(error?.code || '');
    console.error('[Production queue] sync failed', /^[a-z0-9_]{1,40}$/i.test(code) ? code : 'unknown');
  }));
}

module.exports={ensureProductionQueue,scheduleProductionSync};
