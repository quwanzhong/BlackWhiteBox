package com.poc.order;

/**
 * PoC fixture：订单链路（与库存链路完全不相交）。
 * 刻意保留一个不执行的分支（applyCoupon 的 couponId != null），用于验证"未覆盖行"。
 */
public class OrderService {

  private final OrderRepository repository;
  private final PaymentGateway payment;

  public OrderService(OrderRepository repository, PaymentGateway payment) {
    this.repository = repository;
    this.payment = payment;
  }

  public String create(String userId, String skuId, int count, long amount) {
    String paymentId = payment.charge(userId, amount);
    String orderId = repository.insert(userId, skuId, count, paymentId);
    applyCoupon(orderId, null);
    return orderId;
  }

  private void applyCoupon(String orderId, String couponId) {
    if (couponId == null) {
      return;
    }
    repository.bindCoupon(couponId, orderId);
  }
}
