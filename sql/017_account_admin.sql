-- Administración de cuentas de trading (bloquear, archivar, eliminar) reservada
-- a administradores y managers. El rol superadmin ya tiene el comodin '*'; aqui
-- se dota al rol manager de los permisos concretos para que el CRM muestre los
-- botones. El robot revalida el rol por su cuenta (defensa en profundidad).
--
-- Idempotente: solo añade cada permiso si aun no esta presente.

UPDATE roles
   SET perms = array_append(perms, 'accounts.block'), updated_at = now()
 WHERE id = 'manager'
   AND NOT (perms @> ARRAY['accounts.block']);

UPDATE roles
   SET perms = array_append(perms, 'accounts.archive'), updated_at = now()
 WHERE id = 'manager'
   AND NOT (perms @> ARRAY['accounts.archive']);

UPDATE roles
   SET perms = array_append(perms, 'accounts.delete'), updated_at = now()
 WHERE id = 'manager'
   AND NOT (perms @> ARRAY['accounts.delete']);
