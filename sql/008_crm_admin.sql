-- Administración del CRM persistida en el robot.
--
-- Hasta ahora el CRM (empleados, roles, departamentos, desks, estados de lead y
-- notas) vivía en el almacén del navegador (localStorage) y desaparecía al
-- borrar las cookies. Aquí se crean en PostgreSQL las tablas que lo sostienen,
-- de modo que el robot sea la única fuente de verdad y los empleados puedan
-- iniciar sesión desde cualquier equipo.

-- Departamentos (Ventas · First Conversion, Retención, ...).
CREATE TABLE IF NOT EXISTS departments (
  id         TEXT PRIMARY KEY,
  key        TEXT,
  name       TEXT NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Roles RBAC configurables del CRM.
CREATE TABLE IF NOT EXISTS roles (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  perms       TEXT[] NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Desks (escritorios): equipo, manager y visibilidad.
CREATE TABLE IF NOT EXISTS desks (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  department_id TEXT REFERENCES departments(id) ON DELETE SET NULL,
  manager_id    TEXT,
  member_ids    TEXT[] NOT NULL DEFAULT '{}',
  viewer_ids    TEXT[] NOT NULL DEFAULT '{}',
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Estados de lead configurables (afectan a Leads, filtros, ficha y Pipeline).
CREATE TABLE IF NOT EXISTS lead_statuses (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  tone       TEXT NOT NULL DEFAULT 'neutral',
  sort_order INTEGER NOT NULL DEFAULT 1,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Campos de administración del CRM en los empleados (staff).
ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS department_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS desk_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS visible_desk_ids TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS ux_users_username
  ON users (lower(username)) WHERE username IS NOT NULL;

-- El CRM permite crear estados de lead a medida, así que el CHECK fijo de
-- 001_init ya no aplica.
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_chk;

-- Notas de leads y clientes: autor y fecha se registran automáticamente.
CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  text        TEXT NOT NULL,
  user_id     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_notes_entity ON notes (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS ix_notes_created ON notes (created_at DESC);

-- Semilla idempotente de la configuración base del CRM.
INSERT INTO departments (id, key, name) VALUES
  ('dep-sales', 'sales', 'Ventas · First Conversion'),
  ('dep-retention', 'retention', 'Retención')
ON CONFLICT (id) DO NOTHING;

INSERT INTO lead_statuses (id, label, tone, sort_order) VALUES
  ('st-new', 'Nuevo', 'accent', 1),
  ('st-callback', 'Llamar otra vez', 'warn', 2),
  ('st-call', 'En llamada', 'neutral', 3),
  ('st-noint', 'No interesado', 'down', 4),
  ('st-reassign', 'Reasignado', 'neutral', 5),
  ('st-conv', 'Convertido', 'up', 6)
ON CONFLICT (id) DO NOTHING;

INSERT INTO desks (id, name, department_id, active) VALUES
  ('desk-sales', 'Ventas · First Conversion', 'dep-sales', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO roles (id, name, description, perms) VALUES
  ('superadmin', 'Superadmin', 'Acceso total al CRM Manager y a la operación.', ARRAY['*']),
  ('manager', 'Manager', 'Gestiona los desks asignados, su equipo y sus leads/clientes.',
    ARRAY['dashboard.view','leads.view','leads.create','leads.edit','leads.assign','leads.import','pipeline.view','campaigns.view','clients.view','clients.edit','clients.convert','accounts.view','activity.view','finance.view','compliance.view','documents.view','tickets.view','tickets.reply','reports.view','users.view','desks.manage','statuses.manage','audit.view']),
  ('sales_agent', 'Sales Agent', 'Gestiona únicamente sus leads asignados.',
    ARRAY['dashboard.view','leads.view','leads.create','leads.edit','pipeline.view','campaigns.view','activity.view']),
  ('retention_agent', 'Retention Agent', 'Gestiona sus clientes asignados.',
    ARRAY['dashboard.view','clients.view','clients.edit','accounts.view','activity.view','tickets.view','tickets.reply']),
  ('support', 'Support', 'Consultas y tickets de soporte.',
    ARRAY['dashboard.view','clients.view','tickets.view','tickets.reply','activity.view']),
  ('compliance', 'Compliance', 'Verificación KYC y documentación.',
    ARRAY['dashboard.view','clients.view','compliance.view','compliance.review','documents.view','activity.view']),
  ('finance', 'Finance', 'Depósitos, retiros y aprobaciones.',
    ARRAY['dashboard.view','finance.view','finance.approve','clients.view','accounts.view','activity.view']),
  ('readonly', 'Read Only', 'Solo lectura de los módulos autorizados.',
    ARRAY['dashboard.view','leads.view','pipeline.view','campaigns.view','clients.view','accounts.view','activity.view','finance.view','compliance.view','documents.view','tickets.view','reports.view','users.view','audit.view'])
ON CONFLICT (id) DO NOTHING;
