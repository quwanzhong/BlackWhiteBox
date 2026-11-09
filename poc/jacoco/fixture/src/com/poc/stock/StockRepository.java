package com.poc.stock;

import java.util.HashMap;
import java.util.Map;

/** PoC fixture：库存仓储（内存实现）。 */
public class StockRepository {

  private final Map<String, Integer> stock = new HashMap<>();

  public StockRepository() {
    stock.put("sku-1", 10);
    stock.put("sku-2", 3);
  }

  public int selectStock(String skuId) {
    Integer value = stock.get(skuId);
    return value == null ? 0 : value;
  }

  public void updateStock(String skuId, int count) {
    stock.put(skuId, count);
  }
}
