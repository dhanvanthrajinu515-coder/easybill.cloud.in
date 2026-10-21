PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS shops (
  id TEXT PRIMARY KEY,
  shop_name TEXT NOT NULL,
  owner_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  gstin TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','customer')),
  shop_id TEXT REFERENCES shops(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sku TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',
  price REAL NOT NULL DEFAULT 0,
  stock REAL NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT 'piece',
  gst REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(shop_id, sku)
);
CREATE TABLE IF NOT EXISTS bills (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  invoice_no TEXT NOT NULL,
  customer_name TEXT NOT NULL DEFAULT 'Walk-in customer',
  customer_phone TEXT NOT NULL DEFAULT '',
  payment_method TEXT NOT NULL DEFAULT 'Cash',
  subtotal REAL NOT NULL,
  gst_total REAL NOT NULL,
  total REAL NOT NULL,
  snapshot_shop_name TEXT NOT NULL,
  snapshot_address TEXT NOT NULL DEFAULT '',
  snapshot_phone TEXT NOT NULL DEFAULT '',
  snapshot_gstin TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(shop_id, invoice_no)
);
CREATE TABLE IF NOT EXISTS bill_items (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  product_id TEXT,
  product_name TEXT NOT NULL,
  sku TEXT NOT NULL DEFAULT '',
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  unit_price REAL NOT NULL,
  gst_rate REAL NOT NULL DEFAULT 0,
  line_total REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_shop ON products(shop_id);
CREATE INDEX IF NOT EXISTS idx_bills_shop_date ON bills(shop_id, created_at);
CREATE INDEX IF NOT EXISTS idx_items_bill ON bill_items(bill_id);

CREATE TABLE IF NOT EXISTS app_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customer_accounts (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  balance REAL NOT NULL DEFAULT 0 CHECK(balance >= 0),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_customer_accounts_shop ON customer_accounts(shop_id, name);
