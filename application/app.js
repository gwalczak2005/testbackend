const express = require('express');
const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

const app = express();
app.use(express.json());

// --- VARIABLEN FÜR LOGIK & BLOCKCHAIN ---
let messageCounter = 0;
const port = 3000;

// 1. Wir definieren den Pfad zu deinem neuen Wallet-Ordner
const walletPath = path.resolve(__dirname, 'wallet', 'org1-admin');
// 2. Wir nutzen walletPath als Basis für alle anderen Pfade
const certPath = path.join(walletPath, 'msp', 'signcerts', 'cert.pem');
const keyDirectoryPath = path.join(walletPath, 'msp', 'keystore');
const tlsCertPath = path.join(walletPath, 'tls', 'ca.crt');
// Nur zum Debuggen (lösche das später):
console.log("Suche Zertifikat unter:", certPath);

// --- DATENBANK INITIALISIERUNG ---
const dbPath = path.resolve(__dirname, 'sensor_data.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error("Fehler beim Öffnen der DB:", err.message);
    else {
        console.log("✅ SQLite-Datenbank verbunden.");
        db.run(`CREATE TABLE IF NOT EXISTS sensor_logs (
            id TEXT, 
            temp REAL, 
            humidity REAL, 
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
    }
});

// --- HYPERLEDGER FUNKTIONEN ---
async function getGatewayConnection() {
    const tlsRootCert = fs.readFileSync(tlsCertPath);
    const client = new grpc.Client('localhost:7051', grpc.credentials.createSsl(tlsRootCert));
    
    const files = fs.readdirSync(keyDirectoryPath);
    const keyPath = path.join(keyDirectoryPath, files[0]);
    const privateKeyPem = fs.readFileSync(keyPath);

    return connect({
        client,
        identity: { mspId: 'Org1MSP', credentials: fs.readFileSync(certPath) },
        signer: signers.newPrivateKeySigner(crypto.createPrivateKey(privateKeyPem)),
    });
}

// Hilfsfunktion zum Senden an die Blockchain (Schritt A)
async function sendToHyperledger(id, temp, humidity) {
    try {
        const gateway = await getGatewayConnection();
        const network = gateway.getNetwork('mychannel');
        const contract = network.getContract('basic');

        console.log(`\n🔗 BLOCKCHAIN-TRANSAKTION: Sende ID ${id} an Ledger...`);
        // Hinweis: 'CreateAsset' muss in deinem Chaincode existieren
        await contract.submitTransaction('CreateAsset', id, 'Sensor_ESP8266', temp.toString(), humidity.toString(), 'Lab_Internal');
        
        gateway.close();
        console.log("✅ Blockchain-Eintrag erfolgreich erstellt.");
    } catch (error) {
        console.error("❌ Blockchain-Fehler:", error.message);
    }
}

// --- API ROUTES ---

app.get('/ping', (req, res) => {
    res.send("PONG - Backend ist erreichbar!");
});

// ROUTE: Empfang vom ESP8266 mit "Jeder-Zweite"-Logik
app.post('/api/buffer', (req, res) => {
    console.log("------------------------------------");
    const { id, temp, humidity } = req.body;
    
    // 1. In SQL speichern (Immer)
    const query = `INSERT INTO sensor_logs (id, temp, humidity) VALUES (?, ?, ?)`;
    db.run(query, [id, temp, humidity], function(err) {
        if (err) {
            console.error("SQL Fehler:", err.message);
            return res.status(500).json({ status: "Error", message: "SQL Fehler" });
        }
        
        messageCounter++;
        console.log(`[SQL] Gespeichert. Zähler: ${messageCounter}/2`);

        // 2. Logik: Jede zweite Sendung an die Blockchain
        if (messageCounter % 2 === 0) {
            sendToHyperledger(id, temp, humidity);
            messageCounter = 0; // Reset
        }

        res.status(200).json({ status: "OK", sql_id: this.lastID });
    });
});

// ROUTE: Zum Lesen eines Assets direkt von Blockchain
app.get('/api/sensor/:id', async (req, res) => {
    const assetId = req.params.id;
    try {
        const gateway = await getGatewayConnection();
        const network = gateway.getNetwork('mychannel');
        const contract = network.getContract('basic');

        const resultBytes = await contract.evaluateTransaction('ReadAsset', assetId);
        const resultJson = JSON.parse(Buffer.from(resultBytes).toString());
        
        gateway.close();
        res.status(200).json(resultJson);
    } catch (error) {
        res.status(404).json({ status: "Error", message: `Asset ${assetId} nicht gefunden.` });
    }
});

// ROUTE: Für Bubble (Vorschau der SQL-Daten)
app.get('/api/buffer/view', (req, res) => {
    db.all("SELECT * FROM sensor_logs ORDER BY timestamp DESC LIMIT 20", [], (err, rows) => {
        if (err) return res.status(500).send(err.message);
        res.status(200).json(rows);
    });
});

// --- SERVER START ---
app.listen(port, '0.0.0.0', () => {
    console.log(`--- BACKEND LIVE ---`);
    console.log(`Lausche auf http://localhost:${port}`);
    console.log(`Blockchain-Filter: Jede 2. Nachricht wird gesichert.`);
});