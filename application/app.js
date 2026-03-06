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
    // 1. Key aus Header ODER URL-Parameter (ADMIN_KEY oder apiKey) extrahieren
    const apiKey = req.headers['x-api-key'] || req.query.ADMIN_KEY || req.query.apiKey;
    const requestedSupplier = req.params.supplier;

    if (!apiKey) {
        return res.status(401).json({ error: "Kein API-Key bereitgestellt." });
    }

    // 2. In der Datenbank nach dem User suchen
    db.get(`SELECT * FROM api_users WHERE api_key = ?`, [apiKey], (err, user) => {
        if (err || !user) {
            return res.status(401).json({ error: "Ungültiger Key." });
        }

        // 3. Berechtigungs-Check
        // Admin darf alles ODER Supplier darf nur auf seine eigenen Daten (req.params.supplier) zugreifen
        const isAdmin = user.role === "ADMIN";
        const isOwner = user.owner === requestedSupplier;

        // Wenn kein spezifischer Supplier in der URL (z.B. bei /api/admin/alerts), 
        // lassen wir Admins einfach durch.
        if (isAdmin || (user.role === "SUPPLIER" && isOwner) || (!requestedSupplier && isAdmin)) {
            req.user = user; // Wichtig für die Routen (req.user.owner/role)
            return next();
        }

        // 4. Zugriff verweigert
        console.warn(`🔒 ALARM: ${user.owner} wollte unbefugt auf [${requestedSupplier}] zugreifen!`);
        return res.status(403).json({ 
            error: "Zugriff verweigert", 
            message: "Du darfst nur deine eigenen Daten sehen." 
        });
    });
};

// --- DATENBANK INITIALISIERUNG & SCHEMA ---
const dbPath = path.resolve(__dirname, 'sensor_data.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error("Fehler beim Öffnen der DB:", err.message);
    } else {
        console.log("✅ SQLite-Datenbank verbunden.");
    }
});

db.serialize(() => {
    // 1. Die Log-Tabelle (Rohdaten) - JETZT NUR NOCH EINMAL UND RICHTIG!
    db.run(`CREATE TABLE IF NOT EXISTS sensor_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sensor_id TEXT,
        temp REAL,
        humidity REAL,
        is_alarm INTEGER DEFAULT 0,
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

// --- SENSOR DATA BUFFER (Schnittstelle für ESP8266)
app.post('/api/buffer', supplierAuth, (req, res) => {
    const { id, temp, humidity } = req.body;
    
    // FIX: Wenn der Admin testet, darf er den Supplier via Header simulieren.
    // Wenn später der echte ESP8266 funkt, wird hart der Owner aus dem API-Key erzwungen.
    const supplierPrefix = (req.user.role === 'ADMIN' && req.headers['owner']) 
                            ? req.headers['owner'] 
                            : req.user.owner;
    
    const uniqueId = `${supplierPrefix}_${id}`; 

    // ... (ab hier bleibt der Code exakt gleich mit db.get)

    // 1. Dynamisches Mapping inkl. Limits holen
    db.get(`SELECT * FROM hardware_mappings WHERE sensor_id = ? AND is_active = 1 AND status = 'IN_TRANSIT'`, 
    [uniqueId], async (err, mapping) => {
        if (err || !mapping) {
            return res.status(403).json({ error: "Sensor inaktiv, Lieferung beendet oder nicht gefunden." });
        }

        // 2. Dynamische Alarm-Prüfung anhand der lieferungsspezifischen Limits
        let isAlarm = 0;
        if (temp > mapping.max_temp || temp < mapping.min_temp || 
            humidity > mapping.max_hum || humidity < mapping.min_hum) {
            isAlarm = 1;
        }

        // 3. Sensor-spezifischen Zähler erhöhen (Modulo-Bug Fix)
        const newCount = mapping.reading_count + 1;
        db.run(`UPDATE hardware_mappings SET reading_count = ? WHERE sensor_id = ?`, [newCount, uniqueId]);

        // 4. In SQLite speichern
        const sql = `INSERT INTO sensor_logs (sensor_id, temp, humidity, is_alarm) VALUES (?, ?, ?, ?)`;
        db.run(sql, [uniqueId, temp, humidity, isAlarm], async function(err) {
            if (err) return res.status(500).json({ error: err.message });

            const logId = this.lastID;
            const bcAssetId = `LOG-${Math.floor(Date.now() / 1000)}-${logId}`;

            // 5. Intelligenter Blockchain-Sync (Nur jeder 2. Wert des spezifischen Sensors ODER bei Alarm)
            if (newCount % 2 === 0 || isAlarm === 1) {
                try {
                    if (!contract) await initBlockchain();
                    await contract.submitTransaction(
                        'CreateAsset', bcAssetId, uniqueId, temp.toString(), humidity.toString(),
                        mapping.supplier_name, mapping.delivery_id
                    );
                    console.log(`✅ Blockchain-Sync: ${bcAssetId} | Alarm: ${isAlarm === 1}`);
                } catch (bcErr) {
                    console.error("❌ Blockchain-Fehler:", bcErr.message);
                    // HIER entsteht aktuell Datenverlust, wenn die Blockchain down ist.
                    // Das lösen wir gleich in Schritt 2.
                }
            }
            
            res.json({ 
                status: "Buffered", 
                systemId: uniqueId, 
                blockchainSync: (newCount % 2 === 0 || isAlarm === 1),
                isAlarm: (isAlarm === 1)
            });
        });
    });
});

// ==========================================
// 2. Admin Area (/api/admin)
// ==========================================

// 2.1 SENSOR ONBOARDING
app.post('/api/admin/onboard', supplierAuth, (req, res) => {
    const { hardwareId, supplierName, deliveryId } = req.body;

    // Erstelle die eindeutige System-ID
    const uniqueSensorId = `${supplierName}_${hardwareId}`;

    const sql = `INSERT INTO hardware_mappings (sensor_id, supplier_name, delivery_id, is_active, status) 
                 VALUES (?, ?, ?, 1, 'IN_TRANSIT')`;

    db.run(sql, [uniqueSensorId, supplierName, deliveryId], (err) => {
        if (err) return res.status(500).json({ error: "Sensor bereits belegt oder Fehler: " + err.message });
        res.json({ status: "Success", systemId: uniqueSensorId });
    });
});

// 2.2 SET LIMITS
app.post('/api/admin/set-limit/:supplier/:deliveryId', supplierAuth, async (req, res) => {
    const { supplier, deliveryId } = req.params;
    const { maxTemp, minTemp, maxHum, minHum } = req.body;
    
    try {
        if (!contract) await initBlockchain();
        
        // 1. Unveränderlich im Smart Contract speichern
        await contract.submitTransaction('SetLimit', supplier, deliveryId, 
            maxTemp.toString(), minTemp.toString(), maxHum.toString(), minHum.toString());
        
        // 2. Im lokalen SQLite-Cache spiegeln
        const sqlUpdate = `UPDATE hardware_mappings 
                           SET max_temp = ?, min_temp = ?, max_hum = ?, min_hum = ? 
                           WHERE supplier_name = ? AND delivery_id = ?`;
                           
        db.run(sqlUpdate, [maxTemp, minTemp, maxHum, minHum, supplier, deliveryId], (err) => {
            if (err) return res.status(500).json({ error: "Blockchain OK, lokaler DB-Fehler: " + err.message });
            res.json({ message: "Grenzwerte erfolgreich auf Blockchain und im lokalen System gespeichert." });
        });
    } catch (error) { 
        res.status(500).json({ error: error.message }); 
    }
});

// 2.3 DEEP-AUDIT (Vgl. der Blockchain-Daten mit der SQL)
app.get('/api/admin/audit/:supplier/:deliveryId', supplierAuth, async (req, res) => {
    const { supplier, deliveryId } = req.params;
    
    try {
        // 1. Sensor-ID der Lieferung ermitteln
        const mapping = await new Promise((resolve, reject) => {
            db.get("SELECT sensor_id FROM hardware_mappings WHERE supplier_name = ? AND delivery_id = ?", 
            [supplier, deliveryId], (e, r) => e ? reject(e) : resolve(r));
        });
        if (!mapping) return res.status(404).json({ error: "Lieferung nicht gefunden." });

        // 2. Alle lokalen Rohdaten aus SQLite laden
        const sqlLogs = await new Promise((resolve, reject) => {
            db.all("SELECT * FROM sensor_logs WHERE sensor_id = ?", [mapping.sensor_id], (e, r) => e ? reject(e) : resolve(r));
        });

        // Beschleunigung: SQLite-Daten in ein Dictionary (Map) packen, geordnet nach 'id'
        const localDataMap = {};
        sqlLogs.forEach(log => localDataMap[log.id] = log);

        // 3. Unveränderliche Daten aus der Blockchain laden
        if (!contract) await initBlockchain();
        const bcResult = await contract.evaluateTransaction('GetAssetsByDelivery', supplier, deliveryId);
        const bcData = JSON.parse(Buffer.from(bcResult).toString('utf8'));

        // 4. DER DEEP-CHECK LOGIK-KERN
        let isConsistent = true;
        const discrepancies = [];

        for (const bcRecord of bcData) {
            // Blockchain-ID splitten: LOG-1741251780-45 -> Teile: ["LOG", "1741251780", "45"]
            const idParts = bcRecord.ID.split('-');
            const sqlId = parseInt(idParts[2], 10); 

            const localRecord = localDataMap[sqlId];

            if (!localRecord) {
                // Fall A: Jemand hat den Datensatz in der SQLite-Datenbank GELÖSCHT!
                isConsistent = false;
                discrepancies.push({
                    id: bcRecord.ID,
                    issue: "Datensatz fehlt lokal (Gelöscht!)",
                    blockchain: { temp: bcRecord.Temperature, humidity: bcRecord.Humidity },
                    local: null
                });
            } else {
                // Fall B: Datensatz ist da. Wir prüfen auf nachträgliche MANIPULATION.
                // Kleine Toleranz (< 0.01) für eventuelle Float-Rundungsfehler in JavaScript
                const tempMatch = Math.abs(bcRecord.Temperature - localRecord.temp) < 0.01;
                const humMatch = Math.abs(bcRecord.Humidity - localRecord.humidity) < 0.01;

                if (!tempMatch || !humMatch) {
                    isConsistent = false;
                    discrepancies.push({
                        id: bcRecord.ID,
                        issue: "Lokale Daten wurden manipuliert!",
                        blockchain: { temp: bcRecord.Temperature, humidity: bcRecord.Humidity },
                        local: { temp: localRecord.temp, humidity: localRecord.humidity }
                    });
                }
            }
        }

        // 5. Ergebnis an das Dashboard senden
        res.json({
            deliveryId, 
            supplier,
            integrity: isConsistent ? "VERIFIED ✅" : "DISCREPANCY ❌",
            details: { 
                total_sql_logs: sqlLogs.length, 
                total_blockchain_logs: bcData.length,
                manipulations_found: discrepancies.length
            },
            discrepancies: discrepancies, // Listet genau auf, WO betrogen wurde
            history: bcData // Lückenlose Historie für die Graphen im Frontend
        });

    } catch (error) { 
        res.status(500).json({ error: error.message }); 
    }
});

// 2.5 PROOF-OF-DELIVERY (Empfänger bestätigt Erhalt)
app.post('/api/admin/confirm-receipt/:supplier/:deliveryId', supplierAuth, async (req, res) => {
    const { supplier, deliveryId } = req.params;
    const { recipientName } = req.body; // Das Großunternehmen

    try {
        if (!contract) await initBlockchain();
        
        // 1. Unveränderlicher Eintrag auf der Blockchain
        await contract.submitTransaction('ConfirmDelivery', supplier, deliveryId, recipientName);
        
        // 2. SQL Status ändern, aber NOCH NICHT deaktivieren
        db.run(`UPDATE hardware_mappings SET status = 'DELIVERED' WHERE delivery_id = ?`, [deliveryId], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ 
                status: "Success", 
                message: `Erhalt von ${deliveryId} durch ${recipientName} bestätigt. Warte auf Checkout durch Lieferant.` 
            });
        });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// 2.5 PROOF-OF-DELIVERY (Empfänger bestätigt Erhalt)
app.post('/api/admin/confirm-receipt/:supplier/:deliveryId', supplierAuth, async (req, res) => {
    const { supplier, deliveryId } = req.params;
    const recipientName = "Großunternehmen AG"; // Festgelegt für Phase 1

    try {
        if (!contract) await initBlockchain();
        // Blockchain-Beweis
        await contract.submitTransaction('ConfirmDelivery', supplier, deliveryId, recipientName);
        
        // SQL-Update: Status ändern
        db.run(`UPDATE hardware_mappings SET status = 'DELIVERED' WHERE delivery_id = ?`, [deliveryId], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ status: "Success", message: "Erhalt bestätigt. Status: DELIVERED" });
        });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// 2.5b FINAL CHECKOUT (Lieferant bestätigt Daten & schließt ab)
app.post('/api/admin/final-checkout/:supplier/:deliveryId', supplierAuth, async (req, res) => {
    const { supplier, deliveryId } = req.params;

    try {
        // Hier könnte man noch eine Blockchain-Transaktion 'FinalizeDelivery' hinzufügen, 
        // falls im Smart Contract vorgesehen.
        
        // Jetzt erst wird die Lieferung für das "Live-System" unsichtbar (is_active = 0)
        db.run(`UPDATE hardware_mappings SET is_active = 0, status = 'CLOSED' WHERE delivery_id = ?`, [deliveryId], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ status: "Success", message: `Lieferung ${deliveryId} vollständig abgeschlossen und archiviert.` });
        });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// 2.6 ALARM-DASHBOARD (Nur Warnungen abrufen)
app.get('/api/admin/alerts', supplierAuth, async (req, res) => {
    if (req.user.role !== 'ADMIN') return res.status(403).json({ error: "Nur für Admins" });
    try {
        if (!contract) await initBlockchain();
        // Nutzt die Chaincode-Funktion für den Gesamtüberblick
        const result = await contract.evaluateTransaction('GetAllAssets');
        const allData = JSON.parse(Buffer.from(result).toString('utf8'));
        
        const alerts = allData.filter(asset => asset.IsWarning === true);
        res.json({ count: alerts.length, alerts });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// ==========================================
// 3. Supplier Area (/api/supplier)
// ==========================================

// 3.1 Einsehen aller aktiven Lieferungen
app.get('/api/supplier/:supplier/active', supplierAuth, (req, res) => {
    const { supplier } = req.params;
    db.all("SELECT delivery_id, sensor_id, timestamp FROM hardware_mappings WHERE supplier_name = ? AND is_active = 1", 
    [supplier], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ supplier, activeCount: rows.length, deliveries: rows });
    });
});

// 3.2 Einsehen der Blockchain-Datenintegrität für den Lieferanten
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

// 3.3 Einsehen aller Alarme für den Lieferanten
app.get('/api/supplier/alerts', supplierAuth, async (req, res) => {
    // Wir nehmen den Namen des Lieferanten direkt aus seinem authentifizierten API-Key
    const supplierName = req.user.owner; 

    try {
        if (!contract) await initBlockchain();

        // NUTZT DIE SPEZIFISCHE CHAINCODE-LOGIK:
        // GetAssetsBySupplier(ctx, supplierName)
        const result = await contract.evaluateTransaction('GetAssetsBySupplier', supplierName);
        const myAssets = JSON.parse(Buffer.from(result).toString('utf8'));
        
        // Filtert nur die Warnungen aus SEINEN Assets
        const myAlerts = myAssets.filter(asset => asset.IsWarning === true);
        
        res.json({
            supplier: supplierName,
            count: myAlerts.length,
            alerts: myAlerts
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


// --- SERVER START ---
app.listen(port, '0.0.0.0', () => {
    console.log(`--- BACKEND LIVE auf Port ${port} ---`);
});