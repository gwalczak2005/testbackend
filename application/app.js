// VARIABLEN, PFADE, KONSTANTEN
const express = require('express');
const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const walletPath = path.resolve(__dirname, 'wallet', 'org1-admin');
const certPath = path.join(walletPath, 'msp', 'signcerts', 'cert.pem');
const keyDirectoryPath = path.join(walletPath, 'msp', 'keystore');
const tlsCertPath = path.join(walletPath, 'tls', 'ca.crt');
const port = 3000;
const API_KEYS = {                                                          //Schlüssel-Datenbank
    "DEIN_ADMIN_MASTER_KEY": { role: "ADMIN", owner: "Großunternehmen" },
    "KEY_SUPPLIER_A": { role: "SUPPLIER", owner: "Supplier_A" }
};

const FabricService = require('./services/FabricService');
const { db } = require('./services/DatabaseService');
const activeContract = FabricService.getContract();

const AuditService = require('./services/AuditService'); //für API Final-Checkout !!

const app = express();
app.use(express.json());

const AdminRoutes = require('./routes/AdminRoutes');
const DeveloperRoutes = require('./routes/DeveloperRoutes');
const SupplierRoutes = require('./routes/SupplierRoutes');

// Bindet alle Routen aus den Dateien direkt an die Root-Ebene
app.use('/', AdminRoutes);
app.use('/', DeveloperRoutes);
app.use('/', SupplierRoutes);

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

// --- SERVER START ---
app.listen(port, '0.0.0.0', () => {
    console.log(`--- BACKEND LIVE auf Port ${port} ---`);
});

module.exports = { supplierAuth };