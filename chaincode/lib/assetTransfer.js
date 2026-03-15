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
    async CreateAsset(ctx, id, sensorId, temperature, humidity, supplierName, deliveryId, originalTimestamp, lat, lon) {
        // 1. Composite Key für das Asset bauen
        const compositeKey = ctx.stub.createCompositeKey('asset', [supplierName, deliveryId, id]);
        
        // --- HARD-LOCK FÜR GESCHLOSSENE LIEFERUNGEN ---
        const statusKey = ctx.stub.createCompositeKey('status', [supplierName, deliveryId]);
        const statusBuffer = await ctx.stub.getState(statusKey);
        
        if (statusBuffer && statusBuffer.length > 0) {
            const statusData = JSON.parse(statusBuffer.toString());
            if (statusData.Status === 'CLOSED') {
                throw new Error(`TRANSAKTION ABGELEHNT: Lieferung ${deliveryId} ist bereits versiegelt (CLOSED).`);
            }
        }

        // 2. DATEN PARSEN & LIMITS PRÜFEN
        const t = parseFloat(temperature);
        const h = parseFloat(humidity);
        const latitude = parseFloat(lat) || 0.0; // Fallback auf 0.0 falls leer
        const longitude = parseFloat(lon) || 0.0;

        const limitKey = ctx.stub.createCompositeKey('limit', [supplierName, deliveryId]);
        const limitBuffer = await ctx.stub.getState(limitKey);
        
        let isWarning = false;
        let appliedLimits = "None"; 

        if (limitBuffer && limitBuffer.length > 0) {
            const limitData = JSON.parse(limitBuffer.toString());
            if (t > limitData.MaxTemp || t < limitData.MinTemp || 
                h > limitData.MaxHum || h < limitData.MinHum) {
                isWarning = true;
            }
            appliedLimits = JSON.stringify(limitData);
        } else {
            if (t > 30.0) isWarning = true;
        }

        // 3. Das Asset-Objekt erstellen (inklusive GPS)
        const asset = {
            ID: id,
            SensorID: sensorId,
            Temperature: t, 
            Humidity: h,
            Latitude: latitude,  // <-- NEU
            Longitude: longitude, // <-- NEU
            Supplier: supplierName,
            DeliveryID: deliveryId,
            IsWarning: isWarning,
            AppliedLimits: appliedLimits,
            Timestamp: originalTimestamp,
            TxRecordedAt: new Date((ctx.stub.getTxTimestamp().seconds.low) * 1000).toISOString(),
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

    //Proof-of-Delivery
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

    //Registrierung eines neuen Suppliers im Framework
    async RegisterSupplier(ctx, supplierName, organizationDetails) {
    const exists = await this.AssetExists(ctx, `SUPPLIER_${supplierName}`);
    if (exists) {
        throw new Error(`Der Lieferant ${supplierName} ist bereits auf der Blockchain registriert.`);
    }

    const supplierAsset = {
        ID: `SUPPLIER_${supplierName}`,
        Type: 'SUPPLIER',
        Name: supplierName,
        OrgDetails: organizationDetails,
        Status: 'ACTIVE',
        RegisteredAt: new Date((ctx.stub.getTxTimestamp().seconds.low) * 1000).toISOString()
    };

    // Speichern im World State der Blockchain
    await ctx.stub.putState(supplierAsset.ID, Buffer.from(JSON.stringify(supplierAsset)));
    return JSON.stringify(supplierAsset);
    }
}

module.exports = AssetTransfer;