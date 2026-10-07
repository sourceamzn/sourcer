-- Borrado definitivo de leads y clientes reservado a administradores y
-- managers. El rol superadmin ya tiene el comodin '*'; aqui se dota al rol
-- manager de los permisos concretos para que la interfaz del CRM muestre los
-- botones de eliminar. Los agentes de ventas/retencion y soporte quedan sin
-- ellos, y el robot vuelve a comprobar el rol por su cuenta (defensa en
-- profundidad: no basta con ocultar el boton).
--
-- Idempotente: solo añade el permiso si aun no esta presente.

UPDATE roles
   SET perms = array_append(perms, 'leads.delete'), updated_at = now()
 WHERE id = 'manager'
   AND NOT (perms @> ARRAY['leads.delete']);

UPDATE roles
   SET perms = array_append(perms, 'clients.delete'), updated_at = now()
 WHERE id = 'manager'
   AND NOT (perms @> ARRAY['clients.delete']);
