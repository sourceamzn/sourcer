-- Numeracion de tickets POR CUENTA (por cliente).
-- Antes los tickets de posiciones, ordenes e historial salian de una secuencia
-- global (position_ticket_seq, order_ticket_seq, trade_ticket_seq), asi que un
-- cliente veia "#15" porque otros clientes habian abierto operaciones antes.
-- Cada cuenta (cliente) debe empezar en 1 de forma independiente. El esquema ya
-- permite UNIQUE (account_number, ticket) en positions, orders y trades, por lo
-- que basta con un contador por cuenta y tipo que se incrementa de forma atomica.
CREATE TABLE IF NOT EXISTS operativa_counters (
  account_number INTEGER NOT NULL,
  kind           TEXT    NOT NULL,
  value          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_number, kind)
);
