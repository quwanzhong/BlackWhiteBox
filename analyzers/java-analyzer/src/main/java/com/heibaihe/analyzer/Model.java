package com.heibaihe.analyzer;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** 分析结果的数据模型：流程 = 方法节点 + 调用边。 */
public class Model {

  /** 白盒流程中的一个方法节点 */
  public static class MethodRef {
    public String id;
    public String className = "";
    public String packageName = "";
    public String method = "";
    public String signature = "";
    public String kind = "method";
    public String file = "";
    public int line;
    public int depth;
    public boolean entry;

    public String fqn() {
      return packageName == null || packageName.isEmpty() ? className : packageName + "." + className;
    }

    public String label() {
      return className + "#" + method;
    }
  }

  public static class Edge {
    public String from;
    public String to;
    public String condition = "";
  }

  public static class Flow {
    public String name = "";
    public String entry = "";
    public List<MethodRef> nodes = new ArrayList<>();
    public List<Edge> edges = new ArrayList<>();

    /** 去重边：同一对节点只保留一条，优先保留带条件的 */
    public void addEdge(String from, String to, String condition) {
      for (Edge e : edges) {
        if (e.from.equals(from) && e.to.equals(to)) {
          if (e.condition.isEmpty() && condition != null && !condition.isEmpty()) {
            e.condition = condition;
          }
          return;
        }
      }
      Edge e = new Edge();
      e.from = from;
      e.to = to;
      e.condition = condition == null ? "" : condition;
      edges.add(e);
    }

    /** 节点按层级排序，便于画布布局 */
    public List<MethodRef> sortedNodes() {
      List<MethodRef> copy = new ArrayList<>(nodes);
      copy.sort((a, b) -> {
        if (a.depth != b.depth) return Integer.compare(a.depth, b.depth);
        return Integer.compare(ordinal(a.id), ordinal(b.id));
      });
      return copy;
    }

    private static int ordinal(String id) {
      try {
        return Integer.parseInt(id.replaceAll("\\D+", ""));
      } catch (Exception e) {
        return 0;
      }
    }
  }

  /** 分析过程中的告警（不影响输出） */
  public static class Diag {
    public String file = "";
    public long line;
    public String message = "";
  }

  /** Spring Controller 上的 HTTP 映射信息 */
  public static class HttpInfo {
    public String httpMethod = "";
    public String path = "";
  }

  /** 索引用的类模型（内部使用） */
  public static class ClassModel {
    public String packageName = "";
    public String simpleName = "";
    public String file = "";
    public String extendsName;
    public ClassModel outer;
    public List<String> annotations = new ArrayList<>();
    public Map<String, FieldModel> fields = new LinkedHashMap<>();
    public List<MethodInfo> methods = new ArrayList<>();

    public boolean hasAnnotation(String name) {
      for (String a : annotations) {
        if (a.equals(name) || a.startsWith(name + "(")) return true;
      }
      return false;
    }

    public String fqn() {
      return packageName == null || packageName.isEmpty() ? simpleName : packageName + "." + simpleName;
    }

    public MethodInfo findMethod(String name, int argc) {
      for (MethodInfo m : methods) {
        if (m.name.equals(name) && argc >= 0 && m.arity == argc) return m;
      }
      for (MethodInfo m : methods) {
        if (m.name.equals(name)) return m;
      }
      return null;
    }
  }

  public static class FieldModel {
    public String name = "";
    public String type = "";
  }

  public static class MethodInfo {
    public ClassModel owner;
    public String name = "";
    public String signature = "";
    public String returnType = "void";
    public int arity;
    public int line;
    public List<String> annotations = new ArrayList<>();
    public Map<String, String> localTypes = new LinkedHashMap<>();
    public List<CallSite> calls = new ArrayList<>();

    public boolean hasAnnotationPrefix(String name) {
      for (String a : annotations) {
        if (a.equals(name) || a.startsWith(name + "(")) return true;
      }
      return false;
    }
  }

  /** 一处方法调用点 */
  public static class CallSite {
    public String expr;      // 接收者表达式文本；null 表示同类/静态导入调用
    public String method = "";
    public int arity;
    public int line;
    public String condition = ""; // 所在 if / case 条件（用于画布连线标注）
  }

  public static Set<String> emptySet() {
    return new LinkedHashSet<>();
  }
}
