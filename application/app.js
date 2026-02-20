const express = require('express');
const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();

app.use(express.json());

app.get('/ping', (req, res) => {
    res.send("PONG - Backend ist erreichbar!");
});

// --- KONFIGURATION (Pfade zu deinem Netzwerk) ---
const mspPath = path.resolve(__dirname, '..', 'network', 'organizations', 'peerOrganizations', 'org1.example.com');
const certPath = path.join(mspPath, 'users', 'Admin@org1.example.com', 'msp', 'signcerts', 'cert.pem');
const keyDirectoryPath = path.join(mspPath, 'users', 'Admin@org1.example.com', 'msp', 'keystore');
const tlsCertPath = path.join(mspPath, 'peers', 'peer0.org1.example.com', 'tls', 'ca.crt');

async function getGatewayConnection() {
    const tlsRootCert = fs.readFileSync(tlsCertPath);
    const client = new grpc.Client('localhost:7051', grpc.credentials.createSsl(tlsRootCert));
    
    const files = fs.readdirSync(keyDirectoryPath);
    const keyPath = path.join(keyDirectoryPath, files[0]);

    // DIESE ZEILE FEHLT BEI DIR WAHRSCHEINLICH:
    const privateKeyPem = fs.readFileSync(keyPath);

    return connect({
        client,
        identity: { mspId: 'Org1MSP', credentials: fs.readFileSync(certPath) },
        signer: signers.newPrivateKeySigner(crypto.createPrivateKey(privateKeyPem)),
    });
}

// --- API ROUTE FÜR BUBBLE / SENSOR ---
app.post('/api/sensor', async (req, res) => {
    const { id, temp, humidity, coords } = req.body;
    
    try {
        const gateway = await getGatewayConnection();
        const network = gateway.getNetwork('mychannel');
        const contract = network.getContract('basic');

        console.log(`\n--> Sende an Blockchain: ID ${id}, Temp ${temp}, Ort ${coords}`);

        // Wir nutzen hier die 'CreateAsset' Funktion deines Chaincodes
        await contract.submitTransaction('CreateAsset', id, 'Sensor_01', temp, humidity, coords);
        
        gateway.close();
        res.status(200).json({ status: "Success", message: "Daten auf Blockchain verewigt!" });
    } catch (error) {
        console.error("Fehler:", error);
        res.status(500).json({ status: "Error", message: error.message });
    }
});

// --- API ROUTE ZUM LESEN EINES ASSETS ---
app.get('/api/sensor/:id', async (req, res) => {
    const assetId = req.params.id;
    
    try {
        const gateway = await getGatewayConnection();
        const network = gateway.getNetwork('mychannel');
        const contract = network.getContract('basic');

        console.log(`\n--> Lese von Blockchain: ID ${assetId}`);

        // evaluateTransaction wird für reines Lesen genutzt
        const resultBytes = await contract.evaluateTransaction('ReadAsset', assetId);
        const resultString = Buffer.from(resultBytes).toString();
        const resultJson = JSON.parse(resultString);
        
        gateway.close();
        res.status(200).json(resultJson);
    } catch (error) {
        console.error("Fehler beim Lesen:", error);
        res.status(404).json({ status: "Error", message: `Asset ${assetId} nicht gefunden.` });
    }
});

app.listen(3000, () => {
    console.log('🚀 Backend läuft auf http://localhost:3000');
    console.log('Bereit für Daten von Bubble oder Postman!');
});

//Erzeugen einer SQLite-Datenbank um die (aktuell) Blink-Nachrichten des ESP8266 zu speichern
const sqlite3 = require('sqlite3').verbose();

// Datenbank initialisieren (erstellt eine Datei namens sensor_data.db)
const dbPath = path.resolve(__dirname, 'sensor_data.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS sensor_logs (
        id TEXT, 
        temp REAL, 
        humidity REAL, 
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// DIE ROUTE: Mit einer auffälligen Konsolen-Ausgabe
app.post('/api/buffer', (req, res) => {
    console.log("------------------------------------");
    console.log("!!! DATEN-EMPFANG VERSUCH !!!");
    console.log("Inhalt:", req.body);
    
    const { id, temp, humidity } = req.body;
    const query = `INSERT INTO sensor_logs (id, temp, humidity) VALUES (?, ?, ?)`;
    
    db.run(query, [id, temp, humidity], function(err) {
        if (err) {
            console.error("SQL Fehler:", err.message);
            return res.status(500).send("Fehler");
        }
        console.log(`ERFOLG: In SQL gespeichert (ID: ${this.lastID})`);
        res.status(200).json({ status: "OK" });
    });
});

const PORT = 3000;
// Die '0.0.0.0' ist zwingend erforderlich!
app.listen(PORT, '0.0.0.0', () => {
    console.log(`--- BACKEND LIVE ---`);
    console.log(`Lausche auf Port ${PORT} auf allen Schnittstellen.`);
});

// --- ROUTE FÜR BUBBLE (VORSCHAU DER SQL DATEN) ---
app.get('/api/buffer/view', (req, res) => {
    db.all("SELECT * FROM sensor_logs ORDER BY timestamp DESC LIMIT 20", [], (err, rows) => {
        if (err) return res.status(500).send(err.message);
        res.status(200).json(rows);
    });
});

