-- Amplía el catálogo de instrumentos para que el robot acepte TODAS las
-- operaciones que se pueden lanzar desde la Terminal MT4 (trading.toolsnexora.world).
-- Hasta ahora el catálogo (004) solo cubría un subconjunto: al abrir desde la
-- Terminal un símbolo no listado, el motor respondía «Instrumento desconocido»
-- y la posición nunca llegaba al Manager.
--
-- Símbolos ya cubiertos por 004 que usan otro nombre en la Terminal:
--   US100 -> NAS100 · DE40 -> GER40 · FR40 -> FRA40 · ES35 -> ESP35 · NGAS -> NATGAS
-- La Terminal traduce esos cinco al enviar la orden, así que aquí solo se añaden
-- los que faltan por completo.

INSERT INTO instruments (id, symbol, name, asset_class, digits, contract_size, ccy, enabled)
VALUES
  ('ins_hk50',    'HK50',    'Hang Seng',                    'Índices',   1,      1, 'USD', true),
  ('ins_adausd',  'ADAUSD',  'Cardano / Dólar',              'Cripto',    4,      1, 'USD', true),
  ('ins_dogeusd', 'DOGEUSD', 'Dogecoin / Dólar',             'Cripto',    5,      1, 'USD', true),
  ('ins_ltcusd',  'LTCUSD',  'Litecoin / Dólar',             'Cripto',    2,      1, 'USD', true),
  ('ins_avaxusd', 'AVAXUSD', 'Avalanche / Dólar',            'Cripto',    2,      1, 'USD', true),
  ('ins_linkusd', 'LINKUSD', 'Chainlink / Dólar',            'Cripto',    2,      1, 'USD', true),
  ('ins_dotusd',  'DOTUSD',  'Polkadot / Dólar',             'Cripto',    3,      1, 'USD', true),
  ('ins_trxusd',  'TRXUSD',  'Tron / Dólar',                 'Cripto',    5,      1, 'USD', true),
  ('ins_nzdusd',  'NZDUSD',  'Dólar neozelandés / Dólar',    'Forex',     5, 100000, 'USD', true),
  ('ins_eurgbp',  'EURGBP',  'Euro / Libra',                 'Forex',     5, 100000, 'GBP', true),
  ('ins_gbpjpy',  'GBPJPY',  'Libra / Yen',                  'Forex',     3, 100000, 'JPY', true),
  ('ins_eurchf',  'EURCHF',  'Euro / Franco suizo',          'Forex',     5, 100000, 'CHF', true),
  ('ins_cadjpy',  'CADJPY',  'Dólar canadiense / Yen',       'Forex',     3, 100000, 'JPY', true),
  ('ins_xptusd',  'XPTUSD',  'Platino / Dólar',              'Metales',   2,    100, 'USD', true),
  ('ins_xcuusd',  'XCUUSD',  'Cobre / Dólar',                'Metales',   4,  25000, 'USD', true),
  ('ins_avgo',    'AVGO',    'Broadcom',                     'Acciones',  2,      1, 'USD', true),
  ('ins_mu',      'MU',      'Micron Technology',            'Acciones',  2,      1, 'USD', true),
  ('ins_nflx',    'NFLX',    'Netflix',                      'Acciones',  2,      1, 'USD', true),
  ('ins_jpm',     'JPM',     'JPMorgan Chase',               'Acciones',  2,      1, 'USD', true),
  ('ins_ko',      'KO',      'Coca-Cola',                    'Acciones',  2,      1, 'USD', true),
  ('ins_dis',     'DIS',     'Walt Disney',                  'Acciones',  2,      1, 'USD', true),
  ('ins_gtlb',    'GTLB',    'GitLab',                       'Acciones',  2,      1, 'USD', true),
  ('ins_ea',      'EA',      'Electronic Arts',              'Acciones',  2,      1, 'USD', true),
  ('ins_rblx',    'RBLX',    'Roblox',                       'Acciones',  2,      1, 'USD', true),
  ('ins_sony',    'SONY',    'Sony Group',                   'Acciones',  2,      1, 'USD', true),
  ('ins_ntdoy',   'NTDOY',   'Nintendo',                     'Acciones',  2,      1, 'USD', true)
ON CONFLICT (id) DO NOTHING;
