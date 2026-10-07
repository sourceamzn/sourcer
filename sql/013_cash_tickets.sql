-- Solicitudes de efectivo, tickets de soporte y tareas del CRM.
-- Antes de esta migracion, los depositos, las retiradas, los tickets y las
-- tareas del CRM vivian SOLO en el navegador (localStorage): al usarlos un
-- cliente real, desaparecian al limpiar el navegador o al cambiar de equipo.
-- Estas tablas los llevan al robot, que pasa a ser la fuente de verdad.

-- ---------------------------------------------------------------------------
-- Solicitudes de efectivo (deposito / retirada) creadas desde el Area de
-- Cliente. NO mueven saldo por si solas: quedan 'pending' y el personal las
-- aprueba o rechaza. Al aprobarlas se reutiliza el servicio de dinero del
-- Trading Manager, que es quien mueve el balance y crea la transaccion.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS cash_request_number_seq;

CREATE TABLE IF NOT EXISTS cash_requests (
  id             TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL REFERENCES clients(client_id),
  account_number INTEGER NOT NULL REFERENCES trading_accounts(number),
  kind           TEXT NOT NULL,
  amount         NUMERIC(18,2) NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'EUR',
  method         TEXT,
  reference      TEXT,
  comment        TEXT,
  beneficiary    TEXT,
  iban           TEXT,
  bic            TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  transaction_id TEXT,
  reviewed_by    TEXT,
  reviewed_at    TIMESTAMPTZ,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cash_requests_kind_chk CHECK (kind IN ('deposit', 'withdrawal')),
  CONSTRAINT cash_requests_status_chk CHECK (status IN ('pending', 'approved', 'completed', 'rejected', 'cancelled')),
  CONSTRAINT cash_requests_amount_chk CHECK (amount > 0)
);
CREATE INDEX IF NOT EXISTS ix_cash_requests_status ON cash_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_cash_requests_client ON cash_requests (client_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Tickets de soporte creados desde el Area de Cliente (o abiertos por el
-- personal). Los mensajes se guardan como JSON para no necesitar una tabla
-- extra en esta fase.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS support_ticket_number_seq;

CREATE TABLE IF NOT EXISTS support_tickets (
  id             TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL REFERENCES clients(client_id),
  account_number INTEGER REFERENCES trading_accounts(number),
  subject        TEXT NOT NULL,
  category       TEXT NOT NULL DEFAULT 'other',
  priority       TEXT NOT NULL DEFAULT 'normal',
  status         TEXT NOT NULL DEFAULT 'open',
  messages       JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT support_tickets_status_chk CHECK (status IN ('open', 'waiting', 'resolved', 'closed'))
);
CREATE INDEX IF NOT EXISTS ix_support_tickets_client ON support_tickets (client_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS ix_support_tickets_status ON support_tickets (status, updated_at DESC);

-- ---------------------------------------------------------------------------
-- Tareas del CRM (ficha de lead / cliente). Antes vivian solo en el navegador.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS crm_task_number_seq;

CREATE TABLE IF NOT EXISTS crm_tasks (
  id          TEXT PRIMARY KEY,
  entity_type TEXT,
  entity_id   TEXT,
  title       TEXT NOT NULL,
  due         TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'open',
  user_id     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT crm_tasks_status_chk CHECK (status IN ('open', 'done', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS ix_crm_tasks_entity ON crm_tasks (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS ix_crm_tasks_status ON crm_tasks (status, due);
