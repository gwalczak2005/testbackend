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

// --- DATENBANK ERWEITERUNG --- (für Onboarding-Prozess)
db.serialize(() => {
    // Deine bestehende Log-Tabelle
    db.run(`CREATE TABLE IF NOT EXISTS sensor_logs (
        id TEXT, temp REAL, humidity REAL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // NEU: Mapping-Tabelle für Onboarding
    db.run(`CREATE TABLE IF NOT EXISTS hardware_mappings (
        sensor_id TEXT PRIMARY KEY,
        supplier_name TEXT,
        delivery_id TEXT,
        is_active INTEGER DEFAULT 1
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

// --- API ROUTES ---
    //GETTER

app.get('/ping', (req, res) => res.send("PONG - Backend ist erreichbar!"));

app.get('/api/buffer/view', (req, res) => {
    db.all("SELECT * FROM sensor_logs ORDER BY timestamp DESC LIMIT 20", [], (err, rows) => {
        if (err) return res.status(500).send(err.message);
        res.status(200).json(rows);
    });
});
// NEU: Alle Blockchain-Einträge abrufen
app.get('/api/blockchain/all', async (req, res) => {
    try {
        if (!contract) await initBlockchain();
        
        console.log("📡 Rufe vollständige Blockchain-Historie ab...");
        const resultBytes = await contract.evaluateTransaction('GetAllAssets');
        const resultJson = JSON.parse(Buffer.from(resultBytes).toString());
        
        // Schön sortiert nach Zeitstempel (neueste zuerst)
        const sortedResults = resultJson.sort((a, b) => new Date(b.Timestamp) - new Date(a.Timestamp));
        
        res.status(200).json(sortedResults);
    } catch (error) {
        res.status(500).json({ status: "Error", message: error.message });
    }
});

// NEU: Nur kritische Warnungen abrufen
app.get('/api/blockchain/warnings', async (req, res) => {
    try {
        if (!contract) await initBlockchain();
        
        const resultBytes = await contract.evaluateTransaction('GetAllAssets');
        const allAssets = JSON.parse(Buffer.from(resultBytes).toString());
        
        // Filtert nur die Einträge mit Warnung
        const warnings = allAssets.filter(asset => asset.IsWarning === true);
        
        console.log(`⚠️  ${warnings.length} Warnungen in der Blockchain gefunden!`);
        res.status(200).json(warnings);
    } catch (error) {
        res.status(500).json({ status: "Error", message: error.message });
    }
});

// --- NEU: Abfrage aller Daten eines bestimmten Lieferanten ---
app.get('/api/blockchain/supplier/:name', async (req, res) => {
    const supplierName = req.params.name;
    
    try {
        if (!contract) await initBlockchain();
        
        const resultBuffer = await contract.evaluateTransaction('GetAssetsBySupplier', supplierName);
        let resultString = resultBuffer.toString().trim();

        // PRÜFUNG: Ist es eine Liste von ASCII-Zahlen? (z.B. "91,123...")
        if (resultString && !resultString.startsWith('[') && !resultString.startsWith('{')) {
            console.log("⚠️ ASCII-Format erkannt, konvertiere...");
            const charArray = resultString.split(',').map(Number);
            resultString = String.fromCharCode(...charArray);
        }

        console.log(`🔍 Konvertiertes Resultat: ${resultString.substring(0, 50)}...`);

        if (!resultString || resultString === "[]") {
            return res.json({ supplier: supplierName, count: 0, results: [] });
        }

        const data = JSON.parse(resultString);
        
        res.json({
            supplier: supplierName,
            count: data.length,
            results: data
        });

    } catch (error) {
        console.error("❌ Fehler bei der Blockchain-Abfrage:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// Datenintegritätsverifikation zwischen Blockchain und SQL-Datenbank
app.get('/api/admin/audit/:deliveryId', async (req, res) => {
    const { deliveryId } = req.params;

    try {
        // 1. Mapping aus SQL holen
        const mapping = await new Promise((resolve, reject) => {
            db.get("SELECT supplier_name, sensor_id FROM hardware_mappings WHERE delivery_id = ?", [deliveryId], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });

        if (!mapping) return res.status(404).json({ error: "Lieferung nicht gefunden." });

        // 2. SQL Logs zählen
        const sqlLogs = await new Promise((resolve, reject) => {
            db.all("SELECT * FROM sensor_logs WHERE id = ?", [mapping.sensor_id], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });

        // 3. Blockchain-Daten abrufen
        if (!contract) await initBlockchain();
        
        const bcResultBuffer = await contract.evaluateTransaction('GetAssetsByDelivery', mapping.supplier_name, deliveryId);
        
        // Deklaration außerhalb des try-Blocks, damit sie unten verfügbar ist
        let bcData; 

        try {
            // Buffer in UTF-8 String umwandeln
            const rawString = Buffer.from(bcResultBuffer).toString('utf8');
            console.log("DEBUG - Blockchain Rohdaten:", rawString);

            // Zuweisung (ohne erneutes 'let'!)
            bcData = JSON.parse(rawString); 
            
        } catch (parseErr) {
            console.error("❌ Blockchain JSON Fehler:", parseErr.message);
            // Fallback auf leeres Array, falls Blockchain noch leer oder Format falsch
            bcData = []; 
        }   

        // 4. Der Abgleich (zwischen Blockchain und SQL)
        const sqliteCount = sqlLogs.length;
        const blockchainCount = bcData.length;
        
        // Logik: Nur jeder zweite Eintrag wird gespeichert
        const expectedCount = Math.floor(sqliteCount / 2);
        
        // Toleranz von +/- 1 (wegen Counter-Start)
        const isConsistent = Math.abs(blockchainCount - expectedCount) <= 1;

        console.log(`📊 Audit für ${deliveryId}: SQL(${sqliteCount}) vs BC(${blockchainCount})`);

        res.json({
            delivery: deliveryId,
            sensor: mapping.sensor_id,
            integrity: isConsistent ? "VERIFIED ✅" : "DISCREPANCY ❌",
            details: {
                sqlCount: sqliteCount,
                blockchainCount: blockchainCount,
                expected: expectedCount,
                syncStatus: sqliteCount > 0 ? ((blockchainCount / (sqliteCount/2)) * 100).toFixed(1) + "%" : "0%"
            },
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error("Critical Audit Error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

    //SETTER
app.post('/api/buffer', (req, res) => {
    const { id, temp, humidity } = req.body;
    
    console.log(`📩 EINGANG: Daten von Sensor [${id}] empfangen.`);

    db.run(`INSERT INTO sensor_logs (id, temp, humidity) VALUES (?, ?, ?)`, [id, temp, humidity], function(err) {
        if (err) return res.status(500).json({ status: "Error", message: err.message });
        
        messageCounter++;
        if (messageCounter % 2 === 0) {
            sendToHyperledger(id, temp, humidity);
            messageCounter = 0;
        }
        res.status(200).json({ status: "OK" });
    });
});

app.post('/api/admin/set-limit', async (req, res) => {
    // Wir erwarten jetzt 6 Werte vom Frontend
    const { supplier, delivery, maxTemp, minTemp, maxHum, minHum } = req.body;

    try {
        if (!contract) await initBlockchain();
        
        await contract.submitTransaction(
            'SetLimit', 
            supplier, 
            delivery, 
            maxTemp.toString(), 
            minTemp.toString(), 
            maxHum.toString(), 
            minHum.toString()
        );
        
        res.json({ message: "Grenzwerte für Temperatur und Feuchtigkeit erfolgreich gespeichert." });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- SENSOR ONBOARDING / ZUORDNUNG ---
app.post('/api/admin/onboard-sensor', (req, res) => {
    const { sensorId, supplier, delivery } = req.body;

    if (!sensorId || !supplier || !delivery) {
        return res.status(400).json({ error: "Daten unvollständig." });
    }

    // 1. SCHRITT: Wir suchen nach JEDEM Eintrag für diesen Sensor oder diese Lieferung
    // Wir unterscheiden nicht mehr nur nach "is_active = 1"
    db.all(`SELECT * FROM hardware_mappings WHERE sensor_id = ? OR delivery_id = ?`, 
    [sensorId, delivery], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        // Wir gehen die gefundenen Zeilen durch und prüfen auf Konflikte
        for (let row of rows) {
            
            // KONFLIKT A: Die Lieferung wurde bereits abgeschlossen (Archiv-Schutz)
            if (row.delivery_id === delivery && row.is_active === 0) {
                console.warn(`🚫 ZUGRIFF VERWEIGERT: Lieferung ${delivery} ist bereits abgeschlossen und archiviert.`);
                return res.status(403).json({ 
                    error: "Archiv-Schutz", 
                    message: `Die Lieferung ${delivery} ist bereits abgeschlossen und kann nicht mehr verändert werden.` 
                });
            }

            // KONFLIKT B: Die Lieferung läuft gerade mit einem anderen Sensor
            if (row.delivery_id === delivery && row.is_active === 1) {
                return res.status(409).json({ 
                    error: "Konflikt", 
                    message: `Die Lieferung ${delivery} läuft bereits mit Sensor ${row.sensor_id}.` 
                });
            }

            // KONFLIKT C: Der Sensor ist gerade in einer anderen Fahrt aktiv
            if (row.sensor_id === sensorId && row.is_active === 1) {
                return res.status(409).json({ 
                    error: "Konflikt", 
                    message: `Der Sensor ${sensorId} befindet sich gerade in der aktiven Fahrt ${row.delivery_id}.` 
                });
            }
        }

        // 2. SCHRITT: Wenn kein Konflikt gefunden wurde, neu anlegen oder (inaktiven) Sensor-Eintrag überschreiben
        const query = `INSERT OR REPLACE INTO hardware_mappings (sensor_id, supplier_name, delivery_id, is_active) 
                       VALUES (?, ?, ?, 1)`;

        db.run(query, [sensorId, supplier, delivery], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            console.log(`✅ ONBOARDING ERFOLGREICH: Sensor ${sensorId} für ${delivery} registriert.`);
            res.json({ message: "Sensor erfolgreich zugewiesen." });
        });
    });
});

// PROOF-OF-DELIVERY => OFFBOARDING & BLOCKCHAIN-CONFIRM
app.post('/api/admin/proof-of-delivery', async (req, res) => {
    const { supplier, delivery, recipientName } = req.body;

    try {
        if (!contract) await initBlockchain();
        
        // A. Blockchain-Eintrag
        await contract.submitTransaction('ConfirmDelivery', supplier, delivery, recipientName);

        // B. Datenbank-Update (WICHTIG: Wir deaktivieren ALLES für diese Fahrt)
        db.run(`UPDATE hardware_mappings SET is_active = 0 WHERE delivery_id = ?`, [delivery], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            
            console.log(`🏁 OFFBOARDING ERFOLGREICH: Fahrt ${delivery} beendet.`);
            res.json({ status: "Success", message: `Lieferung ${delivery} abgeschlossen.` });
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --- 3. DIE DEBUG-HILFE (Neu: Schau dir die Tabelle im Browser an) ---
app.get('/api/admin/debug-mappings', (req, res) => {
    db.all("SELECT * FROM hardware_mappings", [], (err, rows) => {
        res.json(rows);
    });
});

// --- SERVER START ---
app.listen(port, '0.0.0.0', () => {
    console.log(`--- BACKEND LIVE auf Port ${port} ---`);
});