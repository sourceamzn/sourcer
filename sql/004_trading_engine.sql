-- Motor de ejecución de órdenes del Trading Terminal.
-- Añade las secuencias de tickets/ids y el catálogo de instrumentos con su
-- tamaño de contrato y divisa de cotización, que el motor necesita para
-- calcular el P/L realizado al cerrar una posición.

CREATE SEQUENCE IF NOT EXISTS order_ticket_seq START 1;
CREATE SEQUENCE IF NOT EXISTS position_ticket_seq START 1;
CREATE SEQUENCE IF NOT EXISTS trade_ticket_seq START 1;
CREATE SEQUENCE IF NOT EXISTS trade_number_seq START 1;
CREATE SEQUENCE IF NOT EXISTS transaction_number_seq START 1;

ALTER TABLE instruments ADD COLUMN IF NOT EXISTS ccy TEXT;

INSERT INTO instruments (id, symbol, name, asset_class, digits, contract_size, ccy, enabled)
VALUES
  ('ins_eurusd', 'EURUSD', 'Euro / Dólar',        'Forex',    5, 100000, 'USD', true),
  ('ins_gbpusd', 'GBPUSD', 'Libra / Dólar',       'Forex',    5, 100000, 'USD', true),
  ('ins_usdjpy', 'USDJPY', 'Dólar / Yen',         'Forex',    3, 100000, 'JPY', true),
  ('ins_usdchf', 'USDCHF', 'Dólar / Franco',      'Forex',    5, 100000, 'CHF', true),
  ('ins_audusd', 'AUDUSD', 'Aussie / Dólar',      'Forex',    5, 100000, 'USD', true),
  ('ins_usdcad', 'USDCAD', 'Dólar / Loonie',      'Forex',    5, 100000, 'CAD', true),
  ('ins_eurjpy', 'EURJPY', 'Euro / Yen',          'Forex',    3, 100000, 'JPY', true),
  ('ins_btcusd', 'BTCUSD', 'Bitcoin / Dólar',     'Cripto',   1,      1, 'USD', true),
  ('ins_ethusd', 'ETHUSD', 'Ethereum / Dólar',    'Cripto',   2,      1, 'USD', true),
  ('ins_solusd', 'SOLUSD', 'Solana / Dólar',      'Cripto',   2,      1, 'USD', true),
  ('ins_xrpusd', 'XRPUSD', 'XRP / Dólar',         'Cripto',   4,      1, 'USD', true),
  ('ins_bnbusd', 'BNBUSD', 'BNB / Dólar',         'Cripto',   2,      1, 'USD', true),
  ('ins_us500',  'US500',  'S&P 500',             'Índices',  1,     50, 'USD', true),
  ('ins_nas100', 'NAS100', 'Nasdaq 100',          'Índices',  1,     20, 'USD', true),
  ('ins_us30',   'US30',   'Dow Jones 30',        'Índices',  1,      5, 'USD', true),
  ('ins_ger40',  'GER40',  'DAX 40',              'Índices',  1,     25, 'EUR', true),
  ('ins_uk100',  'UK100',  'FTSE 100',            'Índices',  1,     10, 'GBP', true),
  ('ins_jp225',  'JP225',  'Nikkei 225',          'Índices',  1,      5, 'JPY', true),
  ('ins_fra40',  'FRA40',  'CAC 40',              'Índices',  1,     10, 'EUR', true),
  ('ins_esp35',  'ESP35',  'IBEX 35',             'Índices',  1,     10, 'EUR', true),
  ('ins_xauusd', 'XAUUSD', 'Oro spot',            'Metales',  2,    100, 'USD', true),
  ('ins_xagusd', 'XAGUSD', 'Plata spot',          'Metales',  3,   5000, 'USD', true),
  ('ins_usoil',  'USOIL',  'Petróleo WTI',        'Energía',  2,   1000, 'USD', true),
  ('ins_ukoil',  'UKOIL',  'Petróleo Brent',      'Energía',  2,   1000, 'USD', true),
  ('ins_natgas', 'NATGAS', 'Gas natural',         'Energía',  3,  10000, 'USD', true),
  ('ins_nvda',   'NVDA',   'NVIDIA Corp.',        'Acciones', 2,      1, 'USD', true),
  ('ins_amd',    'AMD',    'Advanced Micro Devices', 'Acciones', 2,   1, 'USD', true),
  ('ins_msft',   'MSFT',   'Microsoft Corp.',     'Acciones', 2,      1, 'USD', true),
  ('ins_googl',  'GOOGL',  'Alphabet Inc.',       'Acciones', 2,      1, 'USD', true),
  ('ins_pltr',   'PLTR',   'Palantir Technologies', 'Acciones', 2,    1, 'USD', true),
  ('ins_tsm',    'TSM',    'Taiwan Semiconductor', 'Acciones', 2,     1, 'USD', true),
  ('ins_asml',   'ASML',   'ASML Holding',        'Acciones', 2,      1, 'USD', true),
  ('ins_arm',    'ARM',    'Arm Holdings',        'Acciones', 2,      1, 'USD', true),
  ('ins_aapl',   'AAPL',   'Apple Inc.',          'Acciones', 2,      1, 'USD', true),
  ('ins_tsla',   'TSLA',   'Tesla Inc.',          'Acciones', 2,      1, 'USD', true),
  ('ins_amzn',   'AMZN',   'Amazon.com',          'Acciones', 2,      1, 'USD', true),
  ('ins_meta',   'META',   'Meta Platforms',      'Acciones', 2,      1, 'USD', true),
  ('ins_ttwo',   'TTWO',   'Take-Two Interactive', 'Acciones', 2,     1, 'USD', true)
ON CONFLICT (id) DO NOTHING;
