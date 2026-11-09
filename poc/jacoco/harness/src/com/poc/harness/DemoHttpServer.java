package com.poc.harness;

import com.poc.order.OrderRepository;
import com.poc.order.OrderService;
import com.poc.order.PaymentGateway;
import com.poc.stock.AlertClient;
import com.poc.stock.StockRepository;
import com.poc.stock.StockService;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.Executors;

/**
 * PoC 用的最小 HTTP 壳：零第三方依赖（JDK 内置 HttpServer）。
 * 只暴露两条互不相交的调用链，用于验证"per-node 覆盖率不串"。
 *
 * 启动：java -javaagent:jacocoagent.jar=port=6300,address=127.0.0.1,output=tcpserver \
 *          -cp ... com.poc.harness.DemoHttpServer --port 8089
 */
public final class DemoHttpServer {

  private static final OrderService ORDER =
      new OrderService(new OrderRepository(), new PaymentGateway());
  private static final StockService STOCK =
      new StockService(new StockRepository(), new AlertClient());

  public static void main(String[] args) throws Exception {
    int port = 8089;
    for (int i = 0; i < args.length - 1; i++) {
      if ("--port".equals(args[i])) {
        port = Integer.parseInt(args[i + 1]);
      }
    }

    HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
    server.setExecutor(Executors.newFixedThreadPool(4));

    server.createContext("/health", ex -> respond(ex, 200, "{\"ok\":true}"));
    server.createContext("/order/create", ex -> {
      Map<String, String> q = query(ex);
      String body = "{\"orderId\":\"" + ORDER.create(
          q.getOrDefault("userId", "u1"),
          q.getOrDefault("sku", "sku-1"),
          Integer.parseInt(q.getOrDefault("count", "2")),
          Long.parseLong(q.getOrDefault("amount", "100"))) + "\"}";
      respond(ex, 200, body);
    });
    server.createContext("/stock/deduct", ex -> {
      Map<String, String> q = query(ex);
      try {
        STOCK.deduct(q.getOrDefault("sku", "sku-1"),
            Integer.parseInt(q.getOrDefault("count", "1")));
        respond(ex, 200, "{\"ok\":true,\"left\":" + STOCK.query(q.getOrDefault("sku", "sku-1")) + "}");
      } catch (IllegalStateException e) {
        respond(ex, 409, "{\"error\":\"" + e.getMessage() + "\"}");
      }
    });
    server.createContext("/stock/query", ex -> {
      Map<String, String> q = query(ex);
      respond(ex, 200, "{\"left\":" + STOCK.query(q.getOrDefault("sku", "sku-1")) + "}");
    });

    server.start();
    System.out.println("READY " + server.getAddress().getPort());
    System.out.flush();

    Runtime.getRuntime().addShutdownHook(new Thread(() -> server.stop(0)));
  }

  private static void respond(HttpExchange ex, int status, String body) throws IOException {
    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
    ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
    ex.sendResponseHeaders(status, bytes.length);
    try (OutputStream out = ex.getResponseBody()) {
      out.write(bytes);
    } catch (IOException ignored) {
      // 客户端提前断开，忽略
    }
  }

  private static Map<String, String> query(HttpExchange ex) {
    Map<String, String> map = new HashMap<>();
    String raw = ex.getRequestURI().getRawQuery();
    if (raw == null || raw.isEmpty()) {
      return map;
    }
    for (String pair : raw.split("&")) {
      int i = pair.indexOf('=');
      if (i > 0) {
        map.put(pair.substring(0, i), pair.substring(i + 1));
      }
    }
    return map;
  }

  private DemoHttpServer() {
  }
}
