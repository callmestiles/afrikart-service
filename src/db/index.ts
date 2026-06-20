import Database from "better-sqlite3";
import path from "path";
import { config } from "../config";

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(config.dbPath);

    // Enable WAL mode for better concurrent read performance
    // WAL = Write-Ahead Logging: readers don't block writers, writers don't block readers
    db.pragma("journal_mode = WAL");

    // Enforce foreign key constraints since SQLite disables these by default
    db.pragma("foreign_keys = ON");

    runMigrations(db);
  }

  return db;
}

function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id                  TEXT PRIMARY KEY,
      reference           TEXT NOT NULL UNIQUE,
      order_id            TEXT NOT NULL,
      payment_id          TEXT,
      status              TEXT NOT NULL DEFAULT 'pending',
      amount              REAL NOT NULL,
      currency            TEXT NOT NULL DEFAULT 'NGN',
      customer_name       TEXT NOT NULL,
      customer_email      TEXT NOT NULL,
      attempt_count       INTEGER NOT NULL DEFAULT 1,
      payout_reference    TEXT,
      payout_id           TEXT,
      metadata            TEXT NOT NULL DEFAULT '{}',
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_orders_order_id
      ON orders(order_id);

    CREATE INDEX IF NOT EXISTS idx_orders_status
      ON orders(status);

    CREATE TABLE IF NOT EXISTS order_events (
      id          TEXT PRIMARY KEY,
      order_id    TEXT NOT NULL REFERENCES orders(id),
      event       TEXT NOT NULL,
      detail      TEXT NOT NULL,
      metadata    TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_order_events_order_id
      ON order_events(order_id);

    CREATE TABLE IF NOT EXISTS processed_webhooks (
      event_id        TEXT PRIMARY KEY,
      event_type      TEXT NOT NULL,
      order_reference TEXT,
      processed_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payouts (
      id                    TEXT PRIMARY KEY,
      order_id              TEXT NOT NULL REFERENCES orders(id),
      customer_reference    TEXT NOT NULL UNIQUE,
      fincra_reference      TEXT,
      fincra_payout_id      TEXT,
      recipient_name        TEXT NOT NULL,
      recipient_account     TEXT NOT NULL,
      recipient_bank_code   TEXT NOT NULL,
      amount                REAL NOT NULL,
      source_currency       TEXT NOT NULL,
      destination_currency  TEXT NOT NULL,
      status                TEXT NOT NULL DEFAULT 'pending',
      failure_reason        TEXT,
      idempotency_key       TEXT NOT NULL UNIQUE,
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_payouts_order_id
      ON payouts(order_id);

    CREATE INDEX IF NOT EXISTS idx_payouts_status
      ON payouts(status);

    CREATE INDEX IF NOT EXISTS idx_payouts_fincra_reference
      ON payouts(fincra_reference);
    
  `);

  console.log("✅ Database migrations complete");
}
