package com.demo.stock;

@Service
public class StockAlertService {

  private final AlertClient alertClient;

  public StockAlertService(AlertClient alertClient) {
    this.alertClient = alertClient;
  }

  public void notifyLowStock(Long skuId, int remain) {
    if (remain <= 0) {
      alertClient.sendUrgent(AlertClient.Channel.SMS, "SKU " + skuId + " 已售罄");
    } else {
      alertClient.send(AlertClient.Channel.EMAIL, "SKU " + skuId + " 库存仅剩 " + remain);
    }
  }
}
