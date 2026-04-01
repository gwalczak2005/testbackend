const express = require('express');
const router = express.Router();
const FabricService = require('../services/FabricService');
const AuditService = require('../services/AuditService');
const { db } = require('../services/DatabaseService');
const supplierAuth = require('../services/SupplierAuth');

// --- SENSOR DATA BUFFER (Schnittstelle für ESP8266)
router.post('/buffer', supplierAuth, (req, res) => { //muss den vollen Namen behalten!
    // --- ÄNDERUNG 1: Mapping auf die Variablennamen deines .http-Skripts ---
    const { sensorId, temperature, humidity, lat, lon } = req.body; 
    const id = sensorId; // Alias für die interne Logik
    const temp = temperature;

    // Ermittlung der Identität (Admin-Override oder Supplier-Eigendaten)
    const supplierPrefix = (req.user.role === 'ADMIN' && req.headers['owner']) 
                            ? req.headers['owner'] 
                            : req.user.owner;
    
    const uniqueId = id.startsWith(supplierPrefix) ? id : `${supplierPrefix}_${id}`;
    
    // --- ÄNDERUNG 2: Status-Filter entfernt oder erweitert ---
    // Wir erlauben Dateneingang, sobald onboarded wurde (auch wenn Limits noch PENDING sind)
    const sqlCheck = `SELECT * FROM hardware_mappings 
                      WHERE sensor_id = ? AND is_active = 1`; 

    db.get(sqlCheck, [uniqueId], async (err, mapping) => {
        if (err || !mapping) {
            // Debug-Log für dich im Terminal
            console.log(`Log: Suche nach ${uniqueId} fehlgeschlagen. Token-Owner: ${req.user.owner}`);
            return res.status(403).json({ error: "Sensor inaktiv oder keine laufende Lieferung gefunden." });
        }

        // --- ÄNDERUNG 3: Fallback für Alarmprüfung, falls Limits noch null sind ---
        const isAlarm = (mapping.max_temp !== null && 
                        (temp > mapping.max_temp || temp < mapping.min_temp || 
                         humidity > mapping.max_hum || humidity < mapping.min_hum)) ? 1 : 0;

        // 3. Status-Update: Reading Count für Modulo-Sync erhöhen
        const newCount = (mapping.reading_count || 0) + 1;
        db.run(`UPDATE hardware_mappings SET reading_count = ? WHERE sensor_id = ?`, [newCount, uniqueId]);

        const measurementTime = new Date().toISOString();

        // 4. Persistierung in der lokalen SQLite-Datenbank (Audit-Log)
        // --- ÄNDERUNG 4: Spaltennamen temp -> temperature (je nach deinem DB Schema) ---
        const sqlInsert = `INSERT INTO sensor_logs (sensor_id, temp, humidity, lat, lon, is_alarm, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`;
        db.run(sqlInsert, [uniqueId, temp, humidity, lat, lon, isAlarm, measurementTime], async function(err) {
            if (err) return res.status(500).json({ error: "Lokaler DB-Fehler: " + err.message });

            const logId = this.lastID;
            // Regel: Jeder 2. Wert ODER bei Grenzwertüberschreitung
            const shouldSync = (newCount % 2 === 0 || isAlarm === 1);

            // 5. Übergabe an den Blockchain-Service
            if (shouldSync) {
                // Hier sicherstellen, dass syncToBlockchain die richtigen Keys nutzt
                const syncResult = await FabricService.syncToBlockchain(logId, { 
                    uniqueId, temp, humidity, lat, lon, measurementTime 
                }, mapping);

                if (!syncResult.success) {
                    db.run(`UPDATE sensor_logs SET sync_status = 'PENDING' WHERE id = ?`, [logId]);
                }
            }
            
            // 6. Antwort an den ESP8266
            res.json({ 
                status: "Buffered", 
                systemId: uniqueId, 
                blockchainSync: shouldSync,
                isAlarm: (isAlarm === 1)
            });
        });
    });
});

module.exports = router;