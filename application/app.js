const express = require('express');
const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

let gateway;
let contract;
let client; //gRPC Client global halten, um bei Bedarf zu schließen

const app = express();
app.use(express.json());

// --- VARIABLEN & PFADE ---
let messageCounter = 0;
const port = 3000;

const walletPath = path.resolve(__dirname, 'wallet', 'org1-admin');
const certPath = path.join(walletPath, 'msp', 'signcerts', 'cert.pem');
const keyDirectoryPath = path.join(walletPath, 'msp', 'keystore');
const tlsCertPath = path.join(walletPath, 'tls', 'ca.crt');

//Schlüssel-Datenbank 
const API_KEYS = {
    "MASTER_ADMIN_2026": { role: "ADMIN", owner: "Großunternehmen" },
    "KEY_SUPPLIER_A": { role: "SUPPLIER", owner: "Supplier_A" }
};

const supplierAuth = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    const user = API_KEYS[apiKey];
    const requestedSupplier = req.params.supplier;

    // 1. Key-Check
    if (!user) {
        return res.status(401).json({ error: "Ungültiger Key." });
    }

    // 2. Berechtigungs-Check (Admin darf alles | Supplier nur sein eigenes)
    if (user.role === "ADMIN" || (user.role === "SUPPLIER" && user.owner === requestedSupplier)) {
        req.user = user;
        return next(); // Alles okay, weiter zur Route
    }

    // 3. Zugriff verweigert (Logging & Error)
    console.warn(`🔒 ALARM: ${user.owner} wollte unbefugt auf Daten von [${requestedSupplier}] zugreifen!`);
    return res.status(403).json({ 
        error: "Zugriff verweigert", 
        message: "Du darfst nur deine eigenen Lieferungen sehen." 
    });
};

// --- DATENBANK INITIALISIERUNG ---
const dbPath = path.resolve(__dirname, 'sensor_data.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error("Fehler beim Öffnen der DB:", err.message);
    else {
        console.log("✅ SQLite-Datenbank verbunden.");
        db.run(`CREATE TABLE IF NOT EXISTS sensor_logs (
            id TEXT, temp REAL, humidity REAL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
    }
});

// --- DATENBANK ERWEITERUNG ---
db.serialize(() => {
    // 1. Deine bestehende Log-Tabelle (Rohdaten)
    db.run(`CREATE TABLE IF NOT EXISTS sensor_logs (
        id TEXT, 
        temp REAL, 
        humidity REAL, 
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 2. Mapping-Tabelle für Onboarding (Zuweisung Sensor -> Fahrt)
    db.run(`CREATE TABLE IF NOT EXISTS hardware_mappings (
        sensor_id TEXT PRIMARY KEY,
        supplier_name TEXT,
        delivery_id TEXT,
        is_active INTEGER DEFAULT 1
    )`);

    // 3. NEU: Die User-Tabelle für API-Keys (Sicherheit & Mandanten)
    db.run(`CREATE TABLE IF NOT EXISTS api_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key TEXT UNIQUE,
        role TEXT,  -- 'ADMIN' oder 'SUPPLIER'
        owner TEXT  -- Name des Großunternehmens oder des Lieferanten
    )`);
});

// --- HYPERLEDGER FUNKTIONEN ---
async function initBlockchain() {
    try {
        // Falls bereits eine alte Verbindung besteht, sauber schließen
        if (gateway) gateway.close();
        if (client) client.close();

        const tlsRootCert = fs.readFileSync(tlsCertPath);
        client = new grpc.Client('localhost:7051', grpc.credentials.createSsl(tlsRootCert), {
            'grpc.keepalive_time_ms': 120000,
            'grpc.http2.min_time_between_pings_ms': 120000,
        });

        const files = fs.readdirSync(keyDirectoryPath);
        const keyFile = files.find(file => file.endsWith('_sk'));
        const privateKeyPem = fs.readFileSync(path.join(keyDirectoryPath, keyFile));

        gateway = await connect({
            client,
            identity: { mspId: 'Org1MSP', credentials: fs.readFileSync(certPath) },
            signer: signers.newPrivateKeySigner(crypto.createPrivateKey(privateKeyPem)),
        });

        const network = gateway.getNetwork('mychannel');
        contract = network.getContract('basic');
        
        console.log("✅ Blockchain-Gateway initialisiert.");
    } catch (error) {
        console.error("❌ Kritischer Fehler bei Blockchain-Init:", error.message);
        contract = null; // Signalisiert anderen Funktionen, dass wir offline sind
    }
}

// Hilfsfunktion zum Senden an die Blockchain
async function sendToHyperledger(id, temp, humidity) {
    // 1. DYNAMISCHES MAPPING AUS DER DB HOLEN (Dein Promise-Block)
    const getMapping = () => {
        return new Promise((resolve, reject) => {
            db.get("SELECT supplier_name, delivery_id FROM hardware_mappings WHERE sensor_id = ? AND is_active = 1", [id], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });
    };

    try {
        const mapping = await getMapping();

        // --- DER GATEKEEPER-CHECK ---
        if (!mapping) {
            console.error(`\n⚠️  BLOCKCHAIN-STOPP: Sensor [${id}] ist NICHT AKTIV für eine Lieferung registriert!`);
            console.error(`👉 Grund: Entweder nie onboarded oder bereits ge-offboarded.`);
            return; // Hier stoppt die Funktion komplett. Nichts geht an die Blockchain.
        }

        // Wenn wir hier ankommen, haben wir ein gültiges mapping!
        const { supplier_name, delivery_id } = mapping;
        const timestampID = `${id}_${Date.now()}`;
        
        console.log(`\n🔗 BLOCKCHAIN: Sende validierte Daten für ${supplier_name} (${delivery_id})...`);

        // 2. BLOCKCHAIN GATEWAY CHECK
        if (!contract) {
            console.log("🔄 Verbindung zum Gateway wird neu aufgebaut...");
            await initBlockchain();
            if (!contract) {
                console.error("❌ Blockchain-Verbindung fehlgeschlagen. Daten werden verworfen.");
                return;
            }
        }

        // 3. TRANSAKTION AN DIE BLOCKCHAIN ÜBERMITTELN
        await contract.submitTransaction(
            'CreateAsset', 
            timestampID, 
            id, 
            temp.toString(), 
            humidity.toString(), 
            supplier_name, 
            delivery_id
        );
        
        console.log(`✅ Blockchain-Eintrag für ${delivery_id} erfolgreich gespeichert.`);

    } catch (error) {
        console.error("❌ Blockchain-Fehler in sendToHyperledger:", error.message);
        // Bei Verbindungsabbrüchen (gRPC 14) setzen wir den contract zurück
        if (error.message.includes('14') || error.message.includes('closed')) {
            contract = null;
        }
    }
}


//API-ROUTES

/// ==========================================
// 1. Developer Area (/api/dev)
// ==========================================

app.post('/test', (req, res) => {
    console.log("🎯 TEST-TREFFER!");
    res.send("Habe dich gehört!");
});

app.get('/api/dev/ping', (req, res) => res.send("PONG - Entwicklerzugang aktiv!"));

app.get('/api/dev/buffer-view', (req, res) => {
    db.all("SELECT * FROM sensor_logs ORDER BY timestamp DESC LIMIT 50", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get('/api/dev/debug-mappings', (req, res) => {
    db.all("SELECT * FROM hardware_mappings", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
}); // <--- Diese Klammern haben gefehlt!

// --- SENSOR DATA BUFFER (Die Schnittstelle für die Hardware) ---
app.post('/api/buffer', (req, res) => {
    const { id, temp, humidity } = req.body;

    db.run(`INSERT INTO sensor_logs (id, temp, humidity) VALUES (?, ?, ?)`, 
    [id, temp, humidity], function(err) {
        if (err) return res.status(500).json({ error: err.message });

        const logId = this.lastID; // Die fortlaufende Nummer des SQL-Eintrags

        db.get(`SELECT * FROM hardware_mappings WHERE sensor_id = ? AND is_active = 1`, [id], async (err, mapping) => {
            if (mapping) {
                
                // === HIER STEHT DIE LOGIK ===
                // % 2 === 0 bedeutet: Nur bei jedem zweiten Eintrag (2, 4, 6...)
                if (logId % 2 === 0) { 
                    try {
                        if (!contract) await initBlockchain();
                        
                        await contract.submitTransaction(
                            'CreateAsset',
                            `LOG-${logId}`,
                            id,
                            temp.toString(),
                            humidity.toString(),
                            mapping.supplier_name,
                            mapping.delivery_id
                        );
                        console.log(`🔗 Blockchain-Sync für ID ${logId} (Jeder 2. Wert)`);
                    } catch (bcErr) {
                        console.error("❌ Blockchain-Fehler:", bcErr.message);
                    }
                } else {
                    console.log(`📝 Nur SQL-Log für ID ${logId} (Überspringe Blockchain)`);
                }
                // ============================

            }
            res.json({ status: "Buffered", logId: logId });
        });
    });
});

// ==========================================
// 2. Admin Area (/api/admin)
// ==========================================

// 2.1 SENSOR ONBOARDING
app.post('/api/admin/onboard', supplierAuth, (req, res) => {
    console.log("📍 ONBOARDING ROUTE ERREICHT!");
    const { sensorId, supplier, delivery } = req.body;
    
    // Wir prüfen erst auf Konflikte
    db.get(`SELECT * FROM hardware_mappings WHERE (sensor_id = ? OR delivery_id = ?) AND is_active = 1`, 
    [sensorId, delivery], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (row) return res.status(409).json({ error: "Konflikt: Sensor oder Lieferung bereits aktiv." });

        db.run(`INSERT OR REPLACE INTO hardware_mappings (sensor_id, supplier_name, delivery_id, is_active) VALUES (?, ?, ?, 1)`,
        [sensorId, supplier, delivery], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: `Lieferung ${delivery} für ${supplier} gestartet.` });
        });
    });
});

// 2.2 SET LIMITS
app.post('/api/admin/set-limit/:supplier/:deliveryId', supplierAuth, async (req, res) => {
    const { supplier, deliveryId } = req.params;
    const { maxTemp, minTemp, maxHum, minHum } = req.body;
    try {
        if (!contract) await initBlockchain();
        await contract.submitTransaction('SetLimit', supplier, deliveryId, 
            maxTemp.toString(), minTemp.toString(), maxHum.toString(), minHum.toString());
        res.json({ message: "Grenzwerte gespeichert." });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// 2.3 AUDIT
app.get('/api/admin/audit/:supplier/:deliveryId', supplierAuth, async (req, res) => {
    const { supplier, deliveryId } = req.params;
    try {
        const mapping = await new Promise((resolve, reject) => {
            db.get("SELECT sensor_id FROM hardware_mappings WHERE supplier_name = ? AND delivery_id = ?", [supplier, deliveryId], (e, r) => e ? reject(e) : resolve(r));
        });
        if (!mapping) return res.status(404).json({ error: "Lieferung nicht gefunden." });

        const sqlLogs = await new Promise((resolve, reject) => {
            db.all("SELECT * FROM sensor_logs WHERE id = ?", [mapping.sensor_id], (e, r) => e ? reject(e) : resolve(r));
        });

        if (!contract) await initBlockchain();
        const bcResult = await contract.evaluateTransaction('GetAssetsByDelivery', supplier, deliveryId);
        const bcData = JSON.parse(Buffer.from(bcResult).toString('utf8'));

        const expected = Math.floor(sqlLogs.length / 2);
        const isConsistent = Math.abs(bcData.length - expected) <= 1;

        res.json({
            deliveryId, supplier,
            integrity: isConsistent ? "VERIFIED ✅" : "DISCREPANCY ❌",
            details: { sql: sqlLogs.length, blockchain: bcData.length, expected }
        });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// 2.5 PROOF-OF-DELIVERY
app.post('/api/admin/proof-of-delivery/:supplier/:deliveryId', supplierAuth, async (req, res) => {
    const { supplier, deliveryId } = req.params;
    const { recipientName } = req.body;
    try {
        if (!contract) await initBlockchain();
        await contract.submitTransaction('ConfirmDelivery', supplier, deliveryId, recipientName);
        db.run(`UPDATE hardware_mappings SET is_active = 0 WHERE delivery_id = ?`, [deliveryId], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ status: "Success", message: `Lieferung ${deliveryId} archiviert.` });
        });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// ==========================================
// 3. Supplier Area (/api/supplier)
// ==========================================

app.get('/api/supplier/:supplier/active', supplierAuth, (req, res) => {
    const { supplier } = req.params;
    db.all("SELECT delivery_id, sensor_id, timestamp FROM hardware_mappings WHERE supplier_name = ? AND is_active = 1", 
    [supplier], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ supplier, activeCount: rows.length, deliveries: rows });
    });
});

app.get('/api/supplier/:supplier/audit/:deliveryId', supplierAuth, async (req, res) => {
    const { supplier, deliveryId } = req.params;
    try {
        const mapping = await new Promise((resolve, reject) => {
            db.get("SELECT sensor_id FROM hardware_mappings WHERE supplier_name = ? AND delivery_id = ?", 
            [supplier, deliveryId], (err, row) => {
                if (err || !row) reject(new Error("Lieferung nicht gefunden."));
                resolve(row);
            });
        });
        if (!contract) await initBlockchain();
        const bcResult = await contract.evaluateTransaction('GetAssetsByDelivery', supplier, deliveryId);
        const bcData = JSON.parse(Buffer.from(bcResult).toString('utf8'));
        res.json({ deliveryId, status: "Audit erfolgreich", blockchainRecords: bcData.length });
    } catch (error) { res.status(404).json({ error: error.message }); }
});


// --- SERVER START ---
app.listen(port, '0.0.0.0', () => {
    console.log(`--- BACKEND LIVE auf Port ${port} ---`);
});