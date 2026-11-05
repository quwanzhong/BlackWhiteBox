package com.demo.pay;

public class PaymentClient {

  public static class PayResult {
    private boolean success;
    private long paymentId;
    private String message;

    public boolean isSuccess() { return success; }
    public long getPaymentId() { return paymentId; }
    public String getMessage() { return message; }
  }

  public PayResult request(Long userId, long amount) {
    PayResult r = new PayResult();
    r.success = true;
    r.paymentId = 90001L;
    r.message = "ok";
    return r;
  }
}
