const axios = require('axios');
const BASE_URL = 'http://localhost:3000'; 
const ADMIN_KEY = 'MASTER_ADMIN_2026';

const SEED_CONFIG = {
    suppliers: [
        // EUROPA (3)
        { name: 'Logistik_Pro_A', key: 'KEY_PRO_A', start: { lat: 48.1351, lon: 11.5820 }, scenario: 'PERFECT', region: 'EU' },
        { name: 'Kühl_Express_B', key: 'KEY_EXPRESS_B', start: { lat: 53.5511, lon: 9.9937 }, scenario: 'CRITICAL_SPIKE', region: 'EU' },
        { name: 'Rhine_Trans_F', key: 'KEY_TRANS_F', start: { lat: 52.3676, lon: 4.9041 }, scenario: 'PERFECT', region: 'EU' }, // Amsterdam

        // NORDAMERIKA (3)
        { name: 'Atlantic_Cold_G', key: 'KEY_COLD_G', start: { lat: 40.7128, lon: -74.0060 }, scenario: 'SLOW_WARMING', region: 'NA' }, // NY
        { name: 'Pacific_Logix_H', key: 'KEY_LOGIX_H', start: { lat: 34.0522, lon: -118.2437 }, scenario: 'PERFECT', region: 'NA' }, // LA
        { name: 'Ontario_Fresh_I', key: 'KEY_FRESH_I', start: { lat: 43.6532, lon: -79.3832 }, scenario: 'DEEP_FREEZE', region: 'NA' }, // Toronto

        // SÜDAMERIKA (2)
        { name: 'Amazon_Fruit_J', key: 'KEY_FRUIT_J', start: { lat: -23.5505, lon: -46.6333 }, scenario: 'HUMIDITY_ALARM', region: 'SA' }, // São Paulo
        { name: 'Anden_Express_K', key: 'KEY_ANDEN_K', start: { lat: -33.4489, lon: -70.6693 }, scenario: 'CRITICAL_SPIKE', region: 'SA' }, // Santiago

        // ASIEN (2)
        { name: 'Silk_Road_L', key: 'KEY_SILK_L', start: { lat: 31.2304, lon: 121.4737 }, scenario: 'SLOW_WARMING', region: 'AS' }, // Shanghai
        { name: 'Tokyo_Safe_M', key: 'KEY_SAFE_M', start: { lat: 35.6762, lon: 139.6503 }, scenario: 'PERFECT', region: 'AS' }  // Tokio
    ],
    target: { lat: 49.5209, lon: 8.4267 }, // Ziel: BASF Zentrallager Ludwigshafen
    readingsPerDelivery: 40,
    deliveriesPerSupplier: 2 
};

function getScenarioData(scenario, step, totalSteps) {
    let temp = 4.0 + (Math.random() * 1.5); 
    let hum = 45.0 + (Math.random() * 5.0); 

    switch(scenario) {
        case 'PERFECT': 
            temp = 4.2 + (Math.random() * 0.8); 
            break;
        case 'CRITICAL_SPIKE': 
            if (step > 15 && step < 25) temp = 14.0 + Math.random();
            break;
        case 'SLOW_WARMING': 
            temp = 4 + (8 * (step / totalSteps)) + Math.random();
            break;
        case 'DEEP_FREEZE': 
            if (step > 20) temp = 0.2 + (Math.random() * 0.5);
            break;
        case 'HUMIDITY_ALARM': 
            if (step > 25) hum = 85.0 + (Math.random() * 8.0);
            break;
    }
    return { 
        temperature: parseFloat(temp.toFixed(2)), 
        humidity: parseFloat(hum.toFixed(2)) 
    };
}

async function runSeed() {
    try {
        console.log("STARTE SEEDING");

        for (const s of SEED_CONFIG.suppliers) {
            console.log(`\n Region: ${s.region} | Lieferant: ${s.name}`);

            // 1. Onboard Supplier (Admin Route) [cite: 1, 4]
            await axios.post(`${BASE_URL}/api/admin/onboard-supplier`, 
                { supplierName: s.name, password: '123', apiKey: s.key }, 
                { headers: { 'x-api-key': ADMIN_KEY } });

            for (let d = 1; d <= SEED_CONFIG.deliveriesPerSupplier; d++) {
                const deliveryId = `DEL-${s.name}-${d}`;
                const sensorId = `ESP-${s.name}-${d}`;

                // 2. Onboard Delivery (Supplier Route)
                await axios.post(`${BASE_URL}/api/supplier/onboard`, 
                    { hardwareId: sensorId, deliveryId }, 
                    { headers: { 'x-api-key': s.key } });

                // 3. Set Limits
                await axios.post(`${BASE_URL}/api/supplier/set-limit/${deliveryId}`, 
                    { maxTemp: 8.0, minTemp: 2.0, maxHum: 70.0, minHum: 30.0 }, 
                    { headers: { 'x-api-key': s.key } });

                // 4. Generate Readings
                for (let r = 0; r < SEED_CONFIG.readingsPerDelivery; r++) {
                    const progress = r / (SEED_CONFIG.readingsPerDelivery - 1);
                    const data = getScenarioData(s.scenario, r, SEED_CONFIG.readingsPerDelivery);
                    
                    const currentLat = s.start.lat + (SEED_CONFIG.target.lat - s.start.lat) * progress;
                    const currentLon = s.start.lon + (SEED_CONFIG.target.lon - s.start.lon) * progress;

                    await axios.post(`${BASE_URL}/api/buffer`, {
                        sensorId: sensorId,
                        temperature: data.temperature,
                        humidity: data.humidity,
                        lat: parseFloat(currentLat.toFixed(4)),
                        lon: parseFloat(currentLon.toFixed(4)),
                        timestamp: new Date().toISOString()
                    }, { headers: { 'x-api-key': s.key } });
                }

                // 5. Checkout
                await axios.post(`${BASE_URL}/api/admin/confirm-receipt/${s.name}/${deliveryId}`, 
                    { recipientName: "BASF Ludwigshafen" }, { headers: { 'x-api-key': ADMIN_KEY } });
                await axios.post(`${BASE_URL}/api/admin/final-checkout/${s.name}/${deliveryId}`, 
                    {}, { headers: { 'x-api-key': ADMIN_KEY } });
                
                console.log(` Lieferung ${deliveryId} abgeschlossen.`);
            }
        }
        console.log("SEEDING BEENDET");
    } catch (e) { 
        console.error("❌ Fehler:", e.response ? JSON.stringify(e.response.data) : e.message);
    }
}

runSeed();