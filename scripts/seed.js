const axios = require('axios');

async function runTest() {
    // Ändere localhost auf die explizite IP 127.0.0.1
    // Das verhindert, dass Node.js versucht, über IPv6 (::1) zu gehen
    const API_URL = "http://127.0.0.1:3000"; 
    
    const ADMIN_KEY = "MASTER_ADMIN_2026"; 
    
    const testData = {
        sensorId: "ESP_TEST_02", // Achte auf die exakten Variablennamen aus der app.js
        supplier: "Supplier_A",
        delivery: "SHIP-2026-TEST-02"
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

            // 2. Schritt: Sende 4 Messwerte (Einer davon ist ein Alarm!)
    console.log("\n2. Schritt: Sende 4 Messwerte...");
    const readings = [
        { t: 22.1, h: 50 }, // OK
        { t: 22.5, h: 51 }, // OK (Geht auf BC wegen Modulo 2)
        { t: 35.8, h: 55 }, // ALARM! (>30°C, geht SOFORT auf BC)
        { t: 23.2, h: 50 }  // OK (Geht auf BC wegen Modulo 4)
    ];

    for (let i = 0; i < readings.length; i++) {
        const res = await axios.post(`${API_URL}/api/buffer`, {
            id: testData.sensorId,
            temp: readings[i].t,
            humidity: readings[i].h
        });
        
        const alarmStatus = res.data.alarmTriggered ? "🚨 ALARM!" : "✅ OK";
        console.log(`   Wert ${i+1}: ${readings[i].t}°C -> ${alarmStatus}`);
        
        await new Promise(r => setTimeout(r, 800)); 
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