package com.demo.order;

import com.demo.common.Result;

/**
 * 演示用 Controller：白盒分析器的入口识别对象。
 * 说明：示例工程只用于演示分析器的解析能力，不依赖 Spring 运行。
 */
@RestController
@RequestMapping("/api/orders")
public class OrderController {

  private final OrderService orderService;

  public OrderController(OrderService orderService) {
    this.orderService = orderService;
  }

  @PostMapping
  public Result<Long> createOrder(@RequestBody CreateOrderRequest request) {
    Long orderId = orderService.createOrder(request);
    return Result.ok(orderId);
  }

  @GetMapping("/{id}")
  public Result<OrderDetail> detail(@PathVariable Long id) {
    return Result.ok(orderService.detail(id));
  }

  @DeleteMapping("/{id}")
  public Result<Void> cancel(@PathVariable Long id) {
    orderService.cancel(id);
    return Result.ok(null);
  }
}
