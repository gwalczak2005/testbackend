const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();



// --- DATENBANK INITIALISIERUNG & SCHEMA ---
const dbPath = path.resolve(__dirname, '..', 'sensor_data.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error("Fehler beim Öffnen der DB:", err.message);
    } else {
        console.log("✅ SQLite-Datenbank verbunden.");
    }
});

db.serialize(() => {
    // 1. Die Log-Tabelle (Rohdaten) 
    db.run(`CREATE TABLE IF NOT EXISTS sensor_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sensor_id TEXT,
        temp REAL,
        humidity REAL,
        lat REAL,           -- NEU: Breitengrad
        lon REAL,           -- NEU: Längengrad
        is_alarm INTEGER DEFAULT 0,
        sync_status TEXT DEFAULT 'SYNCED',
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 2. Mapping-Tabelle
        db.run(`CREATE TABLE IF NOT EXISTS hardware_mappings (
        sensor_id TEXT PRIMARY KEY,
        supplier_name TEXT,
        delivery_id TEXT,
        is_active INTEGER DEFAULT 1,
        status TEXT DEFAULT 'IN_TRANSIT',
        max_temp REAL DEFAULT 30.0,
        min_temp REAL DEFAULT 2.0,
        max_hum REAL DEFAULT 60.0,
        min_hum REAL DEFAULT 20.0,
        reading_count INTEGER DEFAULT 0
    )`);

    // 3. User-Tabelle & Default-Admin
    db.run(`CREATE TABLE IF NOT EXISTS api_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key TEXT UNIQUE,
        role TEXT,  -- 'ADMIN' oder 'SUPPLIER'
        owner TEXT  -- Name des Großunternehmens oder des Lieferanten
    )`, (err) => {
        if (!err) {
            // Legt den Master-Admin automatisch an, falls er noch nicht existiert
            const insertAdmin = `INSERT OR IGNORE INTO api_users (api_key, role, owner) 
                                VALUES (?, ?, ?)`;
            db.run(insertAdmin, ['MASTER_ADMIN_2026', 'ADMIN', 'Großunternehmen AG'], (err) => {
                if (err) console.error("❌ Fehler beim Anlegen des Default-Admins:", err.message);
                else console.log("✅ Default-Admin 'MASTER_ADMIN_2026' ist einsatzbereit.");
            });

            // Optional: Einen Test-Supplier anlegen für das Supplier-Dashboard
            db.run(insertAdmin, ['SUPPLIER_A_KEY', 'SUPPLIER', 'Supplier_A']);
        }
    });

    // 4. Delivery Reports Tabelle
    db.run(`CREATE TABLE IF NOT EXISTS delivery_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_id TEXT UNIQUE,
    pdf_path TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    integrity_status TEXT
    )`);
    console.log("DB-Schema initialisiert")
});

module.exports = { 
    db 
};