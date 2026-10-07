-- Campaña como TEXTO LIBRE en leads y clientes (además del campaign_id
-- histórico, que se conserva para no romper enlaces existentes) y permisos
-- necesarios para el importador masivo desde el CRM.
--
-- Idempotente: se puede aplicar varias veces sin efecto.

ALTER TABLE leads   ADD COLUMN IF NOT EXISTS campaign TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS campaign TEXT;

CREATE INDEX IF NOT EXISTS ix_leads_campaign   ON leads   (lower(campaign));
CREATE INDEX IF NOT EXISTS ix_clients_campaign ON clients (lower(campaign));

-- El rol manager recibe leads.import (usado por el importador masivo). Los
-- permisos de borrado (leads.delete / clients.delete) ya los concede la 016.
UPDATE roles
   SET perms = array_append(perms, 'leads.import'), updated_at = now()
 WHERE id = 'manager'
   AND NOT (perms @> ARRAY['leads.import']);
