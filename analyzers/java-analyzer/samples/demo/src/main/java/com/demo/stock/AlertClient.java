package com.demo.stock;

public class AlertClient {

  public enum Channel { SMS, EMAIL }

  public void send(Channel channel, String content) {
    System.out.println("[" + channel + "] " + content);
  }

  public void sendUrgent(Channel channel, String content) {
    System.out.println("[URGENT][" + channel + "] " + content);
  }
}
