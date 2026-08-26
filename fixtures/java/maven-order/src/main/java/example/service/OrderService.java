package example.service;

import example.domain.Order;
import example.domain.OrderStatus;

public interface OrderService {
  Order create(OrderStatus status);
}
