CREATE SEQUENCE IF NOT EXISTS client_number_seq START 1;
CREATE SEQUENCE IF NOT EXISTS account_number_seq START 100000;
CREATE SEQUENCE IF NOT EXISTS account_request_number_seq START 1001;
CREATE SEQUENCE IF NOT EXISTS lead_number_seq START 1001;
CREATE SEQUENCE IF NOT EXISTS user_number_seq START 1;

CREATE TABLE IF NOT EXISTS clients (
  client_id     TEXT PRIMARY KEY,
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT,
  country       TEXT,
  age           INTEGER,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  kyc_status    TEXT NOT NULL DEFAULT 'pending',
  source        TEXT,
  campaign_id   TEXT,
  agent_id      TEXT,
  manager_id    TEXT,
  desk_id       TEXT,
  lead_id       TEXT,
  converted_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT clients_status_chk CHECK (status IN ('active','dormant','blocked','closed')),
  CONSTRAINT clients_kyc_chk CHECK (kyc_status IN ('pending','in_review','approved','rejected'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_clients_email ON clients (lower(email));

CREATE TABLE IF NOT EXISTS leads (
  lead_id     TEXT PRIMARY KEY,
  first_name  TEXT,
  last_name   TEXT,
  phone       TEXT,
  email       TEXT,
  age         INTEGER,
  description TEXT,
  status_id   TEXT NOT NULL DEFAULT 'st-new',
  agent_id    TEXT,
  manager_id  TEXT,
  desk_id     TEXT,
  campaign_id TEXT,
  source      TEXT,
  client_id   TEXT REFERENCES clients(client_id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT leads_status_chk CHECK (status_id IN ('st-new','st-callback','st-call','st-noint','st-reassign','st-conv'))
);
CREATE INDEX IF NOT EXISTS ix_leads_status ON leads (status_id);
CREATE INDEX IF NOT EXISTS ix_leads_email ON leads (lower(email));

CREATE TABLE IF NOT EXISTS users (
  user_id     TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  permissions TEXT[] NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_email ON users (lower(email));

CREATE TABLE IF NOT EXISTS account_types (
  account_type_id       TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  code                  TEXT NOT NULL,
  spread                NUMERIC(10,4),
  leverage              INTEGER,
  leverage_configurable BOOLEAN NOT NULL DEFAULT false,
  swap_type             TEXT,
  swap_long             NUMERIC(18,8),
  swap_short            NUMERIC(18,8),
  margin_call           NUMERIC(6,2),
  stop_out              NUMERIC(6,2),
  commission            NUMERIC(18,8),
  status                TEXT NOT NULL DEFAULT 'active',
  description           TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT account_types_status_chk CHECK (status IN ('active','inactive'))
);

CREATE TABLE IF NOT EXISTS trading_accounts (
  account_id      TEXT PRIMARY KEY,
  number          INTEGER NOT NULL UNIQUE,
  client_id       TEXT NOT NULL REFERENCES clients(client_id),
  account_type_id TEXT NOT NULL REFERENCES account_types(account_type_id),
  currency        TEXT NOT NULL DEFAULT 'EUR',
  leverage        INTEGER NOT NULL,
  balance         NUMERIC(18,2) NOT NULL DEFAULT 0,
  equity          NUMERIC(18,2) NOT NULL DEFAULT 0,
  margin          NUMERIC(18,2) NOT NULL DEFAULT 0,
  free_margin     NUMERIC(18,2) NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending',
  archived        BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity   TIMESTAMPTZ,
  CONSTRAINT trading_accounts_status_chk CHECK (status IN ('pending','active','suspended','closed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_trading_accounts_active_client
  ON trading_accounts (client_id) WHERE archived = false;
CREATE INDEX IF NOT EXISTS ix_trading_accounts_client ON trading_accounts (client_id);

CREATE TABLE IF NOT EXISTS account_requests (
  request_id             TEXT PRIMARY KEY,
  client_id              TEXT NOT NULL REFERENCES clients(client_id),
  account_type_id        TEXT NOT NULL REFERENCES account_types(account_type_id),
  currency               TEXT NOT NULL DEFAULT 'EUR',
  status                 TEXT NOT NULL DEFAULT 'received',
  requested_by_type      TEXT NOT NULL,
  requested_by_id        TEXT,
  notes                  TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at             TIMESTAMPTZ,
  decided_by_id          TEXT,
  provisioned_account_id TEXT REFERENCES trading_accounts(account_id),
  CONSTRAINT account_requests_status_chk CHECK (status IN ('received','in_review','approved','rejected','provisioned')),
  CONSTRAINT account_requests_by_chk CHECK (requested_by_type IN ('crm','client-area','staff','system'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_account_requests_open
  ON account_requests (client_id) WHERE status IN ('received','in_review');
CREATE INDEX IF NOT EXISTS ix_account_requests_client ON account_requests (client_id);

CREATE TABLE IF NOT EXISTS credentials (
  credential_id     BIGSERIAL PRIMARY KEY,
  subject_type      TEXT NOT NULL,
  subject_id        TEXT NOT NULL,
  email             TEXT NOT NULL,
  password_hash     TEXT NOT NULL,
  realm             TEXT NOT NULL DEFAULT 'client-area',
  status            TEXT NOT NULL DEFAULT 'active',
  email_verified_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT credentials_subject_chk CHECK (subject_type IN ('client','staff')),
  CONSTRAINT credentials_realm_chk CHECK (realm IN ('client-area','crm','terminal'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_credentials_subject ON credentials (subject_type, subject_id, realm);
CREATE UNIQUE INDEX IF NOT EXISTS ux_credentials_email ON credentials (realm, lower(email));

CREATE TABLE IF NOT EXISTS sessions (
  token_id   TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id   TEXT NOT NULL,
  realm      TEXT NOT NULL,
  issued_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_sessions_actor ON sessions (actor_type, actor_id);

CREATE TABLE IF NOT EXISTS one_time_tokens (
  id            BIGSERIAL PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  purpose       TEXT NOT NULL,
  credential_id BIGINT REFERENCES credentials(credential_id) ON DELETE CASCADE,
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT one_time_tokens_purpose_chk CHECK (purpose IN ('email_verify','password_reset'))
);

CREATE TABLE IF NOT EXISTS instruments (
  id            TEXT PRIMARY KEY,
  symbol        TEXT NOT NULL UNIQUE,
  name          TEXT,
  asset_class   TEXT,
  digits        INTEGER NOT NULL DEFAULT 2,
  contract_size NUMERIC(18,4) NOT NULL DEFAULT 1,
  min_volume    NUMERIC(18,4) NOT NULL DEFAULT 0.01,
  max_volume    NUMERIC(18,4) NOT NULL DEFAULT 100,
  volume_step   NUMERIC(18,4) NOT NULL DEFAULT 0.01,
  hours         TEXT,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  bid           NUMERIC(18,6),
  ask           NUMERIC(18,6),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id             TEXT PRIMARY KEY,
  ticket         INTEGER NOT NULL,
  account_number INTEGER NOT NULL REFERENCES trading_accounts(number),
  symbol         TEXT NOT NULL,
  type           TEXT NOT NULL,
  side           TEXT NOT NULL,
  volume         NUMERIC(18,4) NOT NULL,
  price          NUMERIC(18,6),
  sl             NUMERIC(18,6),
  tp             NUMERIC(18,6),
  status         TEXT NOT NULL DEFAULT 'open',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_number, ticket)
);
CREATE INDEX IF NOT EXISTS ix_orders_account ON orders (account_number);

CREATE TABLE IF NOT EXISTS positions (
  id             TEXT PRIMARY KEY,
  ticket         INTEGER NOT NULL,
  account_number INTEGER NOT NULL REFERENCES trading_accounts(number),
  symbol         TEXT NOT NULL,
  side           TEXT NOT NULL,
  volume         NUMERIC(18,4) NOT NULL,
  open_price     NUMERIC(18,6),
  sl             NUMERIC(18,6),
  tp             NUMERIC(18,6),
  profit         NUMERIC(18,2) NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'open',
  opened_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at      TIMESTAMPTZ,
  UNIQUE (account_number, ticket)
);
CREATE INDEX IF NOT EXISTS ix_positions_account ON positions (account_number);

CREATE TABLE IF NOT EXISTS trades (
  id             TEXT PRIMARY KEY,
  ticket         INTEGER NOT NULL,
  account_number INTEGER NOT NULL REFERENCES trading_accounts(number),
  symbol         TEXT NOT NULL,
  side           TEXT NOT NULL,
  volume         NUMERIC(18,4) NOT NULL,
  open_price     NUMERIC(18,6),
  close_price    NUMERIC(18,6),
  profit         NUMERIC(18,2) NOT NULL DEFAULT 0,
  opened_at      TIMESTAMPTZ,
  closed_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_trades_account ON trades (account_number);

CREATE TABLE IF NOT EXISTS transactions (
  id             TEXT PRIMARY KEY,
  account_number INTEGER NOT NULL REFERENCES trading_accounts(number),
  type           TEXT NOT NULL,
  amount         NUMERIC(18,2) NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'EUR',
  balance_after  NUMERIC(18,2) NOT NULL DEFAULT 0,
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_transactions_account ON transactions (account_number);

CREATE TABLE IF NOT EXISTS audit_events (
  id         BIGSERIAL PRIMARY KEY,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_type TEXT NOT NULL,
  actor_id   TEXT,
  action     TEXT NOT NULL,
  object     TEXT,
  details    JSONB
);
CREATE INDEX IF NOT EXISTS ix_audit_events_at ON audit_events (at DESC);
