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

        // --- SCHRITT 3: MESSREIHE SIMULIEREN (10 Werte) ---
        console.log("\n📡 3. LKW ist unterwegs - Sensor funkt 10 Werte...");
        
        const testDaten = [
            { t: 21.5, h: 48 }, { t: 22.0, h: 50 }, { t: 22.5, h: 52 }, // Normal
            { t: 25.5, h: 55 }, // ALARM (über 24°C)
            { t: 23.0, h: 50 }, { t: 22.8, h: 49 }, { t: 22.5, h: 48 }, 
            { t: 22.0, h: 47 }, { t: 21.8, h: 46 }, { t: 21.5, h: 45 }
        ];

        for (let i = 0; i < testDaten.length; i++) {
            const data = testDaten[i];
            const res = await axios.post(`${BASE_URL}/api/buffer`, 
                { id: "SENSOR-01", temp: data.t, humidity: data.h }, 
                { headers: { 'x-api-key': ADMIN_KEY, 'owner': 'Supplier_A' } }
            );
            
            console.log(`[Messung ${i+1}/10] Temp: ${data.t}°C -> Blockchain-Sync: ${res.data.blockchainSync} | Alarm: ${res.data.isAlarm}`);
            
            // Ganz kurze Pause (optional), damit die Zeitstempel minimal variieren
            await new Promise(r => setTimeout(r, 500)); 
        }

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