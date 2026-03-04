const axios = require('axios');

async function runTest() {
    // Ändere localhost auf die explizite IP 127.0.0.1
    // Das verhindert, dass Node.js versucht, über IPv6 (::1) zu gehen
    const API_URL = "http://127.0.0.1:3000"; 
    
    const ADMIN_KEY = "MASTER_ADMIN_2026"; 
    
    const testData = {
        sensorId: "ESP_TEST_84", // Achte auf die exakten Variablennamen aus der app.js
        supplier: "Supplier_D",
        delivery: "SHIP-2026-TEST-51"
    };

    const config = { 
        headers: { 
            'x-api-key': ADMIN_KEY,
            'Content-Type': 'application/json' 
        } 
    };

    console.log(`🚀 START: Verbindungstest zu ${API_URL}...`);

    try {
        // SCHRITT 1: ONBOARDING
        console.log("\n1. Schritt: Onboarding via Admin-Schnittstelle...");
        
        // WICHTIG: Prüfe hier den Pfad /api/admin/onboard
        // In scripts/seed.js
        const onboard = await axios.post(`${API_URL}/api/admin/onboard`, {
            sensorId: testData.sensorId, // Prüfe ob der Key hier sensorId heißt!
            supplier: testData.supplier,
            delivery: testData.delivery
        }, config);        
        console.log(`✅ Antwort vom Server: ${JSON.stringify(onboard.data)}`);

        // ... restliches Skript ...

        // 2. DATEN-BUFFER (Sensor simuliert)
        console.log("\n2. Schritt: Sende 4 Messwerte...");
        for (let i = 1; i <= 4; i++) {
            await axios.post(`${API_URL}/api/buffer`, {
                id: testData.sensorId, // WICHTIG: Das Feld MUSS 'id' heißen (wie in app.js definiert)
                temp: (20 + i).toFixed(1),
                humidity: 50
            });
            process.stdout.write("."); 
            await new Promise(r => setTimeout(r, 500)); // Kurze Pause für die DB
        }

        // 3. WARTEZEIT (Blockchain braucht einen Moment)
        console.log("\n\n3. Schritt: Warte 5s auf Blockchain-Finalisierung...");
        await new Promise(r => setTimeout(r, 5000));

        // 4. AUDIT (Triangle-Logik)
        console.log(`\n4. Schritt: Audit-Abfrage für ${testData.supplier}/${testData.delivery}...`);
        const audit = await axios.get(
            `${API_URL}/api/admin/audit/${testData.supplier}/${testData.delivery}`, 
            config
        );

        console.log("\n--- TEST-ERGEBNIS ---");
        console.log(`Integrität: ${audit.data.integrity}`);
        console.log(`SQL Einträge: ${audit.data.details.sql}`);
        console.log(`Blockchain: ${audit.data.details.blockchain}`);
        console.log("----------------------");

        if (audit.data.integrity.includes("VERIFIED")) {
            console.log("✨ ALLES LÄUFT REIBUNGSLOS!");
        }

    } catch (error) {
        console.error("\n❌ TEST FEHLGESCHLAGEN:");
        if (error.response) {
            console.error(`Status: ${error.response.status}`);
            console.error(`Nachricht: ${JSON.stringify(error.response.data)}`);
        } else {
            console.error(error.message);
        }
    }
}

runTest();