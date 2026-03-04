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

// API Routes

//1. Developer Area (/api/dev)

//1.1 Ping für Connectivity Check
app.get('/api/dev/ping', (req, res) => res.send("PONG - Entwicklerzugang aktiv!"));

//1.2 Lokale SQL-Logs einsehen
app.get('/api/dev/buffer-view', (req, res) => {
    db.all("SELECT * FROM sensor_logs ORDER BY timestamp DESC LIMIT 50", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

//1.3 Hardware-Mappings im Klartext (Debug)
app.get('/api/dev/debug-mappings', (req, res) => {
    db.all("SELECT * FROM hardware_mappings", [], (err, rows) => {
        res.json(rows);
    });

//2. Admin Area (/api/admin)

// 2.1 SENSOR ONBOARDING (Eine neue Lieferung starten)
app.post('/api/admin/onboard', authenticate, (req, res) => {
    const { sensorId, supplier, delivery } = req.body;
    
    db.get(`SELECT * FROM hardware_mappings WHERE (sensor_id = ? OR delivery_id = ?) AND is_active = 1`, 
    [sensorId, delivery], (err, row) => {
        if (row) return res.status(409).json({ error: "Konflikt: Sensor oder Lieferung bereits aktiv." });

        db.run(`INSERT OR REPLACE INTO hardware_mappings (sensor_id, supplier_name, delivery_id, is_active) VALUES (?, ?, ?, 1)`,
        [sensorId, supplier, delivery], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: `Lieferung ${delivery} für ${supplier} gestartet.` });
        });
    });
});

// 2.2 SET LIMITS (Grenzwerte festlegen)
app.post('/api/admin/set-limit/:supplier/:deliveryId', authenticate, async (req, res) => {
    const { supplier, deliveryId } = req.params;
    const { maxTemp, minTemp, maxHum, minHum } = req.body;
    try {
        if (!contract) await initBlockchain();
        await contract.submitTransaction('SetLimit', supplier, deliveryId, 
            maxTemp.toString(), minTemp.toString(), maxHum.toString(), minHum.toString());
        res.json({ message: "Grenzwerte gespeichert." });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// 2.3 AUDIT (Vergleich SQL vs Blockchain)
app.get('/api/admin/audit/:supplier/:deliveryId', authenticate, async (req, res) => {
    const { supplier, deliveryId } = req.params;
    try {
        const mapping = await new Promise((res, rej) => {
            db.get("SELECT sensor_id FROM hardware_mappings WHERE supplier_name = ? AND delivery_id = ?", [supplier, deliveryId], (e, r) => e ? rej(e) : res(r));
        });
        if (!mapping) return res.status(404).json({ error: "Lieferung nicht gefunden." });

        const sqlLogs = await new Promise((res, rej) => {
            db.all("SELECT * FROM sensor_logs WHERE id = ?", [mapping.sensor_id], (e, r) => e ? rej(e) : res(r));
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

// 2.4 HISTORY & WARNINGS (Daten für das Dashboard)
app.get('/api/admin/history/:supplier/:deliveryId', authenticate, async (req, res) => {
    const { supplier, deliveryId } = req.params;
    try {
        if (!contract) await initBlockchain();
        const result = await contract.evaluateTransaction('GetAssetsByDelivery', supplier, deliveryId);
        const data = JSON.parse(Buffer.from(result).toString('utf8'));
        
        const warnings = data.filter(a => a.IsWarning === true);
        res.json({ 
            shipment: deliveryId, 
            supplier: supplier,
            totalRecords: data.length, 
            warningCount: warnings.length,
            history: data.sort((a,b) => b.Timestamp - a.Timestamp) 
        });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// 2.5 PROOF-OF-DELIVERY (Lieferung abschließen)
app.post('/api/admin/proof-of-delivery/:supplier/:deliveryId', authenticate, async (req, res) => {
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
});

// --- SERVER START ---
app.listen(port, '0.0.0.0', () => {
    console.log(`--- BACKEND LIVE auf Port ${port} ---`);
});