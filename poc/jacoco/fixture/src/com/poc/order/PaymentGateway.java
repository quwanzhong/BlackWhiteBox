package com.poc.order;

/** PoC fixture：支付网关（模拟远程调用）。 */
public class PaymentGateway {

  public String charge(String userId, long amount) {
    if (amount <= 0) {
      throw new IllegalArgumentException("金额必须大于 0");
    }
    return "PAY-" + userId + "-" + amount;
  }
}
