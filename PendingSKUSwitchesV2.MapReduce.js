/**
 * @NApiVersion 2.0
 * @NScriptType MapReduceScript
 */
define([
    'N/record',
    'N/search',
    'N/runtime'

], function (
    record,
    search,
    runtime
){
    return {
        getInputData: function () {
            if (runtime.envType != runtime.EnvType.PRODUCTION) return;

            return search.load({id: 'customsearch888'})
        },

        subscriptionSkusMap: {
            1250: 439,
            1251: 607,
            1246: 507,
            1247: 508,
            1248: 451,
            1249: 606,
            2287: 372,
            2286: 372,
            2285: 372,
            439: 508
        },

        statSkusMap: {
            432: 433,
            508: 449,
            340: 341,
            436: 437
        },

        map: function (context) {
            var self = this,
                order = JSON.parse(context.value);

            if (order) {
                var orderJSON =  {
                    orderId: order.id,
                    status: order.values['custbody2']
                }

                var rec = record.load({
                        type: 'salesorder',
                        id: parseInt(order.id),
                        isDynamic: true
                    }),
                    count = rec.getLineCount({
                        sublistId: 'item'
                    });
    
                for (var i = 0; i < count; i++) {
                    rec.selectLine({
                        sublistId: 'item',
                        line: i
                    });
                    var netsuiteId = rec.getCurrentSublistValue({
                            sublistId: 'item',
                            fieldId: 'item'
                        }),
                        rate = rec.getCurrentSublistValue({
                            sublistId: 'item',
                            fieldId: 'rate'
                        }),
                        quantity = rec.getCurrentSublistValue({
                            sublistId: 'item',
                            fieldId: 'quantity'
                        }),
                        subscription = false,
                        stat = false;

                    if (self.subscriptionSkusMap[netsuiteId]) {
                        var prevItemId = netsuiteId;

                        netsuiteId = self.subscriptionSkusMap[netsuiteId];
                        subscription = true;
                    } else if (self.statSkusMap[netsuiteId]) {
                        var prevItemId = netsuiteId;

                        netsuiteId = self.statSkusMap[netsuiteId];
                        stat = true;
                    }

                    if (subscription || stat) {
                        rec.setCurrentSublistValue({
                            sublistId: 'item',
                            fieldId: 'item',
                            value: netsuiteId
                        });
                        rec.setCurrentSublistValue({
                            sublistId: 'item',
                            fieldId: 'rate',
                            value: rate
                        });
                        rec.setCurrentSublistValue({
                            sublistId: 'item',
                            fieldId: 'quantity',
                            value: quantity
                        });

                        var itemFields = search.lookupFields({
                                type: 'item',
                                id: prevItemId,
                                columns: ['itemid']
                            });

                        log.debug('itemFields', itemFields)

                        rec.setCurrentSublistValue({
                            sublistId: 'item',
                            fieldId: 'custcol10',
                            value: itemFields.itemid
                        });

                        rec.commitLine({
                            sublistId: 'item',
                            line: i
                        });
                    }
                }

                rec.save();

                context.write(
                    JSON.stringify(orderJSON)
                );
            }
        },

        summarize: function (summary) {
            if (runtime.envType != runtime.EnvType.PRODUCTION) return;

            if (summary.inputSummary.error)
                log.debug('Input Error', summary.inputSummary.error);

            // Log errors if any
            var errors = [];

            summary.mapSummary.errors.iterator().each(function (key, error) {
                errors.push(error);

                return true;
            });

            log.debug('errors', errors);

            // Generate Order List to Update
            var orders = [];

            summary.output.iterator().each(function (key, value) {
                key = JSON.parse(key);

                orders.push(key);

                return true;
            });

            log.debug('Results', 'Orders Processed: ' + orders.length);

        }
    };
});
