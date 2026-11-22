-- Activate the storefront's separate database credential after granting access.
CREATE ROLE production_queue_writer NOLOGIN NOINHERIT;
GRANT USAGE ON SCHEMA public TO production_queue_writer;
GRANT INSERT (merchant_order_id, payment_provider, created_at)
  ON TABLE public.tsun_production_jobs TO production_queue_writer;
CREATE POLICY production_queue_writer_insert ON public.tsun_production_jobs
  FOR INSERT TO production_queue_writer WITH CHECK (status = 'awaiting_assets');
