package com.demo.stock;

@Service
public class StockService {

  private final InventoryMapper inventoryMapper;
  private final StockAlertService stockAlertService;

  public StockService(InventoryMapper inventoryMapper, StockAlertService stockAlertService) {
    this.inventoryMapper = inventoryMapper;
    this.stockAlertService = stockAlertService;
  }

  public void deduct(Long skuId, int count) {
    int stock = inventoryMapper.selectStock(skuId);
    if (stock < count) {
      stockAlertService.notifyLowStock(skuId, stock);
      throw new IllegalStateException("库存不足");
    }
    inventoryMapper.updateStock(skuId, stock - count);
  }

  public int queryStock(Long skuId) {
    return inventoryMapper.selectStock(skuId);
  }

  public void restore(Long skuId, int count) {
    int stock = inventoryMapper.selectStock(skuId);
    inventoryMapper.updateStock(skuId, stock + count);
  }
}
