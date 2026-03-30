const axios = require('axios');
const BASE_URL = 'http://localhost:3000'; 
const ADMIN_KEY = 'MASTER_ADMIN_2026';

const SEED_CONFIG = {
    suppliers: [
        { 
            name: 'Logistik_Pro_A', 
            key: 'KEY_PRO_A', 
            start: { lat: 48.1351, lon: 11.5820 }, // München
            scenario: 'PERFECT',
            desc: "Vorzeigelieferant: Konstante 4-5 Grad."
        },
        { 
            name: 'Kühl_Express_B', 
            key: 'KEY_EXPRESS_B', 
            start: { lat: 53.5511, lon: 9.9937 },  // Hamburg
            scenario: 'CRITICAL_SPIKE',
            desc: "Defekte Tür: Temperatur steigt kurz auf 12 Grad."
        },
        { 
            name: 'Global_Transport_C', 
            key: 'KEY_TRANS_C', 
            start: { lat: 52.5095, lon: 13.4288 }, // Berlin (Neu)
            scenario: 'SLOW_WARMING',
            desc: "Kühlaggregat schwach: Steigt am Ende auf 10 Grad."
        },
        { 
            name: 'Med_Logistix_D', 
            key: 'KEY_MED_D', 
            start: { lat: 50.1109, lon: 8.6821 },  // Frankfurt
            scenario: 'DEEP_FREEZE',
            desc: "Fehlsteuerung: Fällt unter 1 Grad."
        },
        { 
            name: 'Food_Safety_E', 
            key: 'KEY_FOOD_E', 
            start: { lat: 48.7758, lon: 9.1829 },  // Stuttgart
            scenario: 'HUMIDITY_ALARM',
            desc: "Wasserschaden: Luftfeuchtigkeit springt auf 90%."
        }
    ],
    target: { lat: 49.5209, lon: 8.4267 }, // Ziel: BASF Ludwigshafen (Neu)
    readingsPerDelivery: 50
};

function getScenarioData(scenario, step, totalSteps) {
    let temp = 5.0;
    let hum = 50.0;
    switch(scenario) {
        case 'PERFECT': temp = 4.5 + Math.random(); break;
        case 'CRITICAL_SPIKE': temp = (step > 20 && step < 30) ? 12.5 : 4.5; break;
        case 'SLOW_WARMING': temp = 4 + (7 * (step / totalSteps)); break;
        case 'DEEP_FREEZE': temp = (step > 25) ? 0.5 : 4.0; break;
        case 'HUMIDITY_ALARM': temp = 5.0; hum = (step > 35) ? 92.0 : 50.0; break;
    }
    return { temperature: parseFloat(temp.toFixed(2)), humidity: parseFloat(hum.toFixed(2)) };
}

async function runSeed() {
    try {
        console.log("🚀 Starte Seeding Richtung Ludwigshafen...");

        for (const s of SEED_CONFIG.suppliers) {
            console.log(`\n📦 Profil: ${s.name} (${s.scenario})`);

            // 1. Onboard Supplier
            await axios.post(`${BASE_URL}/api/admin/onboard-supplier`, 
                { supplierName: s.name, password: '123', apiKey: s.key }, 
                { headers: { 'x-api-key': ADMIN_KEY } });

            const deliveryId = `DEL-${s.name}-1`;
            const sensorId = `ESP-${s.name}-1`;

            // 2. Onboard Delivery
            await axios.post(`${BASE_URL}/api/supplier/onboard`, 
                { hardwareId: sensorId, deliveryId }, 
                { headers: { 'x-api-key': s.key } });

            // 3. Set Limits
            await axios.post(`${BASE_URL}/api/supplier/set-limit/${deliveryId}`, 
                { maxTemp: 8.0, minTemp: 2.0, maxHum: 70.0, minHum: 30.0 }, 
                { headers: { 'x-api-key': s.key } });

            // 4. Generate 50 Readings along the route
            for (let r = 0; r < SEED_CONFIG.readingsPerDelivery; r++) {
                const progress = r / (SEED_CONFIG.readingsPerDelivery - 1);
                const data = getScenarioData(s.scenario, r, SEED_CONFIG.readingsPerDelivery);
                
                // Route Calculation
                const currentLat = s.start.lat + (SEED_CONFIG.target.lat - s.start.lat) * progress;
                const currentLon = s.start.lon + (SEED_CONFIG.target.lon - s.start.lon) * progress;

                const payload = {
                    sensorId: sensorId,
                    temperature: data.temperature,
                    humidity: data.humidity,
                    lat: parseFloat(currentLat.toFixed(4)),
                    lon: parseFloat(currentLon.toFixed(4)),
                    timestamp: new Date().toISOString()
                };

                await axios.post(`${BASE_URL}/api/buffer`, payload, { headers: { 'x-api-key': s.key } });
                if (r % 10 === 0) console.log(`  ... ${r} Messwerte gesendet`);
            }
            
            // 5. Finalize
            await axios.post(`${BASE_URL}/api/admin/confirm-receipt/${s.name}/${deliveryId}`, 
                { recipientName: "BASF Ludwigshafen" }, { headers: { 'x-api-key': ADMIN_KEY } });
            await axios.post(`${BASE_URL}/api/admin/final-checkout/${s.name}/${deliveryId}`, 
                {}, { headers: { 'x-api-key': ADMIN_KEY } });
            
            console.log(`✅ ${s.name} erfolgreich abgeschlossen.`);
        }
        console.log("\n✨ Seeding beendet. Die Daten für das BASF-Zentrallager sind bereit.");
    } catch (e) { 
        console.error("❌ Fehler:", e.response ? JSON.stringify(e.response.data) : e.message);
    }
}

runSeed();