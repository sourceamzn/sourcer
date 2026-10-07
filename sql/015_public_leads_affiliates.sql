-- 015_public_leads_affiliates.sql
-- Captura publica de leads (formulario de la web) y programa de afiliados/IB.
-- La captura publica no usa el endpoint interno POST /leads (solo staff): crea
-- el lead con origen "web" y, si viene con codigo de referido, lo asocia a un
-- afiliado y deja la conversion inicial en affiliate_conversions.

-- 1) Campos que solo llegan desde la web publica.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm JSONB;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS referral_code TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS ip_hash TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS consent_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS ix_leads_referral ON leads (referral_code);

-- 2) Afiliados / IB (Introducing Brokers). El codigo es la parte visible del
--    enlace (https://whselfinvests.com/?ref=CODIGO).
CREATE SEQUENCE IF NOT EXISTS affiliate_number_seq START 1;

CREATE TABLE IF NOT EXISTS affiliates (
  affiliate_id     TEXT PRIMARY KEY,
  code             TEXT NOT NULL,
  name             TEXT NOT NULL,
  email            TEXT,
  company          TEXT,
  status           TEXT NOT NULL DEFAULT 'active',
  commission_type  TEXT NOT NULL DEFAULT 'cpa',
  commission_value NUMERIC(18,2) NOT NULL DEFAULT 0,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT affiliates_status_chk CHECK (status IN ('active','paused','closed')),
  CONSTRAINT affiliates_comm_chk CHECK (commission_type IN ('cpa','revshare','hybrid'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_affiliates_code ON affiliates (lower(code));
CREATE INDEX IF NOT EXISTS ix_affiliates_status ON affiliates (status);

-- 3) Conversiones del afiliado. "lead" se crea en la captura publica; "account"
--    y "deposit" las registra el robot cuando el lead se convierte en cliente y
--    cuando entra un deposito. El estado permite aprobar/pagar comisiones.
CREATE SEQUENCE IF NOT EXISTS affiliate_conversion_number_seq START 1;

CREATE TABLE IF NOT EXISTS affiliate_conversions (
  conversion_id TEXT PRIMARY KEY,
  affiliate_id  TEXT NOT NULL REFERENCES affiliates(affiliate_id) ON DELETE CASCADE,
  lead_id       TEXT REFERENCES leads(lead_id) ON DELETE SET NULL,
  client_id     TEXT REFERENCES clients(client_id) ON DELETE SET NULL,
  type          TEXT NOT NULL DEFAULT 'lead',
  amount        NUMERIC(18,2) NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT affiliate_conversions_type_chk CHECK (type IN ('lead','account','deposit')),
  CONSTRAINT affiliate_conversions_status_chk CHECK (status IN ('pending','approved','paid','rejected'))
);
CREATE INDEX IF NOT EXISTS ix_aff_conversions_affiliate ON affiliate_conversions (affiliate_id);
CREATE INDEX IF NOT EXISTS ix_aff_conversions_type ON affiliate_conversions (type, status);
