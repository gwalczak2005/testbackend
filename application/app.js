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
    // 1. MAPPING-LOGIK (Weg A)
    // Hier bestimmen wir, welcher Sensor gerade für wen fährt.
    // Später holen wir diese Info aus deiner SQLite-Datenbank.
    let supplierName = 'Supplier_Unbekannt';
    let deliveryId = 'NO-ACTIVE-DELIVERY';

    if (id === 'ESP_LOCAL') { // Dein Test-Sensor Name
        supplierName = 'Lieferant1';
        deliveryId = 'SHIP-2026-001';
    } else if (id === 'ESP_KUEHLTRUHE_2') {
        supplierName = 'Lieferant2';
        deliveryId = 'SHIP-2026-002';
    }

    // 2. Eindeutige ID für den Ledger-Key
    const timestampID = `${id}_${Date.now()}`;
    
    console.log(`\n🔗 BLOCKCHAIN: Sende Daten für ${supplierName} (${deliveryId})...`);

    if (!contract) {
        console.log("🔄 Verbindung verloren. Warte 5 Sekunden vor Reconnect...");
        await sleep(5000); // 5000 Millisekunden = 5 Sekunden echte Pause
        await initBlockchain();
        
        // Falls es immer noch nicht geht, brechen wir hier ab, statt zu spammen
        if (!contract) {
            console.error("❌ Reconnect fehlgeschlagen. Überspringe diesen Messpunkt.");
            return;
        }
    }

    try {
        // 3. TRANSAKTION SENDEN
        // WICHTIG: Die Reihenfolge muss exakt wie im Smart Contract sein!
        await contract.submitTransaction(
            'CreateAsset', 
            timestampID,    // assetID (für den Composite Key)
            id,             // sensorId
            temp.toString(), 
            humidity.toString(), 
            supplierName, 
            deliveryId
        );
        
        console.log(`✅ Blockchain-Eintrag erfolgreich unter Lieferung ${deliveryId} gespeichert.`);
    } catch (error) {
        console.error("❌ Blockchain-Sende-Fehler:", error.message);
        if (error.message.includes('14 UNAVAILABLE') || error.message.includes('closed')) {
            contract = null;
        }
    }
}

// --- API ROUTES ---

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
app.post('/api/buffer', (req, res) => {
    const { id, temp, humidity } = req.body;
    
    db.run(`INSERT INTO sensor_logs (id, temp, humidity) VALUES (?, ?, ?)`, [id, temp, humidity], function(err) {
        if (err) return res.status(500).json({ status: "Error", message: err.message });
        
        messageCounter++;
        console.log(`[SQL] Gespeichert (${messageCounter}/2)`);

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

// --- SERVER START ---
app.listen(port, '0.0.0.0', () => {
    console.log(`--- BACKEND LIVE auf Port ${port} ---`);
});