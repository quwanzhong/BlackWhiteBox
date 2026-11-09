package com.poc.stock;

/** PoC fixture：低库存告警（模拟远程调用）。 */
public class AlertClient {

  public void lowStock(String skuId, int stock) {
    // 仅在库存不足分支执行；正常扣减时此行应处于未覆盖状态
    System.out.println("[alert] low stock: " + skuId + " = " + stock);
  }
}
