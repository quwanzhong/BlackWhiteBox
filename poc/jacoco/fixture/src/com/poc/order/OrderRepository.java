package com.poc.order;

/** PoC fixture：订单仓储（内存实现，无外部依赖）。 */
public class OrderRepository {

  private long seq = 0;

  public String insert(String userId, String skuId, int count, String paymentId) {
    seq++;
    return "ORD-" + seq + "-" + userId;
  }

  public void bindCoupon(String couponId, String orderId) {
    // 仅当传入优惠券时执行；create() 传 null，此行应处于未覆盖状态
    seq++;
  }
}
