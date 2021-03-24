/**
 * @NApiVersion 2.0
 * @NScriptType MapReduceScript
 */
define([
    'N/search',
    'N/runtime',
    'N/https'

], function (
    search,
    runtime,
    https
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
            return search.load({id: 'customsearch_salesorder_to_be_approved'});
        },

        map: function (context) {
            var order = JSON.parse(context.value);

            log.debug('Order Id', 'Order Id: ' + order.id + ' - Wordpress Id: ' + order.values['custbody_wordpress_id']);

            var getRequest = https.get({
                    url: this.getBaseUrl() + '/orders/' + order.values['custbody_wordpress_id'],
                    headers: {
                        'Authorization': 'Basic ' + this.getAuthToken(),
                        'Content-Type': 'application/json',
                        'Connection': 'keep-alive',
                        'Accept': '*/*'
                    }
                });

            log.debug('Response', getRequest);

            var woocoomerceOrder = JSON.parse(getRequest.body);

            log.debug('woocoomerceOrder', woocoomerceOrder.status);
        },

        sendRecordToWordpress: function(recordId, refundId) {
            // Send Netsuite Id to Wordpress
            var requestObj = {
                id: recordId,
                meta_data: [
                    {
                        key: 'netsuite_refund_id',
                        value: refundId
                    }
                ]
            };

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

        summarize: function (summary) {
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

                var order = {
                        id: key.orderId
                    }

                    orders.push(order);

                return true;
            });

            log.debug('Results', 'Order Processed: ' + orders.length);
        }
    };
});
