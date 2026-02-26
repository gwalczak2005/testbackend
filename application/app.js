const express = require('express');
const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

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
    // Eindeutige ID mit Zeitstempel für die Blockchain
    const timestampID = `${id}_${Date.now()}`;
    
    console.log(`\n🔗 BLOCKCHAIN: Sende Messpunkt ${timestampID}...`);

    if (!contract) {
        console.log("🔄 Verbindung verloren. Versuche Reconnect...");
        await initBlockchain();
    }

    try {
        // HIER SIND DIE NEUEN PARAMETER:
        // 1. timestampID (eindeutig)
        // 2. id (Name des Sensors vom ESP)
        // 3. temp (als String)
        // 4. humidity (als String)
        // 5. 'Supplier_Acer_Project' (Ein statischer Name für den Lieferanten)
        
        await contract.submitTransaction(
            'CreateAsset', 
            timestampID, 
            id, 
            temp.toString(), 
            humidity.toString(), 
            'Supplier_Acer_Project'
        );
        
        console.log(`✅ Blockchain-Eintrag erfolgreich! (Warnungs-Check erfolgt im Ledger)`);
    } catch (error) {
        console.error("❌ Blockchain-Sende-Fehler:", error.message);
        if (error.message.includes('14 UNAVAILABLE') || error.message.includes('closed')) {
            contract = null;
        }
    }
}

// --- API ROUTES ---

app.get('/ping', (req, res) => res.send("PONG - Backend ist erreichbar!"));

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

app.get('/api/buffer/view', (req, res) => {
    db.all("SELECT * FROM sensor_logs ORDER BY timestamp DESC LIMIT 20", [], (err, rows) => {
        if (err) return res.status(500).send(err.message);
        res.status(200).json(rows);
    });
});

// --- SERVER START ---
app.listen(port, '0.0.0.0', () => {
    console.log(`--- BACKEND LIVE auf Port ${port} ---`);
});