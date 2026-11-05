package com.demo.order;

@Service
public class OrderService {

  private final StockService stockService;
  private final PayService payService;
  private final OrderMapper orderMapper;

  public OrderService(StockService stockService, PayService payService, OrderMapper orderMapper) {
    this.stockService = stockService;
    this.payService = payService;
    this.orderMapper = orderMapper;
  }

  public Long createOrder(CreateOrderRequest request) {
    stockService.deduct(request.getSkuId(), request.getCount());
    Long paymentId = payService.createPayment(request.getUserId(), request.getAmount());
    Long orderId = orderMapper.insert(request, paymentId);
    bindCoupon(request.getCouponId(), orderId);
    return orderId;
  }

  public OrderDetail detail(Long id) {
    OrderDetail detail = orderMapper.selectById(id);
    if (detail == null) {
      throw new IllegalArgumentException("订单不存在");
    }
    detail.setStock(stockService.queryStock(detail.getSkuId()));
    return detail;
  }

  public void cancel(Long id) {
    OrderDetail detail = orderMapper.selectById(id);
    if (detail != null) {
      orderMapper.updateStatus(id, "CANCELLED");
      stockService.restore(detail.getSkuId(), detail.getCount());
    }
  }

  private void bindCoupon(Long couponId, Long orderId) {
    if (couponId == null) {
      return;
    }
    orderMapper.bindCoupon(couponId, orderId);
  }
}
