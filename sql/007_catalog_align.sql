-- Alinea el catálogo del robot con el de la Terminal MT4 (fuente canónica).
--
-- Al comparar los dos catálogos aparecían TAMAÑOS DE CONTRATO distintos para los
-- índices: la Terminal valoraba con contrato 1 (1,00 $ por punto y lote) y el
-- robot lo hacía con 50 (US500), 25 (GER40), etc. Por eso, al cerrar la misma
-- operación, el resultado no cuadraba entre lo que veía el cliente y lo que
-- registraba el robot.
--
-- Aquí se lleva el contrato de los índices a 1 y su divisa de cotización a USD,
-- que es lo que usa la Terminal; además se ajusta el número de decimales del
-- Bitcoin a 2. El resto de familias (Forex, metales, materias primas y acciones)
-- ya coincidían.

UPDATE instruments SET contract_size = 1, ccy = 'USD'
 WHERE symbol IN ('NAS100', 'US500', 'US30', 'GER40', 'UK100', 'JP225', 'FRA40', 'ESP35', 'HK50');

UPDATE instruments SET digits = 2
 WHERE symbol = 'BTCUSD' AND digits <> 2;
