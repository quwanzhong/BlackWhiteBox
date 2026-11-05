package com.demo.order;

public class CreateOrderRequest {
  private Long userId;
  private Long skuId;
  private int count;
  private long amount;
  private Long couponId;

  public Long getUserId() { return userId; }
  public Long getSkuId() { return skuId; }
  public int getCount() { return count; }
  public long getAmount() { return amount; }
  public Long getCouponId() { return couponId; }
}
