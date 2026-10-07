-- Botón "Cambiar contraseña" en la ficha de cliente del CRM.
--
-- El personal que atiende clientes (agentes de Ventas, agentes de Retención y
-- Managers) debe poder cambiar la contraseña del área de clientes de un
-- cliente desde su ficha. Se crea un permiso propio (clients.password) para no
-- reutilizar clients.edit (que además permite modificar los datos del cliente)
-- ni clients.view (que incluiría perfiles de solo lectura).
--
-- El robot ya autoriza la operación a cualquier actor de tipo "staff"
-- (POST /clients/:clientId/password), así que basta con conceder el permiso a
-- esos roles en el CRM.
--
-- Idempotente: solo añade el permiso si el rol todavía no lo tiene, de modo
-- que reaplicar la migración no duplica valores.

UPDATE roles
   SET perms = array_append(perms, 'clients.password'), updated_at = now()
 WHERE id IN ('manager', 'sales_agent', 'retention_agent')
   AND NOT (perms @> ARRAY['clients.password']);
