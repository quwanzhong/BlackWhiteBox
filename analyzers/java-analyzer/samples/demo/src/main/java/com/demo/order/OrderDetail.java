package com.demo.order;

public class OrderDetail {
  private Long id;
  private Long skuId;
  private int count;
  private String status;
  private int stock;

  public Long getId() { return id; }
  public Long getSkuId() { return skuId; }
  public int getCount() { return count; }
  public String getStatus() { return status; }
  public int getStock() { return stock; }
  public void setStock(int stock) { this.stock = stock; }
}
