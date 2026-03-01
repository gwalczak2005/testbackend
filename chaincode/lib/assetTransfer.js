'use strict';

const stringify = require('json-stringify-deterministic');
const { Contract } = require('fabric-contract-api');

class AssetTransfer extends Contract {

    // Prüft, ob ein Asset bereits existiert
    async AssetExists(ctx, id) {
        const assetJSON = await ctx.stub.getState(id);
        return assetJSON && assetJSON.length > 0;
    }

    // Initialisierung des Ledgers
    async InitLedger(ctx) {
        console.info('============= Ledger Initialisiert ===========');
    }

    // Setzt spezifische Grenzwerte für eine Lieferung (Soll-Werte)
    async SetLimit(ctx, supplierName, deliveryId, maxTemp, minTemp, maxHum, minHum) {
        const limitKey = ctx.stub.createCompositeKey('limit', [supplierName, deliveryId]);
        
        const limitEntry = {
            Supplier: supplierName,
            DeliveryID: deliveryId,
            MaxTemp: parseFloat(maxTemp),
            MinTemp: parseFloat(minTemp),
            MaxHum: parseFloat(maxHum),
            MinHum: parseFloat(minHum),
            UpdatedAt: new Date((ctx.stub.getTxTimestamp().seconds.low) * 1000).toISOString()
        };

        await ctx.stub.putState(limitKey, Buffer.from(stringify(limitEntry)));
        return JSON.stringify(limitEntry);
    }

    // Erstellt einen neuen Messpunkt (Ist-Werte) und prüft gegen die Limits
    async CreateAsset(ctx, id, sensorId, temperature, humidity, supplierName, deliveryId) {
        // 1. Composite Key für das Asset bauen
        const compositeKey = ctx.stub.createCompositeKey('asset', [supplierName, deliveryId, id]);

        // 2. DYNAMISCHES LIMIT ABHOLEN
        const limitKey = ctx.stub.createCompositeKey('limit', [supplierName, deliveryId]);
        const limitBuffer = await ctx.stub.getState(limitKey);
        
        let isWarning = false;
        let appliedLimits = "None"; 

        const t = parseFloat(temperature);
        const h = parseFloat(humidity);

        // Prüfung gegen geladene Limits
        if (limitBuffer && limitBuffer.length > 0) {
            const limitData = JSON.parse(limitBuffer.toString());
            
            if (t > limitData.MaxTemp || t < limitData.MinTemp || 
                h > limitData.MaxHum || h < limitData.MinHum) {
                isWarning = true;
            }
            appliedLimits = JSON.stringify(limitData);
        } else {
            // Fallback: Wenn kein Limit gesetzt wurde, prüfe gegen Standardwert (30 Grad)
            if (t > 30.0) isWarning = true;
        }

        // 3. Das Asset-Objekt erstellen
        const asset = {
            ID: id,
            SensorID: sensorId,
            Temperature: t, 
            Humidity: h,
            Supplier: supplierName,
            DeliveryID: deliveryId,
            IsWarning: isWarning,
            AppliedLimits: appliedLimits,
            Timestamp: new Date((ctx.stub.getTxTimestamp().seconds.low) * 1000).toISOString(),
        };

        // 4. Im Ledger speichern
        await ctx.stub.putState(compositeKey, Buffer.from(stringify(asset)));
        
        return JSON.stringify(asset);
    }

    // Schnellsuche für einen Lieferanten
    async GetAssetsBySupplier(ctx, supplierName) {
        const iterator = await ctx.stub.getStateByPartialCompositeKey('asset', [supplierName]);
        return await this._getAllResults(iterator);
    }

    // Gibt ALLE Messpunkte zurück (über alle Lieferanten hinweg)
    async GetAllAssets(ctx) {
        const iterator = await ctx.stub.getStateByPartialCompositeKey('asset', []);
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

    async ConfirmDelivery(ctx, supplierName, deliveryId, recipientName) {
    const statusKey = ctx.stub.createCompositeKey('status', [supplierName, deliveryId]);
    
    const confirmation = {
        Supplier: supplierName,
        DeliveryID: deliveryId,
        Recipient: recipientName,
        Status: 'DELIVERED',
        ConfirmedAt: new Date((ctx.stub.getTxTimestamp().seconds.low) * 1000).toISOString()
    };

    await ctx.stub.putState(statusKey, Buffer.from(JSON.stringify(confirmation)));
    return JSON.stringify(confirmation);
}
}

module.exports = AssetTransfer;