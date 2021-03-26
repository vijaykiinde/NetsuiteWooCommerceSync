<? 
// Increase the update limit
function update_limit_for_products( $limit, $products ) {
    $limit = 30000;

    return $limit;
}
add_filter( 'woocommerce_api_bulk_limit', 'update_limit_for_products', 10, 2 );
function wpse_rest_batch_items_limit( $limit ) {
    $limit = 30000;

    return $limit;
}
add_filter( 'woocommerce_rest_batch_items_limit', 'wpse_rest_batch_items_limit' );


// regular variable products
add_action( 'woocommerce_product_after_variable_attributes', 'add_to_variations_metabox', 10, 3 );
add_action( 'woocommerce_save_product_variation', 'save_product_variation', 20, 2 );


// Add Netsuite Id field to Variations
function add_to_variations_metabox( $loop, $variation_data, $variation) {

    $custom = get_post_meta( $variation->ID, 'netsuite_id', true ); ?>

        <div class="variable_custom_field">
            <p class="form-row form-row-first">
                <label><?php echo __( 'Netsuite Id:', 'plugin_textdomain' ); ?></label>
                <input type="text" size="5" name="variation_custom_data[<?php echo $loop; ?>]" value="<?php echo esc_attr( $custom ); ?>" />
            </p>
        </div>

    <?php 

}

function save_product_variation( $variation_id, $i ) {
    // save custom data
    if ( isset( $_POST['variation_custom_data'][$i] ) ) {
        // sanitize data in way that makes sense for your data type
        $custom_data = ( trim( $_POST['variation_custom_data'][$i]  ) === '' ) ? '' : sanitize_title( $_POST['variation_custom_data'][$i] );
        update_post_meta( $variation_id, 'netsuite_id', $custom_data );
    }

}

// Add Netsuite Id to Order Lines
add_filter( 'woocommerce_rest_prepare_shop_order_object', 'wc_rest_api_extend_order_lineitems_data', 10, 3 );
function wc_rest_api_extend_order_lineitems_data( $response, $object, $request ) {

    if( empty( $response->data ) ) {
        return $response;
    }

    $order_data = $response->get_data();

    // Extend OrderLines
    foreach ($order_data['line_items'] as &$item ) {
        $productId = ($item['variation_id'] == 0) ? $item['product_id'] : $item['variation_id'];

        // Get Netsuite Id
        $netsuiteId = get_post_meta($productId, 'netsuite_id', true);
        $item['netsuite_id'] = $netsuiteId;

        // Get Product Price
        $product = wc_get_product($productId);
        
        $productPrice = $product->get_price();
        $item['product_price'] = $productPrice;
    }

    // Extend CouponLines
    foreach ($order_data['coupon_lines'] as &$coupon ) {
        if (!empty($coupon)) {
            $coupon['netsuite_product_ids'] = array();

            foreach ($coupon['meta_data'] as $meta_data ) {

                if ($meta_data['key'] == 'coupon_data') {
                    foreach ($meta_data['value']['product_ids'] as $i => $productId) {
                        // Get Netsuite Id
                        $netsuiteId = get_post_meta($productId, 'netsuite_id', true);
                        $coupon['netsuite_product_ids'][] = $netsuiteId;
                    }
                }
            }
        }
    }

    $response->data = $order_data;

    return $response;
}

// Set Sync to Netsuite after Update
add_action( 'save_post', 'wc_set_sync_to_netsuite', 10, 2 );
function wc_set_sync_to_netsuite( $post_ID ){
    // Get the post object
    $post = get_post( $post_ID );

    if ($post->post_type == 'shop_order')
        update_post_meta( $post_ID, 'sync_to_netsuite', true );
}


// Add Netsuite Id to Coupon Product Lines
add_filter( 'woocommerce_rest_prepare_shop_coupon_object', 'wc_rest_api_extend_coupon_data', 10, 3 );
function wc_rest_api_extend_coupon_data( $response, $object, $request ) {

    if( empty( $response->data ) ) {
        return $response;
    }

    $order_data = $response->get_data();

    $order_data['netsuite_product_ids'] = array();

    foreach ( $order_data['product_ids'] as $key => $productId ) {
        $netsuiteId = get_post_meta($productId, 'netsuite_id', true);

        $order_data['netsuite_product_ids'][] = $netsuiteId;
    }

    $response->data = $order_data;

    return $response;
}

// Create getOrdersToBeSynced Endpoint
add_action( 'rest_api_init', 'register_getOrdersToBeSynced_route');
function register_getOrdersToBeSynced_route() {
    register_rest_route( 'wc/v3', 'getOrdersToBeSynced', array(
        'methods' => 'GET',
        'callback' => 'getOrdersToBeSynced'
    ));
}

function getOrdersToBeSynced() {
    $orders = [];

    $loop = new WP_Query( array(
        // 'p' => 467663,
        'post_type' => 'shop_order',
        'post_status' =>  array('wc-processing', 'wc-refunded', 'wp-cancelled', 'wc-failed'),
        'posts_per_page' => 20,
        'date_query' => array(
            'after'  => array(
                'year'  => 2021,
                'month' => 1,
                'day'   => 29,
                'hour' => 13,
                'minute' => 00,
                'compare' => '>='
            ),
        ),
        'meta_query' => array(
                'relation' => 'OR',
                array(
                    'key' => 'netsuite_id',
                    'value' => '',
                    'compare' => 'NOT EXISTS',
                ),
                array(
                    'key' => 'netsuite_id',
                    'value' => '',
                    'compare' => '=',
                ),
                array(
                    'key' => 'sync_to_netsuite',
                    'value' => '1',
                    'compare' => '='
                )
            )
    ));

    // The Wordpress post loop
    if ( $loop->have_posts() ): 
        while ( $loop->have_posts() ) : $loop->the_post();
        
        // The order ID
        $order_id = $loop->post->ID;
        
        // Get an instance of the WC_Order Object
        $order = wc_get_order($loop->post->ID);

        $orders[] = $order_id;
        
        endwhile;
        
        wp_reset_postdata();
    
    endif;

    return rest_ensure_response($orders);
}

// Create updateOrderStatus Endpoint
add_action( 'rest_api_init', 'register_updateOrderStatus_route');
function register_updateOrderStatus_route() {
    register_rest_route( 'wc/v3', 'updateOrderStatus', array(
        'methods' => 'PUT',
        'callback' => 'updateOrderStatus'
    ));
}

function updateOrderStatus($request) {
    $body = $request->get_query_params();

    $orderId = $body['id'];
    $status = $body['status'];

    if (!empty($orderId) && !empty($status)) {
        $order = new WC_Order($orderId);
        $order->update_status($status);
        $response = true;
    } else {
        $response = false;
    }

    return rest_ensure_response($response);
}

// Register new status
function register_awaiting_shipment_order_status() {
    register_post_status( 'wc-being-packed', array(
        'label' => 'Order is Being Packed',
        'public' => true,
        'exclude_from_search' => false,
        'show_in_admin_all_list' => true,
        'show_in_admin_status_list' => true,
        'label_count' => _n_noop( 'Order is Being Packed (%s)', 'Order is Being Packed (%s)' )
    ));

    register_post_status( 'wc-shipped', array(
        'label' => 'Shipped',
        'public' => true,
        'exclude_from_search' => false,
        'show_in_admin_all_list' => true,
        'show_in_admin_status_list' => true,
        'label_count' => _n_noop( 'Shipped (%s)', 'Shipped (%s)' )
    ) );
}
?>