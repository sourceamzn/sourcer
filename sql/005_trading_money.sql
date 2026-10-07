-- Movimientos de dinero del Trading Manager.
-- Añade el crédito (bono) sobre el saldo y enriquece el ledger de transacciones
-- con clave de idempotencia (para no duplicar un movimiento reintentado) y la
-- cuenta de contrapartida en transferencias. El precio de apertura de las
-- posiciones ya se audita en `audit_events` (action = 'position.modify').

ALTER TABLE trading_accounts ADD COLUMN IF NOT EXISTS bonus NUMERIC(18,2) NOT NULL DEFAULT 0;

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS ref TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_transactions_idempotency
  ON transactions (idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_transactions_account_type
  ON transactions (account_number, type);
