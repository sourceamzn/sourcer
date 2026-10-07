-- Roles y flujo comercial del CRM (ronda de correcciones).
--
-- 1) El agente de Ventas ("First Conversion") debe poder convertir SUS leads
--    en clientes. Hasta ahora clients.convert solo lo tenían manager y
--    superadmin, así que el botón "Convertir en cliente" no aparecía al
--    agente. Se le concede el permiso.
-- 2) Retención y Manager deben poder abrir cuentas de trading al instante
--    desde el CRM (sin pasar por una solicitud que aprueba el Trading
--    Manager). Se les concede accounts.create.
--
-- Idempotente: solo añade el permiso si el rol todavía no lo tiene, de modo
-- que reaplicar la migración no duplica valores.

UPDATE roles
   SET perms = array_append(perms, 'clients.convert'), updated_at = now()
 WHERE id = 'sales_agent'
   AND NOT (perms @> ARRAY['clients.convert']);

UPDATE roles
   SET perms = array_append(perms, 'accounts.create'), updated_at = now()
 WHERE id IN ('retention_agent', 'manager')
   AND NOT (perms @> ARRAY['accounts.create']);
