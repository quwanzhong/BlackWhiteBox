package com.poc.stock;

/** PoC fixture：库存链路（与订单链路完全不相交）。 */
public class StockService {

  private final StockRepository repository;
  private final AlertClient alertClient;

  public StockService(StockRepository repository, AlertClient alertClient) {
    this.repository = repository;
    this.alertClient = alertClient;
  }

  public void deduct(String skuId, int count) {
    int stock = repository.selectStock(skuId);
    if (stock < count) {
      alertClient.lowStock(skuId, stock);
      throw new IllegalStateException("库存不足");
    }
    repository.updateStock(skuId, stock - count);
  }

  public int query(String skuId) {
    return repository.selectStock(skuId);
  }
}
