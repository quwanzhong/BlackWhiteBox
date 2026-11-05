package com.demo.stock;

public interface InventoryMapper {

  int selectStock(Long skuId);

  int updateStock(Long skuId, int count);
}
