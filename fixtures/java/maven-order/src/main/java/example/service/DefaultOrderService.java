package example.service;

import example.domain.Order;
import example.domain.OrderStatus;

public final class DefaultOrderService implements OrderService {
  @Override
  public Order create(OrderStatus status) {
    return new Order("order-1", status);
  }
}
