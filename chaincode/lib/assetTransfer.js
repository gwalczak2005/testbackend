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
    async CreateAsset(ctx, id, sensorId, temperature, humidity, supplierName, deliveryId, originalTimestamp) {
        // 1. Composite Key für das Asset bauen
        const compositeKey = ctx.stub.createCompositeKey('asset', [supplierName, deliveryId, id]);
        
        // --- NEU: HARD-LOCK FÜR GESCHLOSSENE LIEFERUNGEN ---
        const statusKey = ctx.stub.createCompositeKey('status', [supplierName, deliveryId]);
        const statusBuffer = await ctx.stub.getState(statusKey);
        
        if (statusBuffer && statusBuffer.length > 0) {
            const statusData = JSON.parse(statusBuffer.toString());
            if (statusData.Status === 'CLOSED') {
                throw new Error(`TRANSAKTION ABGELEHNT: Lieferung ${deliveryId} ist bereits versiegelt (CLOSED). Keine neuen Messwerte erlaubt.`);
            }
        }
        // -------------------------------------------------------------

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
                    Timestamp: originalTimestamp, // <-- NEU: Die echte Zeit der Messung aus SQLite
                    TxRecordedAt: new Date((ctx.stub.getTxTimestamp().seconds.low) * 1000).toISOString(), // Optional: Wann es wirklich in die Blockchain ging
        };

        // 4. Im Ledger speichern
        await ctx.stub.putState(compositeKey, Buffer.from(JSON.stringify(asset)));
        
        return JSON.stringify(asset);
    }

    // Schnellsuche für einen Lieferanten
    async GetAssetsBySupplier(ctx, supplierName) {
        const iterator = await ctx.stub.getStateByPartialCompositeKey('asset', [supplierName]);
        return await this._getAllResults(iterator);
    }

    // Sucht alle Messwerte für eine spezifische Lieferung eines Lieferanten
    async GetAssetsByDelivery(ctx, supplierName, deliveryId) {
    // Wir nutzen den Teil-Key, um alle IDs unter dieser Lieferung zu finden
    const iterator = await ctx.stub.getStateByPartialCompositeKey('asset', [supplierName, deliveryId]);
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
                const rawStr = res.value.value.toString('utf8');
                
                // WICHTIG: Ein try-catch innerhalb der Schleife!
                // Falls ein Asset mal kein valides JSON ist, überspringen wir es einfach,
                // statt die gesamte Transaktion abstürzen zu lassen.
                try {
                    const jsonRecord = JSON.parse(rawStr);
                    allResults.push(jsonRecord);
                } catch (err) {
                    console.log(`⚠️ Fehler beim Parsen eines Datensatzes: ${rawStr}`, err);
                    // Optional: Den rohen String pushen, falls es kein JSON ist
                    // allResults.push(rawStr); 
                }
            }
            res = await iterator.next();
        }
        await iterator.close();
        
        // Gibt ein garantiert valides JSON-Array als String zurück
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

    // Versiegelt eine Lieferung endgültig auf der Blockchain
    async FinalizeDelivery(ctx, supplierName, deliveryId) {
        const statusKey = ctx.stub.createCompositeKey('status', [supplierName, deliveryId]);
        
        const finalStatus = {
            Supplier: supplierName,
            DeliveryID: deliveryId,
            Status: 'CLOSED',
            ClosedAt: new Date((ctx.stub.getTxTimestamp().seconds.low) * 1000).toISOString()
        };

        // Überschreibt den bisherigen Status (z.B. DELIVERED) mit CLOSED
        await ctx.stub.putState(statusKey, Buffer.from(JSON.stringify(finalStatus)));
        return JSON.stringify(finalStatus);
    }
}

module.exports = AssetTransfer;