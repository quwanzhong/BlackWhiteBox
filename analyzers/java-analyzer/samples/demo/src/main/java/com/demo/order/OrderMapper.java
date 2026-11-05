package com.demo.order;

public interface OrderMapper {

  Long insert(CreateOrderRequest request, Long paymentId);

  OrderDetail selectById(Long id);

  int updateStatus(Long id, String status);

  int bindCoupon(Long couponId, Long orderId);
}
