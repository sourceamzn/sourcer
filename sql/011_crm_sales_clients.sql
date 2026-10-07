-- Sección "Clientes" para el escritorio de Ventas.
--
-- Al convertir un lead, el CRM saca el registro de la lista de Leads y lo
-- muestra en la sección Clientes. Para que el agente de Ventas pueda abrir esa
-- sección y ver la ficha del cliente que acaba de convertir (tipo de cuenta
-- generado y cambio de contraseña), necesita el permiso clients.view, que
-- hasta ahora solo tenían manager, retention_agent y los roles de solo lectura.
--
-- Idempotente: solo añade el permiso si el rol todavía no lo tiene, de modo
-- que reaplicar la migración no duplica valores.

UPDATE roles
   SET perms = array_append(perms, 'clients.view'), updated_at = now()
 WHERE id = 'sales_agent'
   AND NOT (perms @> ARRAY['clients.view']);
