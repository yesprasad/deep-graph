package example.api;

import example.domain.Order;
import example.domain.OrderStatus;
import example.service.OrderService;

public class OrderController {
  private final OrderService service;

  public OrderController(OrderService service) {
    this.service = service;
  }

  public Order create(OrderStatus status) {
    return service.create(status);
  }
}
