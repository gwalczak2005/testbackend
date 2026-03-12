const axios = require('axios');

const BASE_URL = 'http://127.0.0.1:3000';
const ADMIN_KEY = 'MASTER_ADMIN_2026';

async function runTest() {
    console.log("🚀 START: Lifecycle & Versiegelungs-Test (Final Checkout)...");

    try {
        // --- SCHRITT 1: ONBOARDING ---
        console.log("\n📦 1. Onboarding für Supplier A...");
        await axios.post(`${BASE_URL}/api/admin/onboard`, {
            hardwareId: "SENSOR-01", supplierName: "Supplier_A", deliveryId: "SHIP-A-100"
        }, { headers: { 'x-api-key': ADMIN_KEY } });
        console.log(`✅ Sensor registriert.`);

        // --- SCHRITT 2: LIMITS SETZEN ---
        console.log("\n⚙️ 2. Setze Grenzwerte...");
        await axios.post(`${BASE_URL}/api/admin/set-limit/Supplier_A/SHIP-A-100`, {
            maxTemp: 24.0, minTemp: 2.0, maxHum: 60.0, minHum: 20.0
        }, { headers: { 'x-api-key': ADMIN_KEY } });
        console.log(`✅ Limits synchronisiert.`);

        // --- SCHRITT 3: NORMALE DATENÜBERTRAGUNG (Während der Fahrt) ---
        console.log("\n📡 3. LKW ist unterwegs - Sensor funkt Daten...");
        let res = await axios.post(`${BASE_URL}/api/buffer`, { id: "SENSOR-01", temp: 22.0, humidity: 50 }, 
            { headers: { 'x-api-key': ADMIN_KEY, 'owner': 'Supplier_A' } });
        console.log(`👉 Sensor funkt 22.0°C -> Status: ${res.data.status}`);

        // --- SCHRITT 4: EMPFANGSBESTÄTIGUNG (Ware am Ziel) ---
        console.log("\n🏢 4. Ware kommt an - Empfang wird bestätigt...");
        const receipt = await axios.post(`${BASE_URL}/api/admin/confirm-receipt/Supplier_A/SHIP-A-100`, 
            { recipientName: "Großunternehmen Lager West" }, // <-- HIER IST DER FIX!
            { headers: { 'x-api-key': ADMIN_KEY } }
        );
        console.log(`✅ ${receipt.data.message}`);

        // --- SCHRITT 5: FINAL CHECKOUT (Versiegelung der Blockchain) ---
        console.log("\n🔒 5. Final Checkout - Blockchain wird versiegelt...");
        const checkout = await axios.post(`${BASE_URL}/api/admin/final-checkout/Supplier_A/SHIP-A-100`, {}, 
            { headers: { 'x-api-key': ADMIN_KEY } });
        console.log(`✅ ${checkout.data.message}`);

        // --- SCHRITT 6: DER HACKER/GHOST-TEST ---
        console.log("\n👻 6. Ghost-Update Test: Sensor funkt nach Abschluss weiter...");
        try {
            await axios.post(`${BASE_URL}/api/buffer`, { id: "SENSOR-01", temp: 28.0, humidity: 50 }, 
                { headers: { 'x-api-key': ADMIN_KEY, 'owner': 'Supplier_A' } });
            console.log("❌ FEHLER: Der Sensor durfte noch senden! Das sollte nicht passieren.");
        } catch (ghostError) {
            console.log(`✅ ABGEWEHRT! System blockiert den Sensor erfolgreich.`);
            console.log(`👉 Grund: ${ghostError.response ? ghostError.response.data.error : ghostError.message}`);
        }

    } catch (error) {
        console.error("\n❌ Unerwarteter Test-Fehler:", error.response ? error.response.data : error.message);
    }
}

runTest();