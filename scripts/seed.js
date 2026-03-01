const axios = require('axios');

async function runTestScenario() {
    const API_URL = "http://localhost:3000";
    const testDelivery = "SHIP-2026-AUTO-999";
    const sensorId = "ESP_001";

    console.log("🚀 Starte automatisierten System-Test...");

    try {
        // SCHRITT 1: Onboarding (Admin-Aktion)
        console.log(`\n1. Onboarding: Verknüpfe ${sensorId} mit ${testDelivery}...`);
        const onboardRes = await axios.post(`${API_URL}/api/admin/onboard-sensor`, {
            sensorId: sensorId,
            supplier: "Test-Logistik-GmbH",
            delivery: testDelivery
        });
        console.log(`✅ Antwort: ${onboardRes.data.message}`);

        // SCHRITT 2: Daten-Simulation (Sensor-Aktion)
        // Wir senden 4 Pakete. Da dein Backend nur jedes 2. Paket speichert,
        // landen am Ende genau 2 Einträge auf der Blockchain.
        console.log(`\n2. Simulation: Sende 4 Messwert-Pakete...`);
        for (let i = 1; i <= 4; i++) {
            const data = {
                id: sensorId,
                temp: (22.5 + i * 0.5).toFixed(1), // Steigende Temperatur
                humidity: (45 + i).toFixed(1)
            };
            
            await axios.post(`${API_URL}/api/buffer`, data);
            console.log(`📡 Paket ${i}/4 gesendet: ${data.temp}°C, ${data.humidity}%`);
            
            // Kurze Pause, damit die Zeitstempel sich unterscheiden
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        // SCHRITT 3: Audit-Check (Integritäts-Prüfung)
        console.log(`\n3. Audit: Überprüfe Integrität zwischen SQL und Blockchain...`);
        const auditRes = await axios.get(`${API_URL}/api/admin/audit/${testDelivery}`);
        
        console.log("\n--- ERGEBNIS ---");
        console.log(`Status: ${auditRes.data.integrity}`);
        console.log(`SQL Einträge: ${auditRes.data.details.sqlCount}`);
        console.log(`Blockchain Einträge: ${auditRes.data.details.blockchainCount}`);
        console.log(`----------------\n`);
        console.log("✨ Test erfolgreich abgeschlossen!");

    } catch (error) {
        console.error("\n❌ Fehler während des Seeds:");
        if (error.response) {
            console.error(`Status: ${error.response.status} - ${error.response.data.message || error.response.data.error}`);
        } else {
            console.error(error.message);
        }
    }
}

runTestScenario();

