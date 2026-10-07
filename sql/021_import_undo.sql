-- Deshacer la ultima importacion masiva de leads.
--
-- Cada importacion sella todos sus leads con un identificador de lote
-- (import_batch). El CRM puede entonces deshacer la ultima subida borrando,
-- de una sola vez, los leads de ese lote.
--
-- Idempotente: se puede aplicar varias veces sin efecto.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS import_batch TEXT;

CREATE INDEX IF NOT EXISTS ix_leads_import_batch ON leads (import_batch);
