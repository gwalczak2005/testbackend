'use strict';

// Wir nutzen nur die absolut notwendige Bibliothek für deterministisches JSON
const stringify = require('json-stringify-deterministic');
const { Contract } = require('fabric-contract-api');

class AssetTransfer extends Contract {
    
    async AssetExists(ctx, id) {
    const assetJSON = await ctx.stub.getState(id);
    return assetJSON && assetJSON.length > 0;
}

    async InitLedger(ctx) {
        console.info('============= Ledger Initialisiert ===========');
    }

    async CreateAsset(ctx, id, sensorId, temperature, humidity, supplierName, deliveryId) {
        // 1. Den Composite Key erstellen
        // Wir nutzen "asset" als Objekttyp, um eine Namensraum-Trennung zu haben
        const compositeKey = ctx.stub.createCompositeKey('asset', [supplierName, deliveryId, id]);

        // Prüfen, ob dieser spezifische Key schon existiert
        const exists = await this.AssetExists(ctx, compositeKey);
        if (exists) {
            throw new Error(`Der Messpunkt ${id} existiert bereits für diese Lieferung.`);
        }

        // ... (Logik für Limits & Warnings bleibt gleich) ...
        const tempNumber = parseFloat(temperature);
        const isWarning = tempNumber > 30; // Später dynamisch!

        const asset = {
            ID: id,
            SensorID: sensorId,
            Temperature: tempNumber,
            Humidity: parseFloat(humidity),
            Supplier: supplierName,
            DeliveryID: deliveryId,
            IsWarning: isWarning,
            Timestamp: new Date((ctx.stub.getTxTimestamp().seconds.low) * 1000).toISOString(),
        };

        // Wir speichern das Asset unter dem Composite Key
        await ctx.stub.putState(compositeKey, Buffer.from(stringify(asset)));
        return JSON.stringify({ ...asset, CompositeKey: compositeKey });
    }

    // NEU: Schnellsuche für einen Lieferanten
    async GetAssetsBySupplier(ctx, supplierName) {
        const iterator = await ctx.stub.getStateByPartialCompositeKey('asset', [supplierName]);
        return await this._getAllResults(iterator);
    }

    // Interne Hilfsfunktion für die Iteratoren
    async _getAllResults(iterator) {
        const allResults = [];
        let res = await iterator.next();
        while (!res.done) {
            if (res.value && res.value.value.toString()) {
                allResults.push(JSON.parse(res.value.value.toString('utf8')));
            }
            res = await iterator.next();
        }
        await iterator.close();
        return JSON.stringify(allResults);
    }
}
module.exports = AssetTransfer;