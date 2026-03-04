const axios = require('axios');

async function runSystemTest() {
    // --- KONFIGURATION ---
    const API_URL = "http://localhost:3000";
    const API_KEY = "DEIN_GEHEIMER_SUPER_KEY_123"; // MUSS mit app.js übereinstimmen!
    
    const testData = {
        supplier: "Enterprise-Logistik-AG",
        delivery: "SHIP-2026-CONF-777",
        sensor: "ESP_001"
    };

    // Header für die Admin-Berechtigungen
    const adminConfig = { 
        headers: { 'x-api-key': API_KEY } 
    };

    console.log("🛠️  DEVELOPER-SEED: Starte Test-Szenario...");

    try {
        // SCHRITT 1: Admin-Onboarding
        console.log(`\n1. Admin: Registriere ${testData.delivery} für ${testData.supplier}...`);
        const onboardRes = await axios.post(`${API_URL}/api/admin/onboard`, {
            sensorId: testData.sensor,
            supplier: testData.supplier,
            delivery: testData.delivery
        }, adminConfig);
        console.log(`✅ ${onboardRes.data.message}`);

        // SCHRITT 2: Sensor-Simulation
        console.log(`\n2. Sensor: Sende 4 Datenpakete an den Buffer...`);
        for (let i = 1; i <= 4; i++) {
            const sensorPayload = {
                id: testData.sensor,
                temp: (20.5 + i * 0.3).toFixed(1),
                humidity: (55 + i).toFixed(1)
            };
            await axios.post(`${API_URL}/api/buffer`, sensorPayload);
            console.log(`📡 Paket ${i}/4 gesendet.`);
            await new Promise(r => setTimeout(r, 500)); // Kurze Pause
        }

        // SCHRITT 3: Wartezeit für Blockchain-Finalisierung
        console.log(`\n⏳ Warte 5 Sekunden auf die Blockchain-Bestätigung...`);
        await new Promise(r => setTimeout(r, 5000));

        // SCHRITT 4: Admin-Audit (Triangle-Logik Pfad)
        console.log(`\n3. Admin: Starte Audit für ${testData.supplier} / ${testData.delivery}...`);
        const auditUrl = `${API_URL}/api/admin/audit/${testData.supplier}/${testData.testDelivery}`;
        
        // Kleine Korrektur für den URL-Zusammenbau:
        const auditRes = await axios.get(`${API_URL}/api/admin/audit/${testData.supplier}/${testData.delivery}`, adminConfig);

        console.log("\n--- AUDIT ERGEBNIS ---");
        console.log(`Status: ${auditRes.data.integrity}`);
        console.log(`SQL Einträge: ${auditRes.data.details.sql}`);
        console.log(`Blockchain Einträge: ${auditRes.data.details.blockchain}`);
        console.log(`Erwartet: ${auditRes.data.details.expected}`);
        console.log("----------------------\n");

        if (auditRes.data.integrity.includes("VERIFIED")) {
            console.log("✨ Test erfolgreich! Das System ist bereit für das Großunternehmen.");
        } else {
            console.log("⚠️  Integritätsprüfung fehlgeschlagen. Prüfe Backend-Logs.");
        }

    } catch (error) {
        console.error("\n❌ Fehler im Testlauf:");
        if (error.response) {
            console.error(`Status: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
        } else {
            console.error(error.message);
        }
    }
}

runSystemTest();