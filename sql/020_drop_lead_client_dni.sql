-- El DNI deja de ser un campo dedicado: su valor viaja dentro de la descripción.
-- Esta migración retira la columna y los índices que hubiera creado una versión
-- anterior (020_lead_client_dni.sql), de modo que ninguna base quede con la
-- casilla DNI. Es idempotente: se puede aplicar varias veces sin efecto.

DROP INDEX IF EXISTS ix_leads_dni;
DROP INDEX IF EXISTS ix_clients_dni;

ALTER TABLE leads   DROP COLUMN IF EXISTS dni;
ALTER TABLE clients DROP COLUMN IF EXISTS dni;
