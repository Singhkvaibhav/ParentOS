-- Demo seed data for local development.
-- Password for the demo seller account is: demo1234

INSERT INTO users (id, name, email, password_hash, verified)
VALUES (1, 'Demo Seller', 'demo@example.com', '$2a$10$RCfyiqa.lxI/H.9NdBWgVuISeCjrNCKTXaChFgKBxAbrBqLJPlVES', true)
ON CONFLICT (email) DO NOTHING;

-- Explicit id above means the SERIAL sequence doesn't know id=1 is taken -
-- bump it forward so the next auto-generated user id doesn't collide.
SELECT setval('users_id_seq', (SELECT MAX(id) FROM users));

INSERT INTO listings (seller_id, category, title, price_cents, size_or_age, condition, city, area, pincode, lat, lng, description, photo_url)
VALUES
(1, 'clothes', 'Reima winter overalls', 1800, '86 cm (12-18 mo)', 'Good', 'Helsinki', 'Kallio', '00530', 60.1841, 24.9500, 'Warm Reima overalls, used one winter. No rips or stains, smoke-free home.', NULL),
(1, 'clothes', 'Polarn O. Pyret knit sweaters (set of 3)', 2200, '98 cm (2-3 y)', 'Like new', 'Espoo', 'Tapiola', '02100', 60.1756, 24.8047, 'Barely worn, outgrown before the season ended.', NULL),
(1, 'accessories', 'Britax car seat rain cover & sun shade', 1200, 'Universal fit', 'Like new', 'Helsinki', 'Toolo', '00260', 60.1756, 24.9130, 'Used for one summer. Fits most infant car seats.', NULL),
(1, 'toys', 'Brio wooden train starter set', 2500, '3+ years', 'Good', 'Espoo', 'Leppavaara', '02600', 60.2189, 24.8133, 'All original pieces, checked and counted.', NULL);
