const grpc = require('@grpc/grpc-js');
const { connect, signers } = require('@hyperledger/fabric-gateway');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const walletPath = path.resolve(__dirname, '..', 'wallet', 'org1-admin');
const certPath = path.join(walletPath, 'msp', 'signcerts', 'cert.pem');
const keyDirectoryPath = path.join(walletPath, 'msp', 'keystore');
const tlsCertPath = path.join(walletPath, 'tls', 'ca.crt');

let gateway;
let contract;
let client; //gRPC Client global halten, um bei Bedarf zu schließen
let messageCounter = 0;


async function initBlockchain() {
    try {
        if (gateway) gateway.close();
        if (client) client.close();

        const tlsRootCert = fs.readFileSync(tlsCertPath);
        client = new grpc.Client('localhost:7051', grpc.credentials.createSsl(tlsRootCert), {
            'grpc.keepalive_time_ms': 120000,
            'grpc.http2.min_time_between_pings_ms': 120000,
        });

        const files = fs.readdirSync(keyDirectoryPath);
        const keyFile = files.find(file => file.endsWith('_sk'));
        const privateKeyPem = fs.readFileSync(path.join(keyDirectoryPath, keyFile));

        gateway = await connect({
            client,
            identity: { mspId: 'Org1MSP', credentials: fs.readFileSync(certPath) },
            signer: signers.newPrivateKeySigner(crypto.createPrivateKey(privateKeyPem)),
        });

        const network = gateway.getNetwork('mychannel');
        contract = network.getContract('basic');
        
        console.log("✅ Blockchain-Gateway initialisiert.");
    } catch (error) {
        console.error("❌ Kritischer Fehler bei Blockchain-Init:", error.message);
        contract = null; // Signalisiert anderen Funktionen, dass wir offline sind
    }
}



// Kapselung der Blockchain
async function syncToBlockchain(logId, sensorData, mapping) {
    // 1. Daten extrahieren
    const { uniqueId, temp, humidity, lat, lon, measurementTime } = sensorData;
    const { supplier_name, delivery_id } = mapping;

    // 2. Asset-ID generieren
    const bcAssetId = `LOG-${Math.floor(Date.now() / 1000)}-${logId}`;

    try {
        // 3. Blockchain-Verbindung prüfen
        if (!contract) {
            console.log("🔗 Initialisiere Blockchain-Verbindung für Sync...");
            await initBlockchain();
            if (!contract) {
                throw new Error("Blockchain-Gateway konnte nicht initialisiert werden.");
            }
        }

        console.log(`\n🔗 BLOCKCHAIN: Sende validierte Daten für ${supplier_name} (${delivery_id})...`);

        // 4. Transaktion an Hyperledger Fabric übermitteln (10 Parameter)
        await contract.submitTransaction(
            'CreateAsset', 
            bcAssetId, 
            uniqueId, 
            temp.toString(), 
            humidity.toString(),
            supplier_name, 
            delivery_id, 
            measurementTime, 
            lat ? lat.toString() : "0.0", 
            lon ? lon.toString() : "0.0"
        );
        
        console.log(`✅ Blockchain-Sync erfolgreich: ${bcAssetId}`);
        return { success: true, assetId: bcAssetId };

    } catch (error) {
        console.error(`❌ Blockchain-Sync fehlgeschlagen für ${bcAssetId}:`, error.message);
        
        // Bei Verbindungsfehlern contract zurücksetzen
        if (error.message.includes('14') || error.message.includes('closed') || error.message.includes('unavailable')) {
            contract = null;
        }
        
        return { success: false, assetId: bcAssetId };
    } 
}



module.exports = {
    initBlockchain,
    syncToBlockchain,
    getContract: () => contract
};