-- The three channels of the demo.
--
-- The costs pull against the latency on purpose. RAIL-C is the cheapest and
-- the slowest, RAIL-A is the dearest and the fastest. The score then has a
-- real decision to make, and the weights become visible in the behaviour.
INSERT INTO channels (id, name, cost, corridor, enabled) VALUES
  ('RAIL-A', 'Alpha Bank Rail',    1.2000, 'NGN_BANK', TRUE),
  ('RAIL-B', 'Beta Payments Rail', 1.0000, 'NGN_BANK', TRUE),
  ('RAIL-C', 'Gamma Switch Rail',  0.8000, 'NGN_BANK', TRUE)
ON CONFLICT (id) DO NOTHING;
