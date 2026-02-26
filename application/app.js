const express = require('express');
const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

let gateway;
let contract;

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
        const tlsRootCert = fs.readFileSync(tlsCertPath);
        const client = new grpc.Client('localhost:7051', grpc.credentials.createSsl(tlsRootCert), {
            'grpc.keepalive_time_ms': 120000,
            'grpc.http2.min_time_between_pings_ms': 120000,
        });

        const files = fs.readdirSync(keyDirectoryPath);
        const keyFile = files.find(file => file.endsWith('_sk'));
        const privateKeyPem = fs.readFileSync(path.join(keyDirectoryPath, keyFile));

        // Wir weisen die Werte den globalen Variablen zu
        gateway = await connect({
            client,
            identity: { mspId: 'Org1MSP', credentials: fs.readFileSync(certPath) },
            signer: signers.newPrivateKeySigner(crypto.createPrivateKey(privateKeyPem)),
        });

        const network = gateway.getNetwork('mychannel');
        contract = network.getContract('basic'); // Hier wird 'contract' befüllt!
        
        console.log("✅ Blockchain-Gateway erfolgreich initialisiert.");
    } catch (error) {
        console.error("❌ Fehler bei Blockchain-Initialisierung:", error.message);
    }
}

// Hilfsfunktion zum Senden an die Blockchain
async function sendToHyperledger(id, temp, humidity) {
    try {
        // Falls der Server startete, bevor die Blockchain bereit war
        if (!contract) {
            console.log("🔄 Contract nicht bereit, initialisiere neu...");
            await initBlockchain();
        }

        const timestampID = `${id}_${Date.now()}`;
        console.log(`\n🔗 BLOCKCHAIN: Sende Messpunkt ${timestampID}...`);

        // Nutzt die globale Variable 'contract'
        await contract.submitTransaction(
            'CreateAsset', 
            timestampID, 
            'Sensor_Node', 
            temp.toString(), 
            humidity.toString(), 
            'Lab_User'
        );
        
        console.log("✅ Blockchain-Eintrag erfolgreich.");
    } catch (error) {
        console.error("❌ Blockchain-Fehler:", error.message);
        if (error.message.includes('10 ABORTED')) {
             console.log("Tipp: Das könnte ein Verbindungsabbruch sein. Starte ggf. das Backend neu.");
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