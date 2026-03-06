const axios = require('axios');

const BASE_URL = 'http://127.0.0.1:3000';
const ADMIN_KEY = 'MASTER_ADMIN_2026';

async function runTest() {
    console.log("🚀 START: Testlauf für individuelle Limits & intelligenten Buffer...");

    try {
        // --- SCHRITT 1: ONBOARDING ---
        console.log("\n📦 1. Onboarding für zwei Lieferanten...");
        const onboardA = await axios.post(`${BASE_URL}/api/admin/onboard`, {
            hardwareId: "SENSOR-01", supplierName: "Supplier_A", deliveryId: "SHIP-A-100"
        }, { headers: { 'x-api-key': ADMIN_KEY } });
        
        const onboardB = await axios.post(`${BASE_URL}/api/admin/onboard`, {
            hardwareId: "SENSOR-01", supplierName: "Supplier_B", deliveryId: "SHIP-B-200"
        }, { headers: { 'x-api-key': ADMIN_KEY } });
        console.log(`✅ Sensoren registriert.`);


        // --- SCHRITT 2: INDIVIDUELLE LIMITS SETZEN ---
        console.log("\n⚙️ 2. Setze individuelle Limits (SQL & Blockchain)...");
        // Supplier A bekommt strenge Limits (Kühlkette: Max 24°C)
        await axios.post(`${BASE_URL}/api/admin/set-limit/Supplier_A/SHIP-A-100`, {
            maxTemp: 24.0, minTemp: 2.0, maxHum: 60.0, minHum: 20.0
        }, { headers: { 'x-api-key': ADMIN_KEY } });
        
        // Supplier B bekommt lockere Limits (z.B. Elektronik: Max 40°C)
        await axios.post(`${BASE_URL}/api/admin/set-limit/Supplier_B/SHIP-B-200`, {
            maxTemp: 40.0, minTemp: -10.0, maxHum: 80.0, minHum: 10.0
        }, { headers: { 'x-api-key': ADMIN_KEY } });
        console.log(`✅ Limits erfolgreich synchronisiert.`);


        // --- SCHRITT 3: MESSWERTE SENDEN (BUFFER & MODULO TEST) ---
        console.log("\n📡 3. Sende Messwerte...");

        // Test A.1: Normaler Wert (sollte gepuffert, aber NICHT auf die Blockchain gehen -> Count 1)
        let res = await axios.post(`${BASE_URL}/api/buffer`, { id: "SENSOR-01", temp: 20.0, humidity: 45 }, 
            { headers: { 'x-api-key': ADMIN_KEY, 'owner': 'Supplier_A' } });
        console.log(`👉 Supplier A (20.0°C) | Alarm: ${res.data.isAlarm} | BC-Sync: ${res.data.blockchainSync} (Erwartet: false)`);

        // Test A.2: Normaler Wert (sollte auf die Blockchain gehen -> Count 2 / Modulo greift!)
        res = await axios.post(`${BASE_URL}/api/buffer`, { id: "SENSOR-01", temp: 21.0, humidity: 45 }, 
            { headers: { 'x-api-key': ADMIN_KEY, 'owner': 'Supplier_A' } });
        console.log(`👉 Supplier A (21.0°C) | Alarm: ${res.data.isAlarm} | BC-Sync: ${res.data.blockchainSync} (Erwartet: true, wegen Modulo)`);

        // Test A.3: ALARM Wert (28°C ist über Limit 24°C -> Muss SOFORT auf die Blockchain!)
        res = await axios.post(`${BASE_URL}/api/buffer`, { id: "SENSOR-01", temp: 28.0, humidity: 50 }, 
            { headers: { 'x-api-key': ADMIN_KEY, 'owner': 'Supplier_A' } });
        console.log(`🚨 Supplier A (28.0°C) | Alarm: ${res.data.isAlarm} | BC-Sync: ${res.data.blockchainSync} (Erwartet: true, ALARM!)`);

        // Test B.1: Wert ist 35°C. Im alten System ein Alarm, jetzt wegen Limit 40°C völlig okay!
        res = await axios.post(`${BASE_URL}/api/buffer`, { id: "SENSOR-01", temp: 35.0, humidity: 50 }, 
            { headers: { 'x-api-key': ADMIN_KEY, 'owner': 'Supplier_B' } });
        console.log(`👉 Supplier B (35.0°C) | Alarm: ${res.data.isAlarm} | BC-Sync: ${res.data.blockchainSync} (Erwartet: false, da Limit 40°C!)`);


        // --- SCHRITT 4: AUDIT DASHBOARD ---
        console.log("\n📊 4. Dashboard Prüfung...");
        const adminAlerts = await axios.get(`${BASE_URL}/api/admin/alerts`, { headers: { 'x-api-key': ADMIN_KEY } });
        console.log(`Gesamte Alarme im Ledger: ${adminAlerts.data.count}`);

    } catch (error) {
        console.error("❌ Test fehlgeschlagen:", error.response ? error.response.data : error.message);
    }
}

runTest();