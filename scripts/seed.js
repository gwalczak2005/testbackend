const axios = require('axios');

// Falls dein Server auf einer anderen IP läuft, hier anpassen (z.B. 192.168.1.200)
const BASE_URL = 'http://localhost:3000'; 
const ADMIN_KEY = 'MASTER_ADMIN_2026';

const SEED_CONFIG = {
    suppliers: [
        { name: 'Logistik_Pro_A', key: 'KEY_PRO_A' },
        { name: 'Kühl_Express_B', key: 'KEY_EXPRESS_B' },
        { name: 'Global_Transport_C', key: 'KEY_TRANS_C' },
        { name: 'Med_Logistix_D', key: 'KEY_MED_D' },
        { name: 'Food_Safety_E', key: 'KEY_FOOD_E' }
    ],
    deliveriesPerSupplier: 1,
    readingsPerDelivery: 5
};

async function runSeed() {
    try {
        console.log("🚀 Starte automatisiertes Seeding basierend auf Workflow...");

        for (const s of SEED_CONFIG.suppliers) {
            console.log(`\n--- Bearbeite Supplier: ${s.name} ---`);

            // SCHRITT 1: Lieferant im System aufnehmen (ADMIN-AKTION)
            console.log(`👤 Onboarding Supplier...`);
            await axios.post(`${BASE_URL}/api/admin/onboard-supplier`, {
                supplierName: s.name,
                password: 'start123',
                apiKey: s.key
            }, { headers: { 'x-api-key': ADMIN_KEY } });

            for (let d = 1; d <= SEED_CONFIG.deliveriesPerSupplier; d++) {
                const deliveryId = `DEL-${s.name}-${d}`;
                const sensorHardwareId = `ESP-${s.name}-${d}`;

                // SCHRITT 2: Lieferung registrieren (SUPPLIER-AKTION)
                console.log(`📦 Registriere Lieferung: ${deliveryId}`);
                await axios.post(`${BASE_URL}/api/supplier/onboard`, {
                    hardwareId: sensorHardwareId, // Korrekt: hardwareId laut deinem .http Script
                    deliveryId: deliveryId
                }, { headers: { 'x-api-key': s.key } });

                // SCHRITT 3: Grenzwerte versiegeln (SUPPLIER-AKTION)
                console.log(`⚖️ Setze Grenzwerte für ${deliveryId}...`);
                await axios.post(`${BASE_URL}/api/supplier/set-limit/${deliveryId}`, {
                    maxTemp: 8.0,
                    minTemp: 2.0,
                    maxHum: 60.0,
                    minHum: 40.0
                }, { headers: { 'x-api-key': s.key } });

                // SCHRITT 4: Sensordaten einspeisen (ESP-SIMULATION)
                for (let r = 1; r <= SEED_CONFIG.readingsPerDelivery; r++) {
                    const payload = {
                        sensorId: sensorHardwareId, // Laut deinem .http Schritt 4 ist es sensorId
                        temperature: parseFloat((4 + Math.random() * 2).toFixed(2)),
                        humidity: parseFloat((45 + Math.random() * 5).toFixed(2)),
                        lat: 52.5200,
                        lon: 13.4050,
                        timestamp: new Date().toISOString()
                    };

                    console.log(`📡 Sende Messwert ${r}/${SEED_CONFIG.readingsPerDelivery} für ${deliveryId}`);
                    await axios.post(`${BASE_URL}/api/buffer`, payload, { 
                        headers: { 'x-api-key': s.key } 
                    });
                    
                    await new Promise(res => setTimeout(res, 100));
                }

                // SCHRITT 8: Erhalt bestätigen (ADMIN-AKTION)
                console.log(`🤝 Bestätige Erhalt...`);
                await axios.post(`${BASE_URL}/api/admin/confirm-receipt/${s.name}/${deliveryId}`, {
                    recipientName: "Zentrallager Automatik"
                }, { headers: { 'x-api-key': ADMIN_KEY } });

                // SCHRITT 9: Lieferung finalisieren (ADMIN-AKTION)
                console.log(`🏁 Finaler Checkout für ${deliveryId}...`);
                await axios.post(`${BASE_URL}/api/admin/final-checkout/${s.name}/${deliveryId}`, 
                    {}, { headers: { 'x-api-key': ADMIN_KEY } }
                );
            }
        }

        console.log("\n✅ Seeding erfolgreich beendet! Alle 5 Supplier und Lieferungen sind im System.");
    } catch (error) {
        const errorMsg = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error("❌ Fehler beim Seeding:", errorMsg);
    }
}

runSeed();