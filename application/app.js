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


const FabricService = require('./services/FabricService');
const { db } = require('./services/DatabaseService');
//const activeContract = FabricService.getContract();

const AuditService = require('./services/AuditService'); //für API Final-Checkout !!

const app = express();
app.use(express.json());

const AdminRoutes = require('./routes/AdminRoutes');
const DeveloperRoutes = require('./routes/DeveloperRoutes');
const SupplierRoutes = require('./routes/SupplierRoutes');
const SensorRoutes = require('./routes/SensorRoutes');


// Bindet alle Routen aus den Dateien direkt an die Root-Ebene
// app.js - ÄNDERE DIESE ZEILEN:
app.use('/api/admin', AdminRoutes);      // ← Prefix hinzugefügt
app.use('/api/dev', DeveloperRoutes);    // ← Prefix hinzugefügt  
app.use('/api/supplier', SupplierRoutes); // ← Prefix hinzugefügt
app.use('/api/', SensorRoutes); // ← Prefix hinzugefügt


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


//API-ROUTES



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

(async () => {
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
