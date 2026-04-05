// VARIABLEN, PFADE, KONSTANTEN
const express = require('express');
//const grpc = require('@grpc/grpc-js');
//const { connect, signers } = require('@hyperledger/fabric-gateway');
//const fs = require('fs');
const path = require('path');
//const crypto = require('crypto');
//const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
//const walletPath = path.resolve(__dirname, 'wallet', 'org1-admin');
//const certPath = path.join(walletPath, 'msp', 'signcerts', 'cert.pem');
//const keyDirectoryPath = path.join(walletPath, 'msp', 'keystore');
//const tlsCertPath = path.join(walletPath, 'tls', 'ca.crt');
const port = 3000;

//Service-Verknüpfungen
const FabricService = require('./services/FabricService');
const { db } = require('./services/DatabaseService');
const AuditService = require('./services/AuditService'); 

const app = express();
app.use(express.json());


// API-Routen
const AdminRoutes = require('./routes/AdminRoutes');
const DeveloperRoutes = require('./routes/DeveloperRoutes');
const SupplierRoutes = require('./routes/SupplierRoutes');
const SensorRoutes = require('./routes/SensorRoutes');

app.use('/api/admin', AdminRoutes);      
app.use('/api/dev', DeveloperRoutes);      
app.use('/api/supplier', SupplierRoutes); 
app.use('/api/', SensorRoutes); // Sonderroute für api/buffer


//Funktion noch auslagern
async function sendToHyperledger(id, temp, humidity) { // Hilfsfunktion zum Senden an die Blockchain
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



// BACKGROUND WORKER (Offline-Resilienz)

setInterval(() => {
    const sql = `
        SELECT s.*, h.supplier_name, h.delivery_id 
        FROM sensor_logs s
        JOIN hardware_mappings h ON s.sensor_id = h.sensor_id
        WHERE s.sync_status = 'PENDING'
    `;
    const activeContract = FabricService.getContract();


    db.all(sql, async (err, rows) => {
        if (err || rows.length === 0) return;

        console.log(`\n🔄 Offline-Resilienz: Versuche ${rows.length} PENDING-Datensätze nachzusynchronisieren...`);

        for (const row of rows) {
            try {
                if (!activeContract) await FabricService.initBlockchain();
                
                const bcAssetId = `LOG-${Math.floor(Date.now() / 1000)}-${row.id}`;
                
                await activeContract.submitTransaction(
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
                activeContract = null; 
                break; 
            }
        }
    });
}, 30000);

(async () => { //1.4.26: Prüfen ob die Funktion entfernt werden kann
    try {
        console.log("🔄 Systemstart: Initialisiere Blockchain-Verbindung...");
        await FabricService.initBlockchain();
        console.log("✅ Systemstart: Blockchain erfolgreich verbunden.");
    } catch (err) {
        console.error("❌ Systemstart: Blockchain-Verbindung fehlgeschlagen:", err.message);
    }
})();


// --- SERVER START ---
app.listen(port, '0.0.0.0', () => {
    console.log(`--- BACKEND LIVE auf Port ${port} ---`);
});
