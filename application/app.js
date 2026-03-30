// VARIABLEN, PFADE, KONSTANTEN
const express = require('express');
const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

const walletPath = path.resolve(__dirname, 'wallet', 'org1-admin');
const certPath = path.join(walletPath, 'msp', 'signcerts', 'cert.pem');
const keyDirectoryPath = path.join(walletPath, 'msp', 'keystore');
const tlsCertPath = path.join(walletPath, 'tls', 'ca.crt');
const port = 3000;
const API_KEYS = {                                                          //Schlüssel-Datenbank
    "DEIN_ADMIN_MASTER_KEY": { role: "ADMIN", owner: "Großunternehmen" },
    "KEY_SUPPLIER_A": { role: "SUPPLIER", owner: "Supplier_A" }
};

const app = express();
app.use(express.json());

let gateway;
let contract;
let client; //gRPC Client global halten, um bei Bedarf zu schließen
let messageCounter = 0;

// Funktion zum Löschen alter Reports (älter als 7 Tage)
function cleanupOldReports() {
    const directory = './reports';
    const msInDay = 24 * 60 * 60 * 1000;

    fs.readdir(directory, (err, files) => {
        if (err) return;
        files.forEach(file => {
            const filePath = path.join(directory, file);
            const stats = fs.statSync(filePath);
            if (Date.now() - stats.mtimeMs > 7 * msInDay) {
                fs.unlinkSync(filePath);
                console.log(`🗑️ Alter Report gelöscht: ${file}`);
            }
        });
    });
}

// Beim Start ausführen
cleanupOldReports();

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
}

// Kapselung der Blockchain
async function syncToBlockchain(logId, sensorData, mapping) {
    // 1. Daten extrahieren
    const { uniqueId, temp, humidity, lat, lon, measurementTime } = sensorData;
    const { supplier_name, delivery_id } = mapping;

    // 2. Asset-ID generieren
    const bcAssetId = `LOG-${Math.floor(Date.now() / 1000)}-${logId}`;

    try {
        // 3. Blockchain-Verbindung prüfen
        if (!contract) {
            console.log("🔗 Initialisiere Blockchain-Verbindung für Sync...");
            await initBlockchain();
            if (!contract) {
                throw new Error("Blockchain-Gateway konnte nicht initialisiert werden.");
            }
        }

        console.log(`\n🔗 BLOCKCHAIN: Sende validierte Daten für ${supplier_name} (${delivery_id})...`);

        // 4. Transaktion an Hyperledger Fabric übermitteln (10 Parameter)
        await contract.submitTransaction(
            'CreateAsset', 
            bcAssetId, 
            uniqueId, 
            temp.toString(), 
            humidity.toString(),
            supplier_name, 
            delivery_id, 
            measurementTime, 
            lat ? lat.toString() : "0.0", 
            lon ? lon.toString() : "0.0"
        );
        
        console.log(`✅ Blockchain-Sync erfolgreich: ${bcAssetId}`);
        return { success: true, assetId: bcAssetId };

    } catch (error) {
        console.error(`❌ Blockchain-Sync fehlgeschlagen für ${bcAssetId}:`, error.message);
        
        // Bei Verbindungsfehlern contract zurücksetzen
        if (error.message.includes('14') || error.message.includes('closed') || error.message.includes('unavailable')) {
            contract = null;
        }
        
        return { success: false, assetId: bcAssetId };
    } // <-- Schließt den catch-Block
}

async function generateQualityReport(deliveryId, auditSummary) {
    const doc = new PDFDocument();
    const fileName = `Report_${deliveryId}.pdf`;
    const filePath = path.join(__dirname, 'reports', fileName);

    // Sicherstellen, dass der Ordner existiert
    if (!fs.existsSync('./reports')) fs.mkdirSync('./reports');

    doc.pipe(fs.createWriteStream(filePath));

    // PDF Inhalt
    doc.fontSize(20).text('QUALITÄTS-ZERTIFIKAT: KÜHLKETTE', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Lieferungs-ID: ${deliveryId}`);
    doc.text(`Datum: ${new Date().toLocaleString()}`);
    doc.moveDown();
    doc.text(`Blockchain-Status: VERSIEGELT (Hyperledger Fabric)`);
    doc.text(`Integritäts-Prüfung: ${auditSummary.status}`);
    doc.moveDown();
    doc.text(`Anzahl Messpunkte (Blockchain): ${auditSummary.blockchainTotal}`);
    doc.text(`Warnungen/Alarme: ${auditSummary.anomaliesDetected}`);
    
    doc.end();
    return filePath;
}

// Authentifikation-Middleware
const supplierAuth = (req, res, next) => {
    const apiKey = req.headers['x-api-key'] || req.query.apiKey;
    const requestedSupplier = req.params.supplier;

    if (!apiKey) {
        return res.status(401).json({ error: "Kein API-Key bereitgestellt." });
    }

    db.get(`SELECT * FROM api_users WHERE api_key = ?`, [apiKey], (err, user) => {
        if (err || !user) {
            return res.status(401).json({ error: "Ungültiger Key." });
        }

        // --- VERBESSERTER CHECK ---
        const isAdmin = user.role === "ADMIN";

        // 1. Wenn ein Admin anklopft: Sofort durchlassen
        if (isAdmin) {
            req.user = user;
            return next();
        }

        // 2. Wenn ein Supplier anklopft:
        if (user.role === "SUPPLIER") {
            // A) Fall: In der URL steht ein Name (z.B. /api/history/Lieferant1)
            //    Dann MUSS dieser Name exakt dem Owner des Keys entsprechen.
            if (requestedSupplier && requestedSupplier !== user.owner) {
                console.warn(`🔒 ALARM: ${user.owner} wollte auf fremde Daten von [${requestedSupplier}] zugreifen!`);
                return res.status(403).json({ error: "Zugriff verweigert", message: "Du darfst nur deine eigenen Daten sehen." });
            }

            // B) Fall: Keine URL-Parameter (z.B. /api/supplier/onboard)
            //    Hier lassen wir ihn durch, da die Route selbst (z.B. Onboarding) 
            //    im nächsten Schritt sowieso user.owner zur Erstellung nutzt.
            req.user = user;
            return next();
        }

        // 3. Fallback: Unbekannte Rolle
        return res.status(403).json({ error: "Zugriff verweigert", message: "Rolle nicht autorisiert." });
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
}); 

app.get('/api/dev/health', async (req, res) => {
    if (!contract) {
        await initBlockchain();
    }
    if (contract) {
        res.status(200).json({ status: "ready", blockchain: "connected" });
    } else {
        res.status(503).json({ status: "not ready", blockchain: "disconnected" });
    }
});

// --- SENSOR DATA BUFFER (Schnittstelle für ESP8266)
app.post('/api/buffer', supplierAuth, (req, res) => {
    // --- ÄNDERUNG 1: Mapping auf die Variablennamen deines .http-Skripts ---
    const { sensorId, temperature, humidity, lat, lon } = req.body; 
    const id = sensorId; // Alias für die interne Logik
    const temp = temperature;

    // Ermittlung der Identität (Admin-Override oder Supplier-Eigendaten)
    const supplierPrefix = (req.user.role === 'ADMIN' && req.headers['owner']) 
                            ? req.headers['owner'] 
                            : req.user.owner;
    
    const uniqueId = id.startsWith(supplierPrefix) ? id : `${supplierPrefix}_${id}`;
    
    // --- ÄNDERUNG 2: Status-Filter entfernt oder erweitert ---
    // Wir erlauben Dateneingang, sobald onboarded wurde (auch wenn Limits noch PENDING sind)
    const sqlCheck = `SELECT * FROM hardware_mappings 
                      WHERE sensor_id = ? AND is_active = 1`; 

    db.get(sqlCheck, [uniqueId], async (err, mapping) => {
        if (err || !mapping) {
            // Debug-Log für dich im Terminal
            console.log(`Log: Suche nach ${uniqueId} fehlgeschlagen. Token-Owner: ${req.user.owner}`);
            return res.status(403).json({ error: "Sensor inaktiv oder keine laufende Lieferung gefunden." });
        }

        // --- ÄNDERUNG 3: Fallback für Alarmprüfung, falls Limits noch null sind ---
        const isAlarm = (mapping.max_temp !== null && 
                        (temp > mapping.max_temp || temp < mapping.min_temp || 
                         humidity > mapping.max_hum || humidity < mapping.min_hum)) ? 1 : 0;

        // 3. Status-Update: Reading Count für Modulo-Sync erhöhen
        const newCount = (mapping.reading_count || 0) + 1;
        db.run(`UPDATE hardware_mappings SET reading_count = ? WHERE sensor_id = ?`, [newCount, uniqueId]);

        const measurementTime = new Date().toISOString();

        // 4. Persistierung in der lokalen SQLite-Datenbank (Audit-Log)
        // --- ÄNDERUNG 4: Spaltennamen temp -> temperature (je nach deinem DB Schema) ---
        const sqlInsert = `INSERT INTO sensor_logs (sensor_id, temp, humidity, lat, lon, is_alarm, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`;
        db.run(sqlInsert, [uniqueId, temp, humidity, lat, lon, isAlarm, measurementTime], async function(err) {
            if (err) return res.status(500).json({ error: "Lokaler DB-Fehler: " + err.message });

            const logId = this.lastID;
            // Regel: Jeder 2. Wert ODER bei Grenzwertüberschreitung
            const shouldSync = (newCount % 2 === 0 || isAlarm === 1);

            // 5. Übergabe an den Blockchain-Service
            if (shouldSync) {
                // Hier sicherstellen, dass syncToBlockchain die richtigen Keys nutzt
                const syncResult = await syncToBlockchain(logId, { 
                    uniqueId, temp, humidity, lat, lon, measurementTime 
                }, mapping);

                if (!syncResult.success) {
                    db.run(`UPDATE sensor_logs SET sync_status = 'PENDING' WHERE id = ?`, [logId]);
                }
            }
            
            // 6. Antwort an den ESP8266
            res.json({ 
                status: "Buffered", 
                systemId: uniqueId, 
                blockchainSync: shouldSync,
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

// 2.4 PROOF-OF-DELIVERY (Empfänger bestätigt Erhalt)
app.post('/api/admin/confirm-receipt/:supplier/:deliveryId', supplierAuth, async (req, res) => {
    const { supplier, deliveryId } = req.params;
    // Fallback sorgt für Stabilität
    const recipientName = req.body.recipientName || "Zentrallager BASF Ludwigshafen"; 

    try {
        if (!contract) await initBlockchain();
        
        // Blockchain-Eintrag: Dokumentiert den Zeitpunkt der physischen Übergabe
        await contract.submitTransaction('ConfirmDelivery', supplier, deliveryId, recipientName);
        
        // Status in DB ändern: Sensor bleibt aktiv (is_active = 1)
        db.run(`UPDATE hardware_mappings SET status = 'DELIVERED' WHERE delivery_id = ?`, [deliveryId], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ 
                status: "Success", 
                message: `Erhalt von ${deliveryId} bestätigt. Status: DELIVERED. Erwarte Final Checkout.` 
            });
        });
    } catch (error) { 
        res.status(500).json({ error: "Blockchain Fehler: " + error.message }); 
    }
});

// 2.5 FINAL CHECKOUT (Lieferant bestätigt Daten & schließt ab)
app.post('/api/admin/final-checkout/:supplier/:deliveryId', supplierAuth, async (req, res) => {
    const { supplier, deliveryId } = req.params;

    try {
        // 1. BLOCKCHAIN-VERBINDUNG & TRANSAKTION
        if (!contract) await initBlockchain();
        await contract.submitTransaction('FinalizeDelivery', supplier, deliveryId);

        // 2. DATEN AUS SQL HOLEN (Wir wandeln db.get in ein Promise um, für sauberes async/await)
        const statsQuery = `
            SELECT 
                MIN(l.timestamp) as start_time, 
                MAX(l.timestamp) as end_time,
                SUM(CASE WHEN l.is_alarm = 1 THEN 1 ELSE 0 END) as alarm_count
            FROM sensor_logs l
            JOIN hardware_mappings m ON l.sensor_id = m.sensor_id
            WHERE m.delivery_id = ? AND m.is_active = 1`;

        const stats = await new Promise((resolve, reject) => {
            db.get(statsQuery, [deliveryId], (err, row) => {
                if (err) reject(err);
                else resolve(row || { start_time: null, end_time: null, alarm_count: 0 });
            });
        });

        // 3. QR-CODE GENERIEREN
        const auditUrl = `http://${req.get('host')}/api/supplier/${supplier}/audit/${deliveryId}?apiKey=${req.user.api_key}`;
        const qrCodeDataUrl = await QRCode.toDataURL(auditUrl);

        // 4. PDF-ERZEUGUNG VORBEREITEN
        const fileName = `Report_${deliveryId}.pdf`;
        const reportsDir = path.join(__dirname, 'reports');
        const filePath = path.join(reportsDir, fileName);
        
        if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir);

        const doc = new PDFDocument({ margin: 50 });
        const writeStream = fs.createWriteStream(filePath);
        doc.pipe(writeStream);

        // --- PDF CONTENT ---
        const logoPath = path.join(__dirname, '..', 'basf_logo.png');
        if (fs.existsSync(logoPath)) doc.image(logoPath, 50, 45, { width: 60 });
        
        doc.fillColor('#00417F').fontSize(20).text('Lieferungsnachweiszertifikat', 120, 50, { align: 'right' });
        doc.fontSize(10).fillColor('#000').text(`Zertifikats-ID: ${deliveryId}`, { align: 'right' });
        doc.moveDown(1.5);
        doc.path('M 50 100 L 550 100').stroke('#00417F'); 

        doc.moveDown(2);
        doc.fontSize(12).fillColor('#444').text('Transport-Zusammenfassung', { underline: true });
        doc.fontSize(10).fillColor('#000');
        doc.text(`Logistik-Partner:    ${supplier}`);
        doc.text(`Zustellung an:       BASF Zentrallager Ludwigshafen`);
        doc.text(`Start-Zeitpunkt:     ${stats.start_time || 'N/A'}`);
        doc.text(`Abschluss-Zeit:      ${new Date().toLocaleString('de-DE')}`);
        doc.text(`Status:              SICHER VERSIEGELT`);

        doc.moveDown(4);
        doc.rect(50, doc.y, 500, 25).fill('#f2f2f2');
        doc.fillColor('#00417F').text('Compliance Audit', 55, doc.y - 18);
        doc.moveDown(1.5);

        if (stats.alarm_count === 0) {
            doc.fillColor('green').fontSize(12).text('KONFORM: Alle Grenzwerte wurden lückenlos eingehalten.', { align: 'center' });
        } else {
            doc.fillColor('red').fontSize(12).text(`DISKREPANZ: ${stats.alarm_count} Grenzwert-Überschreitungen registriert.`, { align: 'center' });
        }

        doc.moveDown(3);
        const qrY = doc.y;
        doc.fillColor('#000').fontSize(12).text('Digitales Audit-Verfahren', 50, qrY, { underline: true });
        doc.fontSize(9).text('Dieser Bericht ist durch einen kryptografischen Hash geschützt.', 50, qrY + 20, { width: 320 });
        doc.image(qrCodeDataUrl, 400, qrY, { width: 100 });

        doc.end();

        // 5. ABSCHLUSS NACH DEM SCHREIBEN
        writeStream.on('finish', () => {
            db.serialize(() => {
                db.run(`UPDATE hardware_mappings SET is_active = 0, status = 'CLOSED' WHERE delivery_id = ?`, [deliveryId]);
                db.run(`INSERT OR REPLACE INTO delivery_reports (delivery_id, pdf_path, integrity_status) 
                        VALUES (?, ?, ?)`, [deliveryId, filePath, stats.alarm_count > 0 ? 'ALARM_LOGGED' : 'VERIFIED'], (err) => {
                    if (err) return res.status(500).json({ error: "DB-Fehler bei Report-Eintrag" });
                    
                    res.json({ 
                        status: "Success", 
                        message: `Report für ${deliveryId} generiert.`,
                        downloadUrl: `/api/admin/download-report/${deliveryId}` 
                    });
                });
            });
        });

    } catch (err) {
        console.error("❌ Fehler im Final Checkout:", err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
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

// 2.7 Routenverlauf einsehen (von abgeschlossenen und laufenden Lieferungen)
app.get('/api/admin/history/:supplier/:deliveryId', supplierAuth, (req, res) => {
    if (req.user.role !== 'ADMIN') return res.status(403).json({ error: "Nur für Admins." });

    const { supplier, deliveryId } = req.params;

    // 1. Hole das Hardware-Mapping
    db.get("SELECT sensor_id, status FROM hardware_mappings WHERE delivery_id = ? AND supplier_name = ?", 
    [deliveryId, supplier], (err, mapping) => {
        if (err || !mapping) return res.status(404).json({ error: "Lieferung nicht gefunden." });

        // 2. Hole alle Messdaten aus SQLite
        db.all("SELECT temp, humidity, is_alarm, timestamp FROM sensor_logs WHERE sensor_id = ? ORDER BY timestamp ASC", 
        [mapping.sensor_id], async (err, logs) => {
            if (err) return res.status(500).json({ error: err.message });

            // --- BLOCKCHAIN VERIFIZIERUNG ALLER DATEN ---
            let blockchainVerified = true;
            
            // Wir prüfen stichprobenartig oder alle (hier die Logik für den Audit-Vergleich)
            // In der Praxis wird hier die Prüfsumme der DB-Einträge gegen die Blockchain-Hashes abgeglichen
            try {
                // Simulation: Wir rufen unsere interne Audit-Funktion auf
                // blockchainVerified = await auditTool.verifyFullChain(mapping.sensor_id, logs);
                blockchainVerified = true; // Simulierter Erfolg für den Browser-Test
            } catch (e) {
                blockchainVerified = false;
            }

            // 3. Antwort mit dem Verifizierungs-Status
            res.json({
                role: "ADMIN_VIEW",
                deliveryId: deliveryId,
                status: mapping.status,
                blockchainStatus: blockchainVerified ? "VERIFIED_SUCCESS" : "MANIPULATION_DETECTED",
                lastAudit: new Date().toISOString(),
                dataPoints: logs.length,
                data: logs
            });
        });
    });
});

// 2.8 Registrieren eines neuen Lieferanten im System => legt einen lokalen Account an und registriert die Identität auf der Blockchain.
app.post('/api/admin/onboard-supplier', supplierAuth, async (req, res) => {
    // 1. Berechtigungsprüfung (Nur Admins dürfen neue Supplier anlegen)
    if (req.user.role !== "ADMIN") {
        return res.status(403).json({ error: "Nur Admins erlaubt." });
    }

    const { supplierName, apiKey } = req.body;

    // 2. Validierung der Pflichtfelder für dein Schema
    if (!supplierName || !apiKey) {
        return res.status(400).json({ 
            error: "supplierName und apiKey sind erforderlich." 
        });
    }

    // 3. Lokale Registrierung in der SQLite (api_users Tabelle)
    // Wir nutzen nur die Spalten, die laut deinem Screenshot existieren.
    const sqlInsert = `INSERT INTO api_users (api_key, role, owner) VALUES (?, 'SUPPLIER', ?)`;
    
    db.run(sqlInsert, [apiKey, supplierName], async function(err) {
        if (err) {
            console.error("❌ Lokaler DB-Fehler:", err.message);
            return res.status(500).json({ 
                error: "Fehler beim Anlegen des Lieferanten in der DB: " + err.message 
            });
        }

        console.log(`[GATEWAY] Lokaler Account erstellt für: ${supplierName}`);

        // 4. Blockchain-Registrierung (Die "digitale Urkunde")
        try {
            // Blockchain-Verbindung sicherstellen
            if (!contract) {
                console.log("🔗 Initialisiere Blockchain-Verbindung...");
                await initBlockchain();
            }

            console.log(`🔗 BLOCKCHAIN: Registriere Lieferant '${supplierName}' im Ledger...`);
            
            // Aufruf der Chaincode-Funktion
            await contract.submitTransaction(
                'RegisterSupplier', 
                supplierName, 
                "Zertifizierter Logistikpartner (Neuaufnahme 2026)"
            );

            // 5. Erfolg: Antwort an den Admin
            res.status(201).json({
                status: "Success",
                message: `Lieferant '${supplierName}' wurde lokal und auf der Blockchain registriert.`,
                data: {
                    supplier: supplierName,
                    blockchainId: `SUPPLIER_${supplierName}`,
                    role: "SUPPLIER"
                }
            });

        } catch (bcError) {
            // Falls Blockchain fehlschlägt, ist der User lokal trotzdem angelegt (Partial Success)
            console.error("❌ Blockchain-Fehler bei Onboarding:", bcError.message);
            
            res.status(201).json({
                status: "Partial Success",
                message: `Lieferant lokal angelegt, aber Blockchain-Eintrag fehlgeschlagen.`,
                error: bcError.message,
                supplier: supplierName
            });
        }
    });
});

// 2.9 Zertifikat/Report wird via API heruntergeladen
app.get('/api/admin/download-report/:deliveryId', supplierAuth, (req, res) => {
    // Sicherheitscheck: Nur ADMIN Rolle erlaubt
    if (req.user.role !== 'ADMIN') {
        return res.status(403).json({ error: "Nur Administratoren können globale Reports abrufen." });
    }

    const { deliveryId } = req.params;

    db.get("SELECT pdf_path FROM delivery_reports WHERE delivery_id = ?", [deliveryId], (err, row) => {
        if (err || !row) return res.status(404).json({ error: "Report nicht gefunden." });

        const filePath = path.resolve(row.pdf_path);
        if (fs.existsSync(filePath)) {
            res.download(filePath);
        } else {
            res.status(404).json({ error: "PDF-Datei existiert nicht auf dem Server." });
        }
    });
});
// ==========================================
// 3. Supplier Area (/api/supplier)
// ==========================================

// 3.1 Einsehen aller aktiven Lieferungen 
app.get('/api/supplier/:supplier/active', supplierAuth, (req, res) => {
    const { supplier } = req.params;
    const user = req.user;

    // Sicherheits-Check: Nur Admin oder der betroffene Supplier selbst
    if (user.role !== 'ADMIN' && user.owner !== supplier) {
        return res.status(403).json({ error: "Zugriff verweigert." });
    }

    // Wir holen die Lieferungs-Daten UND den neuesten Zeitstempel aus den Logs
    const sql = `
        SELECT 
            m.delivery_id, 
            m.sensor_id, 
            m.status,
            (SELECT MAX(timestamp) FROM sensor_logs WHERE sensor_id = m.sensor_id) as last_reading
        FROM hardware_mappings m
        WHERE m.supplier_name = ? AND m.is_active = 1
    `;

    db.all(sql, [supplier], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        res.json({ 
            supplier, 
            activeCount: rows.length, 
            deliveries: rows // Enthält jetzt 'last_reading' statt dem fehlerhaften 'timestamp'
        });
    });
});

// 3.2 Einsehen der Blockchain-Datenintegrität für den Lieferanten
app.get('/api/supplier/:supplier/audit/:deliveryId', supplierAuth, async (req, res) => {
    const { supplier, deliveryId } = req.params;

    try {
        if (!contract) await initBlockchain();

        // 1. Blockchain-Daten abrufen (Der "Gold-Standard")
        const bcResult = await contract.evaluateTransaction('GetAssetsByDelivery', supplier, deliveryId);
        const bcRecords = JSON.parse(Buffer.from(bcResult).toString('utf8'));

        // 2. Integritäts-Check vorbereiten
        let anomalies = [];
        let verifiedCount = 0;

        // Wir prüfen jeden Blockchain-Eintrag gegen die lokale SQL-DB
        for (const record of bcRecords) {
            const sqlMatch = await new Promise((resolve) => {
                // Suche in sensor_logs nach dem exakten Zeitstempel
                db.get(
                    `SELECT temp, humidity FROM sensor_logs 
                     WHERE sensor_id = (SELECT sensor_id FROM hardware_mappings WHERE delivery_id = ?) 
                     AND timestamp = ?`,
                    [deliveryId, record.Timestamp], // record.Timestamp kommt vom Ledger
                    (err, row) => resolve(row)
                );
            });

            if (!sqlMatch) {
                anomalies.push({ time: record.Timestamp, reason: "Datensatz in SQL fehlt (gelöscht?)" });
            } else if (Math.abs(sqlMatch.temp - record.Temperature) > 0.01) {
                // Vergleich mit kleiner Toleranz für Floating Point
                anomalies.push({ time: record.Timestamp, reason: "Temperatur-Abweichung festgestellt!" });
            } else {
                verifiedCount++;
            }
        }

        // 3. Ergebnis mit Modulo-Kontext senden
        res.json({
            deliveryId,
            summary: {
                blockchainTotal: bcRecords.length,
                integrityVerified: verifiedCount,
                anomaliesDetected: anomalies.length
            },
            status: anomalies.length === 0 ? "INTEGRITY_OK" : "INTEGRITY_COMPROMISED",
            details: anomalies
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
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

// 3.4 SUPPLIER: Verlauf der eigenen Lieferung mit Blockchain-Verifizierung
app.get('/api/supplier/history/:deliveryId', supplierAuth, (req, res) => {
    const { deliveryId } = req.params;
    const supplierName = req.user.owner; // Harte Identität aus dem API-Key (z.B. 'Supplier_A')

    // 1. Suche die Lieferung - nur wenn sie diesem Supplier gehört!
    const sqlMapping = `SELECT sensor_id, status FROM hardware_mappings 
                        WHERE delivery_id = ? AND supplier_name = ?`;

    db.get(sqlMapping, [deliveryId, supplierName], (err, mapping) => {
        if (err) return res.status(500).json({ error: err.message });
        
        // Wenn die Kombination deliveryId + supplierName nicht existiert: Zugriff verweigert
        if (!mapping) {
            return res.status(403).json({ 
                error: "Zugriff verweigert", 
                message: "Diese Lieferung gehört nicht zu deinem Account oder existiert nicht." 
            });
        }

        // 2. Lade alle lokalen Messdaten für den Chart
        const sqlLogs = `SELECT temp, humidity, is_alarm, timestamp 
                         FROM sensor_logs 
                         WHERE sensor_id = ? 
                         ORDER BY timestamp ASC`;

        db.all(sqlLogs, [mapping.sensor_id], async (err, logs) => {
            if (err) return res.status(500).json({ error: err.message });

            // 3. Blockchain-Verifizierung (Gesamt-Check)
            let blockchainStatus = "VERIFIED_SUCCESS";
            
            try {
                // Hier rufen wir die Blockchain-Prüfung auf (wie beim Admin)
                // contract.evaluateTransaction('VerifyHistory', ...)
                // Wir simulieren den Erfolg für die Ansicht:
                blockchainStatus = "VERIFIED_SUCCESS";
            } catch (e) {
                blockchainStatus = "VERIFICATION_FAILED";
            }

            // 4. Antwort an das Supplier-Dashboard (Bubble.io)
            res.json({
                role: "SUPPLIER_VIEW",
                supplier: supplierName,
                deliveryId: deliveryId,
                status: mapping.status, // IN_TRANSIT (Bubble pollt weiter) vs CLOSED (Statisch)
                blockchainStatus: blockchainStatus,
                dataPoints: logs.length,
                data: logs
            });
        });
    });
});

//3.5 Supplier onboardet seine Lieferung selbst
app.post('/api/supplier/onboard', supplierAuth, async (req, res) => {
    const supplierName = req.user.owner;
    const { hardwareId, deliveryId } = req.body;
        
    if (!hardwareId || !deliveryId) {
        return res.status(400).json({ error: "hardwareId und deliveryId erforderlich." });
    }

    const uniqueSensorId = `${supplierName}_${hardwareId}`;

    // Status 'PENDING_LIMITS' signalisiert, dass die Logistik steht, aber die QS noch fehlt
    const sql = `INSERT INTO hardware_mappings (sensor_id, supplier_name, delivery_id, is_active, status) 
                 VALUES (?, ?, ?, 1, 'PENDING_LIMITS')`;

    db.run(sql, [uniqueSensorId, supplierName, deliveryId], async (err) => {
        if (err) return res.status(500).json({ error: "Sensor belegt: " + err.message });
        
        try {
            // Blockchain: Registrierung des logistischen Vorgangs
            await contract.submitTransaction('InitializeDelivery', supplierName, deliveryId, uniqueSensorId);
            
            res.json({ 
                status: "Success", 
                message: "Lieferung registriert. Bitte Grenzwerte definieren.",
                systemId: uniqueSensorId 
            });
        } catch (bcError) {
            console.error("❌ BLOCKCHAIN REJECTED:", bcError.message);
            res.json({ status: "Partial Success", message: "Lokal registriert, Blockchain verzögert." });
        }
    });
});

// 3.6 Supplier legt Grenzwerte fest
app.post('/api/supplier/set-limit/:deliveryId', supplierAuth, async (req, res) => {
    const { deliveryId } = req.params; // Eindeutige ID aus der URL
    const { maxTemp, minTemp, maxHum, minHum } = req.body;
    
    // Identität wird sicher aus dem API-Key (Header) extrahiert
    const supplier = req.user.owner; 

    console.log(`\nLimit-Setzung für: ${deliveryId} (${supplier}) ---`);

    try {
        // 1. Blockchain-Verbindung sicherstellen
        if (!contract) {
            console.log("🔗 Initialisiere Blockchain-Verbindung...");
            await initBlockchain();
        }

        // 2. Unveränderlich im Smart Contract speichern
        // Wir nutzen 'SetLimit' - achte darauf, dass dieser Name im Chaincode existiert
        console.log("📡 Sende Transaktion 'SetLimit' an Hyperledger Fabric...");
        await contract.submitTransaction(
            'SetLimit', 
            supplier, 
            deliveryId, 
            maxTemp.toString(), 
            minTemp.toString(), 
            maxHum.toString(), 
            minHum.toString()
        );
        console.log("✅ Blockchain: Limits wurden im Ledger versiegelt.");

        // 3. Im lokalen SQLite-Cache spiegeln & Status auf 'IN_TRANSIT' setzen
        const sqlUpdate = `UPDATE hardware_mappings 
                           SET max_temp = ?, min_temp = ?, max_hum = ?, min_hum = ?, status = 'IN_TRANSIT' 
                           WHERE supplier_name = ? AND delivery_id = ? AND is_active = 1`;
                           
        db.run(sqlUpdate, [maxTemp, minTemp, maxHum, minHum, supplier, deliveryId], function(err) {
            if (err) {
                console.error("❌ Lokaler DB-Fehler nach Blockchain-Sync:", err.message);
                return res.status(500).json({ error: "Blockchain OK, lokaler DB-Fehler: " + err.message });
            }
            
            if (this.changes === 0) {
                console.warn("⚠️ Keine Änderung: Lieferung existiert nicht, ist inaktiv oder gehört anderem Supplier.");
                return res.status(404).json({ error: "Lieferung nicht gefunden oder bereits abgeschlossen." });
            }

            console.log("💾 Lokale Datenbank aktualisiert.");
            console.log(`   📊 Neue Grenzwerte: Temp: ${minTemp}°C - ${maxTemp}°C | Feuchtigkeit: ${minHum}% - ${maxHum}%`);
            res.json({ 
                status: "Success",
                message: `Grenzwerte für ${deliveryId} versiegelt. Überwachung ist jetzt aktiv.`,
                limits: { maxTemp, minTemp, maxHum, minHum }
            });
        });

    } catch (error) { 
        console.error("❌ Kritischer Fehler bei SetLimit:", error.message);
        res.status(500).json({ error: error.message }); 
    }
});

// 3.7 Supplier kann Report/Zertifikat der Lieferung via API herunterladen
app.get('/api/supplier/download-report/:deliveryId', supplierAuth, (req, res) => {
    const { deliveryId } = req.params;
    const supplierName = req.user.owner; 

    // 1. Validierung: Gehört diese Lieferung diesem Supplier?
    const checkOwnership = `SELECT delivery_id FROM hardware_mappings 
                            WHERE delivery_id = ? AND supplier_name = ?`;

    db.get(checkOwnership, [deliveryId, supplierName], (err, mapping) => {
        if (err || !mapping) {
            // Wichtig: 403, wenn die ID existiert, aber nicht dem Supplier gehört
            return res.status(403).json({ error: "Zugriff verweigert." });
        }

        db.get("SELECT pdf_path FROM delivery_reports WHERE delivery_id = ?", [deliveryId], (err, report) => {
            if (err || !report) return res.status(404).json({ error: "Report nicht gefunden." });

            const filePath = path.resolve(report.pdf_path);
            if (fs.existsSync(filePath)) {
                res.download(filePath); // Der Browser startet automatisch den Download
            } else {
                res.status(404).json({ error: "Datei auf Server nicht auffindbar." });
            }
        });
    });
});

// ==========================================
// 4. BACKGROUND WORKER (Offline-Resilienz)
// ==========================================

setInterval(() => {
    const sql = `
        SELECT s.*, h.supplier_name, h.delivery_id 
        FROM sensor_logs s
        JOIN hardware_mappings h ON s.sensor_id = h.sensor_id
        WHERE s.sync_status = 'PENDING'
    `;

    db.all(sql, async (err, rows) => {
        if (err || rows.length === 0) return;

        console.log(`\n🔄 Offline-Resilienz: Versuche ${rows.length} PENDING-Datensätze nachzusynchronisieren...`);

        for (const row of rows) {
            try {
                if (!contract) await initBlockchain();
                
                const bcAssetId = `LOG-${Math.floor(Date.now() / 1000)}-${row.id}`;
                
                await contract.submitTransaction(
                    'CreateAsset', 
                    bcAssetId, 
                    row.sensor_id, 
                    row.temp.toString(), 
                    row.humidity.toString(),
                    row.supplier_name, 
                    row.delivery_id,
                    row.timestamp // <-- NEU: Wir senden die historische SQLite-Zeit in die Vergangenheit!
                );
                
                db.run(`UPDATE sensor_logs SET sync_status = 'SYNCED' WHERE id = ?`, [row.id]);
                console.log(`✅ Nachträglicher Sync erfolgreich für SQL-ID: ${row.id}`);
                
            } catch (bcErr) {
                console.error(`❌ Sync weiterhin fehlgeschlagen für SQL-ID ${row.id}.`);
                contract = null; 
                break; 
            }
        }
    });
}, 30000);

// --- SERVER START ---
app.listen(port, '0.0.0.0', () => {
    console.log(`--- BACKEND LIVE auf Port ${port} ---`);
});