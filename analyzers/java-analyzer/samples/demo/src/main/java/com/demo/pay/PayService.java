package com.demo.pay;

@Service
public class PayService {

  private final PaymentClient paymentClient;

  public PayService(PaymentClient paymentClient) {
    this.paymentClient = paymentClient;
  }

  public Long createPayment(Long userId, long amount) {
    if (amount <= 0) {
      throw new IllegalArgumentException("支付金额必须大于 0");
    }
    PaymentClient.PayResult result = paymentClient.request(userId, amount);
    if (!result.isSuccess()) {
      throw new IllegalStateException("支付失败：" + result.getMessage());
    }
    return result.getPaymentId();
  }
}
