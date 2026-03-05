const axios = require('axios');

const BASE_URL = 'http://127.0.0.1:3000';
const ADMIN_KEY = 'MASTER_ADMIN_2026';

// Wir simulieren zwei verschiedene Supplier mit ihren Keys
const SUPPLIER_A_KEY = 'MASTER_ADMIN_2026'; // Admin darf für alle senden
const SUPPLIER_B_KEY = 'MASTER_ADMIN_2026'; // Im Test nutzen wir den Admin-Key für beide

async function runTest() {
    console.log("🚀 START: Multi-Supplier Test mit Präfix-Logik...");

    try {
        // --- SCHRITT 1: ONBOARDING ---
        console.log("\n1. Schritt: Onboarding für zwei Lieferanten...");
        
        const onboardA = await axios.post(`${BASE_URL}/api/admin/onboard`, {
            hardwareId: "SENSOR-01",
            supplierName: "Supplier_A",
            deliveryId: "SHIP-A-100"
        }, { headers: { 'x-api-key': ADMIN_KEY } });
        console.log(`✅ Supplier_A onboarded. System-ID: ${onboardA.data.systemId}`);

        const onboardB = await axios.post(`${BASE_URL}/api/admin/onboard`, {
            hardwareId: "SENSOR-01", // Gleiche Hardware-ID wie oben!
            supplierName: "Supplier_B",
            deliveryId: "SHIP-B-200"
        }, { headers: { 'x-api-key': ADMIN_KEY } });
        console.log(`✅ Supplier_B onboarded. System-ID: ${onboardB.data.systemId}`);


        // --- SCHRITT 2: MESSWERTE SENDEN ---
        console.log("\n2. Schritt: Sende Messwerte (Präfix-Test)...");

        // Supplier A sendet einen Normalwert
        const dataA = await axios.post(`${BASE_URL}/api/buffer`, {
            id: "SENSOR-01",
            temp: 22.5,
            humidity: 45
        }, { headers: { 'x-api-key': ADMIN_KEY, 'owner': 'Supplier_A' } }); 
        // Wichtig: In der echten App würde der API-Key den Owner bestimmen. 
        // Für diesen Test stellen wir sicher, dass das Backend den Owner erkennt.
        console.log(`📡 Supplier_A (22.5°C) -> ${dataA.data.systemId}`);

        // Supplier B sendet einen ALARM-Wert
        const dataB = await axios.post(`${BASE_URL}/api/buffer`, {
            id: "SENSOR-01",
            temp: 35.0, // ALARM!
            humidity: 50
        }, { headers: { 'x-api-key': ADMIN_KEY, 'owner': 'Supplier_B' } });
        console.log(`🚨 Supplier_B (35.0°C) -> ${dataB.data.systemId} (ALARM erwartet)`);


        // --- SCHRITT 3: DASHBOARD CHECK ---
        console.log("\n3. Schritt: Überprüfe Dashboards...");
        
        // Admin sieht alles
        const adminAlerts = await axios.get(`${BASE_URL}/api/admin/alerts?ADMIN_KEY=${ADMIN_KEY}`);
        console.log(`📊 Admin sieht insgesamt ${adminAlerts.data.count} Alarme.`);

        // --- SCHRITT 4: AUDIT ---
        console.log("\n--- TEST-ERGEBNIS ---");
        console.log(`Supplier_A System-ID: ${onboardA.data.systemId}`);
        console.log(`Supplier_B System-ID: ${onboardB.data.systemId}`);
        console.log("Die Trennung funktioniert, wenn beide die gleiche Hardware-ID (SENSOR-01) nutzen konnten!");

    } catch (error) {
        console.error("❌ Test fehlgeschlagen:", error.response ? error.response.data : error.message);
    }
}

runTest();