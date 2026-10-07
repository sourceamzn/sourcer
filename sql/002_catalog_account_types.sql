INSERT INTO account_types
  (account_type_id, name, code, spread, leverage, leverage_configurable, swap_type, swap_long, swap_short, margin_call, stop_out, commission, status, description)
VALUES
  ('at-essential',    'Essential',    'ESSENTIAL',    1.4,  30, false, 'points', -7.2, -4.1, 50, 20, 0, 'active', 'Cuenta inicial estandar'),
  ('at-advanced',     'Advanced',     'ADVANCED',     0.9,  50, false, 'points', -6.0, -3.5, 50, 20, 0, 'active', 'Cuenta avanzada'),
  ('at-elite',        'Elite',        'ELITE',        0.4, 100, false, 'points', -4.5, -2.5, 50, 20, 0, 'active', 'Cuenta elite'),
  ('at-professional', 'Professional', 'PROFESSIONAL', 0.1, 100, true,  'points', -3.0, -1.5, 50, 20, 0, 'active', 'Cuenta profesional')
ON CONFLICT (account_type_id) DO NOTHING;
