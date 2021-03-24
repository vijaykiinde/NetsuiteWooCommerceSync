/**
 * @NApiVersion 2.0
 * @NScriptType MapReduceScript
 * @NAmdConfig /SuiteScripts/SuiteScript.Configuration.json
 */

define([
    'N/record',
    'N/search',
    'N/https',
    'N/runtime',
    'N/email',

    'moment',
    'underscore'
], function (
    record,
    search,
    https,
    runtime,
    email,

    moment,
    _
){
    return {
        getBaseUrl: function() {
            if (runtime.envType == runtime.EnvType.PRODUCTION)
                return '[WORDPRESS_PROD_URL]/wp-json/wc/v3';
            else
                return '[WORDPRESS_STAGING_URL]/wp-json/wc/v3'
        },

        getAuthToken: function() {
            if (runtime.envType == runtime.EnvType.PRODUCTION)
                return '[REST_PROD_AUTH_TOKEN]';
            else
                return '[REST_STAGING_AUTH_TOKEN]'
        },

        getInputData: function () {
            var getRequest = https.get({
                    url: this.getBaseUrl() + '/getOrdersToBeSynced',
                    headers: {
                        'Authorization': 'Basic ' + this.getAuthToken(),
                        'Content-Type': 'application/json',
                        'Connection': 'keep-alive',
                        'Accept': '*/*'
                    }
                });

            log.debug('Response', getRequest);

            var body = JSON.parse(getRequest.body);

            log.debug('Response', 'Loaded Records: ' + body.length);

            return body;
        },

        map: function (context) {
            var orderId = JSON.parse(context.value),
                getRequest = https.get({
                url: this.getBaseUrl() + '/orders/' + orderId,
                headers: {
                    'Authorization': 'Basic ' + this.getAuthToken(),
                    'Content-Type': 'application/json',
                    'Connection': 'keep-alive',
                    'Accept': '*/*'
                }
            });

            log.debug('Response', getRequest);

            var order = JSON.parse(getRequest.body);

            log.debug('record', order);

            if (order && order.id) {
                // Verify if exists
                var salesorderSearchObj = search.create({
                    type: 'salesorder',
                    filters:
                    [
                       ['mainline', 'is', 'T'],
                       'AND', 
                       ['type', 'anyof', 'SalesOrd'], 
                       'AND', 
                       ['custbody_wordpress_id', 'equalto', order.id]
                    ],
                    columns:
                    [
                       search.createColumn({name: 'internalid', label: 'Internal ID'})
                    ]
                 });
                salesOrderResultCount = salesorderSearchObj.runPaged().count;

                log.debug('salesOrderResultCount', 'SalesOrder: ' + salesOrderResultCount);
     
                // Verify Entity
                order = this.processEntity(order);

                // Verify Promotions
                if (order.coupon_lines.length)
                    order = this.processPromotions(order);

                if (!salesOrderResultCount) {
                    log.debug('STEP', 'CREATE');
                    try {
                        if (order.line_items.length)
                            var netsuiteId = this.createSalesOrderRecord(order);
                    } catch (e) {
                        throw {
                            error: e.message,
                            order: order.id
                        };
                    }

                    log.debug('netsuiteId', netsuiteId);

                    if (netsuiteId) {
                        this.sendRecordToWordpress(order.id, netsuiteId);
                        if (order.status == 'cancelled' && order.status == 'failed') {
                            this.closeOrder(netsuiteId);
                        } else {
                            this.createCustomerDeposit(netsuiteId, order);
                        } 
                        
                        context.write(
                            JSON.stringify({
                                netsuiteId: netsuiteId
                            })
                        );
                    } else if (!order.line_items.length)
                        this.sendRecordToWordpress(order.id, -1);
                } else {
                    log.debug('STEP', 'UPDATE');

                    try {
                        var netsuiteId = null;

                        salesorderSearchObj.run().each(function(salesOrderObj) {
                            netsuiteId = salesOrderObj.id;
                        });
                        if (order.status != 'processing' && order.status != 'being-packed') {
                            log.debug('Update aborted', 'status ' + order.status);
    
                            // Send Skipped Record to Wordpress
                            this.sendRecordToWordpress(order.id, netsuiteId);

                            return;
                        } else {
                            this.updateSalesOrderRecord(netsuiteId, order);

                            if (order.status == 'cancelled' && order.status == 'failed')
                                this.closeOrder(netsuiteId);

                            if (netsuiteId) {
                                this.updateCustomerDeposit(netsuiteId);

                                this.verifyRefunds(netsuiteId, order);

                                log.debug('netsuiteId', netsuiteId);

                                // Send Successed Record to Wordpress
                                this.sendRecordToWordpress(order.id, netsuiteId);
        
                                context.write(
                                    JSON.stringify({
                                        netsuiteId: netsuiteId
                                    })
                                );
                            }
                        }
                    } catch (e) {
                        throw {
                            error: e.message,
                            order: order.id
                        };
                    }
                }
            }
        },

        getNetsuiteCustomerSearch: function(id) {
            return search.create({
                type: 'customer',
                filters:
                [
                    ['custentity_wordpress_id','equalto', id],
                ],
                columns:
                [
                    search.createColumn({
                        name: 'entityid',
                        sort: search.Sort.ASC,
                        label: 'ID'
                    }),
                    search.createColumn({name: 'custentity_wordpress_id', label: 'Wordpress Id'})
                ]
            });
        },

        processEntity: function(order) {
            var self = this,
                customerSearchObj = self.getNetsuiteCustomerSearch(order.customer_id);

            customerResultCount = customerSearchObj.runPaged().count;

            log.debug('customerSearchObj', 'Customer: ' + customerResultCount);
            if (customerResultCount) {
                customerSearchObj.run().each(function(customerObj) {
                    order.entityId = customerObj.id;
                });
            } else {
                if (order.customer_id) {
                    var getRequest = https.get({
                        url: this.getBaseUrl() + '/customers/' + order.customer_id,
                        headers: {
                            'Authorization': 'Basic ' + this.getAuthToken(),
                            'Content-Type': 'application/json',
                            'Connection': 'keep-alive',
                            'Accept': '*/*'
                        }
                    });

                    try {
                        order.entityId = self.createCustomerRecord(JSON.parse(getRequest.body));
                    } catch(e) {
                        log.debug('Customer', 'Customer Creation Fallback');
                        order.entityId = 2625; // Guest Order Fallback
                    }
                } else {
                    order.entityId = 2625;
                    log.debug('Customer', 'Guest Order');
                }
            }

            return order;
        },

        processPromotions: function(order) {
            var self = this,
                promotionIds = [];

            _.each(order.coupon_lines, function(coupon) {
                var couponSearchObj = search.create({
                    type: 'promotioncode',
                    filters:
                        [
                            ['name','is', coupon.code]
                        ],
                    columns:
                        [
                            search.createColumn({name: 'internalid', label: 'Internal ID'})
                        ]
                });

                promotionResultCount = couponSearchObj.runPaged().count;

                log.debug('couponSearchObj', 'Coupon: ' + promotionResultCount);
                if (promotionResultCount) {
                    couponSearchObj.run().each(function(couponObj) {
                        promotionIds.push(couponObj.id);
                    });
                } else {
                    var couponInfo = _.findWhere(coupon.meta_data, {key: 'coupon_data'}).value;

                    couponInfo.netsuite_product_ids = _.filter(coupon.netsuite_product_ids, function(id) { return !!id });
                    couponInfo.date_created = moment().toDate();
                    promotionIds.push(self.createCouponRecord(couponInfo));
                }
            });

            order.promotionIds = promotionIds;

            return order;
        },

        createCouponRecord: function(coupon) {
            var accountObj = _.findWhere(coupon.meta_data, {key: 'accounting_expense_account'}),
                expenseAccount = accountObj && accountObj.value ? accountObj.value : null;
                promotionFormTypeMap = {
                    percent: -10501,
                    fixed_cart: -10502,
                    fixed_product: -10501,
                    sign_up_fee: -10502,
                    sign_up_fee_percent: -10502,
                    recurring_fee: -10502,
                    recurring_percent: -10502
                }

            // Fallback for coupon without items
            if (!coupon.netsuite_product_ids.length)
                promotionFormTypeMap.percent = -10502;

            var promotionRecord = record.create({
                    type: 'promotioncode',
                    isDynamic: true
                });

            promotionRecord.setValue('customform', promotionFormTypeMap[coupon.discount_type]);
            promotionRecord.setValue('name', coupon.code);
            promotionRecord.setValue('code', coupon.code);
            promotionRecord.setValue('rate', coupon.amount);
            promotionRecord.setValue('custrecord_wordpress_id', coupon.id);
            if (coupon.date_created)
                promotionRecord.setValue('startdate', moment(coupon.date_created).toDate());
            if (coupon.date_expires)
                promotionRecord.setValue('enddate', moment(coupon.date_expires).toDate());
            promotionRecord.setValue('ispublic', true);
            promotionRecord.setValue('applydiscountto', 'ALLSALES');
            promotionRecord.setValue('usetype', 'MULTIPLEUSES');


            if (coupon.discount_type == 'percent' || coupon.discount_type == 'sign_up_fee_percent' || coupon.discount_type == 'recurring_percent')
                promotionRecord.setValue('discounttype', 'percent');
            else 
                promotionRecord.setValue('discounttype', 'flat');


            var discountItem = null;

            if (!expenseAccount)
                discountItem = 1245;
            else {
                var discountitemSearchObj = search.create({
                        type: 'discountitem',
                        filters:
                        [
                            ['type','anyof','Discount'],
                            'AND', 
                            ['name', 'is', expenseAccount]
                        ],
                        columns:
                        [
                            search.createColumn({name: 'internalid', label: 'Internal ID'}),
                        ]
                        }),
                    discountCountResult = discountitemSearchObj.runPaged().count;

                log.debug('discountItem', 'discountItem: ' + discountCountResult);
                discountitemSearchObj.run().each(function(discountItemRecord) {
                    discountItem = discountItemRecord.id;

                    return true;
                });
            }

            promotionRecord.setValue('discount', discountItem);

            log.debug('coupon.netsuite_product_ids', coupon.netsuite_product_ids);

            if (coupon.netsuite_product_ids.length) {
                promotionRecord.setValue('whatthecustomerneedstobuy', 'MINIMUMORDERAMOUNTORSPECIFICITEMS');
                promotionRecord.setValue('specificitemscheck', true);
                promotionRecord.setValue('itemquantifier', 1);

                coupon.netsuite_product_ids = _.uniq(coupon.netsuite_product_ids);
                _.each(coupon.netsuite_product_ids, function(itemId) {
                    promotionRecord.selectNewLine({ sublistId: 'items' });
                    promotionRecord.setCurrentSublistValue({ sublistId: 'items', fieldId: 'item', value: itemId });
                    promotionRecord.commitLine({ sublistId: 'items' });

                    if (coupon.discount_type !== 'fixed_cart') {
                        promotionRecord.selectNewLine({ sublistId: 'discounteditems' });
                        promotionRecord.setCurrentSublistValue({ sublistId: 'discounteditems', fieldId: 'discounteditem', value: itemId });
                        promotionRecord.commitLine({ sublistId: 'discounteditems' });
                    }
                });
            } else {
                promotionRecord.setValue('whatthecustomerneedstobuy', 'ANYTHING');
                promotionRecord.setValue('specificitemscheck', false);
            }

            try {
                return promotionRecord.save();
            } catch (e) {
                throw {
                    error: e,
                    coupon: coupon
                };
            }
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

        setLineItem: function(rec, line) {
            var netsuiteId = parseInt(line.netsuite_id),
                subscription = false,
                stat = false;

            // Hardcoded Fixes
            if (line.variation_id == 133314)
                netsuiteId = 1248;
            if (line.variation_id == 137799)
                netsuiteId = 1250;

            // SKU Switches if necessary
            if (this.subscriptionSkusMap[netsuiteId]) {
                var prevItemId = netsuiteId;

                netsuiteId = this.subscriptionSkusMap[netsuiteId];
                subscription = true;
 
            } else if (this.statSkusMap[netsuiteId]) {
                var prevItemId = netsuiteId;

                netsuiteId = this.statSkusMap[netsuiteId];
                stat = true;
            }

            rec.setCurrentSublistValue({
                sublistId: 'item',
                fieldId: 'item',
                value: netsuiteId
            });
            rec.setCurrentSublistValue({
                sublistId: 'item',
                fieldId: 'price',
                value: -1
            });
            rec.setCurrentSublistValue({
                sublistId: 'item',
                fieldId: 'quantity',
                value: line.quantity
            });
            rec.setCurrentSublistValue({
                sublistId: 'item',
                fieldId: 'rate',
                value: parseFloat(line.product_price)
            });
            rec.setCurrentSublistValue({
                sublistId: 'item',
                fieldId: 'custcol_wordpress_line_id',
                value: line.id
            });

            if (subscription) // Subscription Item Flag
                rec.setCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'custcol9',
                    value: true
                });

            if (subscription || stat) {
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
            }

            return rec;
        },

        createSalesOrderRecord: function(order) {
            var self = this,
                rec = record.create({
                    type: 'salesorder',
                    isDynamic: true
                });

            rec.setValue('customform', 151);
            if (runtime.envType == runtime.EnvType.PRODUCTION)
                rec.setValue('entity', order.entityId);
            else 
                rec.setValue('entity', 3226);
            rec.setValue('memo', 'WooCommerce Order');
            rec.setValue('status', 'Pending Approval');
            rec.setValue('terms', 7);
            rec.setValue('tobeemailed', false);
            rec.setValue('tobeprinted', false);
            rec.setValue('tobefaxed', false);
            rec.setValue('custbody_wordpress_id', order.id);

            shippingSubRecord = rec.getSubrecord('shippingaddress');
            shippingSubRecord.setValue('country', order.shipping.country);
            shippingSubRecord.setValue('addressee', order.shipping.first_name + ' ' + order.shipping.last_name);
            shippingSubRecord.setValue('addr1', order.shipping.address_1);
            shippingSubRecord.setValue('addr2', order.shipping.address_2);
            shippingSubRecord.setValue('addrphone', '');
            shippingSubRecord.setValue('city', order.shipping.city);
            shippingSubRecord.setValue('state', order.shipping.state);
            shippingSubRecord.setValue('zip', order.shipping.postcode);

            billingSubRecord = rec.getSubrecord('billingaddress');
            billingSubRecord.setValue('country', order.billing.country);
            billingSubRecord.setValue('addressee', order.billing.first_name + ' ' + order.billing.last_name);
            billingSubRecord.setValue('addr1', order.billing.address_1);
            billingSubRecord.setValue('addr2', order.billing.address_2);
            billingSubRecord.setValue('addrphone', '');
            billingSubRecord.setValue('city', order.billing.city);
            billingSubRecord.setValue('state', order.billing.state);
            billingSubRecord.setValue('zip', order.billing.postcode);

            var paymentMethodId = order.payment_method == 'braintree_credit_card' ? 10 : order.payment_method == 'braintree_paypal' ? 11 : 1;

            rec.setValue('paymentmethod', paymentMethodId);
            if (order.transaction_id)
                rec.setValue('custbody_payment_transaction_id', order.transaction_id);

            var shipMethod = null;

                _.each(order.shipping_lines, function(shipLine) {
                    if (shipLine.method_title === 'Free shipping'){
                        shipMethod = 712;
                    } else if (shipLine.method_title === 'Standard (4-8 business days)' || shipLine.method_title === 'Standard (3-5 days)') {
                        shipMethod = 712;
                    } else if (shipLine.method_title === 'Expedited (3-6 business days)') {
                        shipMethod = 714;
                    } else if (shipLine.method_title === 'Priority (2-3 business days)') {
                        shipMethod = 715;
                    }
                });

            if (shipMethod)
                rec.setValue('shipmethod', shipMethod);

            rec.setValue('shippingcost', parseFloat(order.shipping_total));

            log.debug('order.line_items', order.line_items);

            _.each(order.line_items, function(line) {
                rec.selectNewLine('item');

                rec = self.setLineItem(rec, line);

                rec.getCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'item'
                });

                rec.commitLine('item');
            });

            order.total_tax = parseFloat(order.total_tax);

            // log.debug('order.total_tax', order.total_tax);

            _.each(order.promotionIds, function(promotionId) {
                rec.selectNewLine('promotions');

                rec.setCurrentSublistValue({
                    sublistId: 'promotions',
                    fieldId: 'promocode',
                    value: promotionId
                });

                rec.commitLine('promotions');
            });


            return rec.save();
        },

        updateSalesOrderRecord: function(netsuiteId, order) {
            var self = this,
                rec = record.load({
                    id: netsuiteId,
                    type: 'salesorder',
                    isDynamic: true
                });

            rec.setValue('entity', order.entityId);

            shippingSubRecord = rec.getSubrecord('shippingaddress');
            shippingSubRecord.setValue('country', order.shipping.country);
            shippingSubRecord.setValue('addressee', order.shipping.first_name + ' ' + order.shipping.last_name);
            shippingSubRecord.setValue('addr1', order.shipping.address_1);
            shippingSubRecord.setValue('addr2', order.shipping.address_2);
            shippingSubRecord.setValue('addrphone', '');
            shippingSubRecord.setValue('city', order.shipping.city);
            shippingSubRecord.setValue('state', order.shipping.state);
            shippingSubRecord.setValue('zip', order.shipping.postcode);

            billingSubRecord = rec.getSubrecord('billingaddress');
            billingSubRecord.setValue('country', order.billing.country);
            billingSubRecord.setValue('addressee', order.billing.first_name + ' ' + order.billing.last_name);
            billingSubRecord.setValue('addr1', order.billing.address_1);
            billingSubRecord.setValue('addr2', order.billing.address_2);
            billingSubRecord.setValue('addrphone', '');
            billingSubRecord.setValue('city', order.billing.city);
            billingSubRecord.setValue('state', order.billing.state);
            billingSubRecord.setValue('zip', order.billing.postcode);

            var shipMethod = null;

            _.each(order.shipping_lines, function(shipLine) {
                if (shipLine.method_title === 'Free shipping'){
                    shipMethod = 712;
                } else if (shipLine.method_title === 'Standard (4-8 business days)' || shipLine.method_title === 'Standard (3-5 days)') {
                    shipMethod = 712;
                } else if (shipLine.method_title === 'Expedited (3-6 business days)') {
                    shipMethod = 714;
                } else if (shipLine.method_title === 'Priority (2-3 business days)') {
                    shipMethod = 715;
                }
            });

            if (shipMethod)
                rec.setValue('shipmethod', shipMethod);

            rec.setValue('shippingcost', parseFloat(order.shipping_total));

            var itemCount = rec.getLineCount({
                    sublistId: 'item'
                }),
                savedItems = [];

            for (var i = 0; i < itemCount; i++) {
                var itemType = rec.getCurrentSublistValue({
                        sublistId: 'item',
                        fieldId: 'itemtype'
                    });

                if (itemType === 'InvtPart') {
                    rec.selectLine({
                        sublistId: 'item',
                        line: i
                    });
                    var wordpressLineId = rec.getCurrentSublistValue({
                            sublistId: 'item',
                            fieldId: 'custcol_wordpress_line_id'
                        }),
                        
                        line = _.findWhere(order.line_items, {id: wordpressLineId});

                    log.debug('wordpressLineId', wordpressLineId);
                    log.debug('line', line);

                    // Modify Line
                    if (line) {
                        // Save Id
                        savedItems.push(wordpressLineId);

                        rec = self.setLineItem(rec, line);

                        rec.commitLine('item');
                    // Close Line
                    } else
                        rec.removeLine({
                            sublistId: 'item',
                            line: i
                        });
                }
            }

            log.debug('itemCount', itemCount);
            log.debug('order.line_items.length', order.line_items.length);

            // Add Item
            if (itemCount < order.line_items.length) {
                var linesToAdd = _.filter(order.line_items,
                        function(item) {
                            return savedItems.indexOf(item.id) < 0; 
                        });

                log.debug('linesToAdd', linesToAdd);

                _.each(linesToAdd, function(line) {
                    rec.selectNewLine('item');
                    rec = self.setLineItem(rec, line);

                    rec.commitLine('item');
                });
            }

            return rec.save();
        },

        createCustomerRecord: function(customer) {
            var customerRecord = record.create({
                type: 'customer',
                isDynamic: true
            });

            customerRecord.setValue('subsidiary', 2);
            customerRecord.setValue('companyname', customer.first_name + ' ' + customer.last_name);
            customerRecord.setValue('email', customer.email);
            customerRecord.setValue('custentity_wordpress_id', customer.id);

            try {
                return customerRecord.save();
            } catch (e) {
                throw {
                    error: e,
                    customer: customer
                };
            }
            
        },

        sendRecordToWordpress: function(recordId, netsuiteId) {
            // Send Netsuite Id to Wordpress
            var requestObj = {
                id: recordId,
                meta_data: [
                    {
                        key: 'netsuite_id',
                        value: netsuiteId
                    },
                    {
                        key: 'sync_to_netsuite',
                        value: '0'
                    },
                ]
            };

            if (netsuiteId != -1) {
                var salesOrderFields = search.lookupFields({
                    type: 'salesorder',
                    id: netsuiteId,
                    columns: ['tranid']
                });

                requestObj.meta_data.push({
                    key: 'netsuite_order_number',
                    value: salesOrderFields.tranid
                });
            }

            log.debug('requestObj', requestObj);
            // Send Order to Wordpress
            var updateRequest = https.put({
                url: this.getBaseUrl() + '/orders/' + recordId,
                headers: {
                    'Authorization': 'Basic ' + this.getAuthToken(),
                    'Content-Type': 'application/json',
                    'Connection': 'keep-alive',
                    'Accept': '*/*'
                },
                body: JSON.stringify(requestObj)
            });

            log.debug('updateRequest', updateRequest);
        },


        closeOrder: function(salesOrderId) {
            var salesorder = record.load({
                    type: 'salesorder',
                    id: parseInt(salesOrderId),
                    isDynamic: true
                }),
                count = salesorder.getLineCount({
                    sublistId: 'item'
                });

            for (var i = 0; i < count; i++) {
                salesorder.selectLine({
                    sublistId: 'item',
                    line: i
                });
                salesorder.setCurrentSublistValue({
                    sublistId: 'item',
                    fieldId: 'isclosed',
                    line: i,
                    value: true,
                    ignoreFieldChange: true
                });
                salesorder.commitLine({
                    sublistId: 'item',
                    line: i
                });

            }
            salesorder.save();
        },

        summarize: function (summary) {
            // if (runtime.envType != runtime.EnvType.PRODUCTION) return;

            // Log errors if any
            var errors = [];

            if (summary.inputSummary.error) {
                log.debug('Input Error', summary.inputSummary.error);
                errors.push('Input Error:' + summary.inputSummary.error);
            }

            summary.mapSummary.errors.iterator().each(function (key, error) {
                error = JSON.parse(error);

                if (error.error) {
                    var err = {
                        id: error.error.name,
                        detail: error.error.message
                    };
                    if (error.order)
                        err.order = error.order
                } else {
                    var err = {
                        id: error.name,
                        detail: error.message
                    };
                }

                errors.push(err);

                return true;
            });

            JSON.stringify(errors).match(/.{1,3000}/g).forEach(function(smallString, idx) {
                log.error('Error Log ' + idx, smallString);
            });

            // Generate Order List to Update
            var orders = [];

            summary.output.iterator().each(function (key, value) {
                key = JSON.parse(key);

                orders.push(key);

                return true;
            });

            log.debug('Results', 'Orders Processed: ' + orders.length);

            if (runtime.envType != runtime.EnvType.PRODUCTION) return;

            if (errors.length) {
                // Send Summary Email
                var body = '<h2>Order Creation Error Summary</h2>';

                body += '<div style="border-top: 1px solid #ccc;">';
                body += '<p><b>Records:</b> ' + orders.length + '</p>';

                body += '<p style="color: red;"><b>Errors (Count: ' + errors.length + '):</b></p><br><br>';

                _.each(errors, function(error) {
                    _.each(error, function(field, k) {
                        if (field) {
                            body += '<p>' + field + '</p>';
                        }
                    });
                    body += '<br><br>';
                });
                body += '</p>';

                body += '</div>';

                email.send({
                    author: -5,
                    recipients: [-5,1011],
                    subject: 'Order Creation Error Summary',
                    body: body
                });

                log.debug('Email Status', 'Email Sent!');
            }
        }
    };
});
