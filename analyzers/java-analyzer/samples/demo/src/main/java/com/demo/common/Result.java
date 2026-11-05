package com.demo.common;

public class Result<T> {
  private int code;
  private String message;
  private T data;

  public static <T> Result<T> ok(T data) {
    Result<T> r = new Result<>();
    r.code = 0;
    r.message = "ok";
    r.data = data;
    return r;
  }
}
