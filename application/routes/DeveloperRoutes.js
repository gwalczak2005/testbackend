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

router.get('/health', (req, res) => {
    console.log("🔍 Health-Check: Passiv-Modus...");
    
    // Nur den Status abfragen, nicht aktiv .initBlockchain() rufen!
    const contract = FabricService.getContract();
    const isReady = !!contract;

    console.log("🔍 Status:", isReady ? "Verbunden" : "Initialisierung läuft...");

    if (isReady) {
        return res.status(200).json({ 
            status: "ready", 
            blockchain: "connected",
            timestamp: new Date().toISOString()
        });
    } else {
        // 503 signalisiert: Dienst ist da, aber noch nicht bereit (Ready-Probe)
        return res.status(503).json({ 
            status: "not ready", 
            blockchain: "disconnected",
            message: "System is still initializing or blockchain is unreachable."
        });
    }
});

module.exports = router;