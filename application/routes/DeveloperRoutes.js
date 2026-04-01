const express = require('express');
const router = express.Router();
const FabricService = require('../services/FabricService');
const AuditService = require('../services/AuditService');
const { db } = require('../services/DatabaseService');
const supplierAuth = require('../services/SupplierAuth');

/// ==========================================
// 1. Developer Area (/api/dev)
// ==========================================

router.post('/test', (req, res) => {
    console.log("🎯 TEST-TREFFER!");
    res.send("Habe dich gehört!");
});

router.get('/ping', (req, res) => res.send("PONG - Entwicklerzugang aktiv!"));

router.get('/buffer-view', (req, res) => {
    db.all("SELECT * FROM sensor_logs ORDER BY timestamp DESC LIMIT 50", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

router.get('/debug-mappings', (req, res) => {
    db.all("SELECT * FROM hardware_mappings", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
}); 

router.get('/health', async (req, res) => {
    console.log("🔍 Health-Check: Anfrage empfangen...");
    console.log("🔍 Debug: FabricService Objekt geladen?", !!FabricService);
    console.log("🔍 Debug: getContract Funktion vorhanden?", typeof FabricService.getContract);    // 1. Hol dir den aktuellen Contract-Status direkt vom Service
    
    let contract = FabricService.getContract();
    console.log("🔍 Health-Check: Aktueller Contract-Status:", contract ? "Verbunden" : "Nicht verbunden");

    // 2. Wenn noch kein Contract da ist, versuche ihn zu initialisieren
    if (!contract) {
        console.log("🔄 Health-Check: Initialisiere Blockchain-Verbindung...");
        await FabricService.initBlockchain();
        // Nach dem Init-Versuch erneut den Status prüfen
        contract = FabricService.getContract();
    }

    // 3. Jetzt den korrekten Status zurückgeben
    if (contract) {
        res.status(200).json({ status: "ready", blockchain: "connected" });
    } else {
        res.status(503).json({ status: "not ready", blockchain: "disconnected" });
    }
});

module.exports = router;