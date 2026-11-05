package com.heibaihe.analyzer;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * 黑百盒 · Java 白盒调用链分析器（CLI）。
 *
 * <pre>
 * 用法：
 *   java -jar java-analyzer.jar --project &lt;Java工程目录&gt; [--out flows.json]
 *                               [--entry OrderController#create] [--depth 6]
 *                               [--include-test] [--list]
 * </pre>
 */
public class Main {

  public static void main(String[] args) throws Exception {
    Map<String, String> opt = parseArgs(args);
    if (opt.containsKey("help") || opt.containsKey("h") || !opt.containsKey("project")) {
      usage();
      return;
    }

    Path project = Paths.get(opt.get("project")).toAbsolutePath().normalize();
    if (!Files.isDirectory(project)) {
      System.err.println("工程目录不存在：" + project);
      System.exit(1);
      return;
    }

    int depth = parseInt(opt.get("depth"), 6);
    String entry = opt.get("entry");
    boolean includeTests = opt.containsKey("include-test");

    List<Path> sources = collectSources(project, includeTests);
    if (sources.isEmpty()) {
      System.err.println("未在工程中找到 .java 源文件：" + project);
      System.exit(2);
      return;
    }

    System.out.println("开始分析：" + project);
    System.out.println("源文件数量：" + sources.size());

    ProjectAnalyzer analyzer = new ProjectAnalyzer(project, sources);
    analyzer.setIncludeAccessors(opt.containsKey("include-accessors"));
    analyzer.parse();
    System.out.println("解析类数量：" + analyzer.classCount());

    if (!analyzer.getDiagnostics().isEmpty()) {
      System.out.println("语法告警：" + analyzer.getDiagnostics().size()
          + " 条（仅解析、不做编译，通常不影响调用链）");
      analyzer.getDiagnostics().stream().limit(5).forEach(d ->
          System.out.println("  ! " + d.file + ":" + d.line + " " + d.message));
    }

    if (opt.containsKey("list")) {
      List<Model.MethodRef> entries = analyzer.listEntries();
      System.out.println("检测到 " + entries.size() + " 个接口入口：");
      for (Model.MethodRef e : entries) {
        System.out.println("  · " + e.className + "#" + e.method + "  (" + e.file + ":" + e.line + ")");
      }
      return;
    }

    List<Model.Flow> flows = analyzer.buildFlows(entry, depth);
    if (flows.isEmpty()) {
      System.out.println("未生成任何流程。可尝试：");
      System.out.println("  --entry <类名或方法名>   指定入口重新分析");
      System.out.println("  --include-test           把 src/test 下的源码也纳入分析");
      System.out.println("  --list                   查看识别到的接口入口");
    } else {
      System.out.println("生成白盒流程：" + flows.size() + " 条");
      for (Model.Flow f : flows) {
        System.out.println("  · " + f.name + "（" + f.nodes.size() + " 节点 / " + f.edges.size() + " 连线）");
      }
    }

    String json = toJson(project, analyzer, flows);
    String outArg = opt.getOrDefault("out", "flows.json");
    Path outPath = Paths.get(outArg).toAbsolutePath();
    if (outPath.getParent() != null) Files.createDirectories(outPath.getParent());
    Files.writeString(outPath, json, StandardCharsets.UTF_8);
    System.out.println("输出文件：" + outPath);
    System.out.println("下一步：把该 JSON 粘贴到「黑百盒 → 数据导入 → 白盒调用链导入」即可生成白盒流程图。");
  }

  // ============================================================
  // JSON 输出
  // ============================================================

  private static String toJson(Path project, ProjectAnalyzer analyzer, List<Model.Flow> flows) {
    StringBuilder sb = new StringBuilder(4096);
    sb.append("{\n");
    sb.append("  \"generator\": \"heibaihe-java-analyzer\",\n");
    sb.append("  \"version\": \"0.1.0\",\n");
    sb.append("  \"generatedAt\": ").append(str(OffsetDateTime.now().format(DateTimeFormatter.ISO_OFFSET_DATE_TIME))).append(",\n");
    sb.append("  \"projectRoot\": ").append(str(project.toString())).append(",\n");
    sb.append("  \"classCount\": ").append(analyzer.classCount()).append(",\n");
    sb.append("  \"flows\": [");

    for (int i = 0; i < flows.size(); i++) {
      Model.Flow f = flows.get(i);
      sb.append(i == 0 ? "\n" : ",\n");
      sb.append("    {\n");
      sb.append("      \"name\": ").append(str(f.name)).append(",\n");
      sb.append("      \"entry\": ").append(str(f.entry)).append(",\n");
      sb.append("      \"nodes\": [");

      List<Model.MethodRef> nodes = f.sortedNodes();
      for (int j = 0; j < nodes.size(); j++) {
        Model.MethodRef n = nodes.get(j);
        sb.append(j == 0 ? "\n" : ",\n");
        sb.append("        {");
        sb.append("\"id\": ").append(str(n.id)).append(", ");
        sb.append("\"name\": ").append(str(n.label())).append(", ");
        sb.append("\"class\": ").append(str(n.className)).append(", ");
        sb.append("\"package\": ").append(str(n.packageName)).append(", ");
        sb.append("\"method\": ").append(str(n.method)).append(", ");
        sb.append("\"signature\": ").append(str(n.signature)).append(", ");
        sb.append("\"kind\": ").append(str(n.kind)).append(", ");
        sb.append("\"file\": ").append(str(n.file)).append(", ");
        sb.append("\"line\": ").append(n.line).append(", ");
        sb.append("\"depth\": ").append(n.depth).append(", ");
        sb.append("\"entry\": ").append(n.entry);
        sb.append("}");
      }
      sb.append(nodes.isEmpty() ? "]," : "\n      ],\n");

      sb.append("      \"edges\": [");
      for (int j = 0; j < f.edges.size(); j++) {
        Model.Edge e = f.edges.get(j);
        sb.append(j == 0 ? "\n" : ",\n");
        sb.append("        {\"from\": ").append(str(e.from))
            .append(", \"to\": ").append(str(e.to))
            .append(", \"condition\": ").append(str(e.condition)).append("}");
      }
      sb.append(f.edges.isEmpty() ? "]" : "\n      ]");
      sb.append("\n    }");
    }

    sb.append(flows.isEmpty() ? "]\n" : "\n  ]\n");
    sb.append("}\n");
    return sb.toString();
  }

  private static String str(String s) {
    if (s == null) return "null";
    StringBuilder sb = new StringBuilder(s.length() + 2);
    sb.append('"');
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '"' -> sb.append("\\\"");
        case '\\' -> sb.append("\\\\");
        case '\n' -> sb.append("\\n");
        case '\r' -> sb.append("\\r");
        case '\t' -> sb.append("\\t");
        case '\b' -> sb.append("\\b");
        case '\f' -> sb.append("\\f");
        default -> {
          if (c < 0x20) sb.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
          else sb.append(c);
        }
      }
    }
    sb.append('"');
    return sb.toString();
  }

  // ============================================================
  // 参数与文件收集
  // ============================================================

  private static Map<String, String> parseArgs(String[] args) {
    Map<String, String> out = new HashMap<>();
    for (int i = 0; i < args.length; i++) {
      String a = args[i];
      if (!a.startsWith("--")) continue;
      String key = a.substring(2);
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        out.put(key, args[++i]);
      } else {
        out.put(key, "true");
      }
    }
    return out;
  }

  private static int parseInt(String v, int def) {
    try {
      return v == null ? def : Integer.parseInt(v);
    } catch (NumberFormatException e) {
      return def;
    }
  }

  private static List<Path> collectSources(Path root, boolean includeTests) {
    List<Path> out;
    try (Stream<Path> walk = Files.walk(root)) {
      out = walk
          .filter(Files::isRegularFile)
          .filter(p -> p.toString().toLowerCase(Locale.ROOT).endsWith(".java"))
          .filter(p -> !inSkippedDir(root, p))
          .filter(p -> includeTests || !isTestSource(root, p))
          .sorted()
          .collect(Collectors.toCollection(ArrayList::new));
    } catch (Exception e) {
      System.err.println("遍历源码失败：" + e.getMessage());
      return new ArrayList<>();
    }
    return out;
  }

  private static boolean inSkippedDir(Path root, Path file) {
    Path rel = root.relativize(file);
    for (Path part : rel) {
      String d = part.toString().toLowerCase(Locale.ROOT);
      if (d.equals("target") || d.equals("build") || d.equals("out") || d.equals(".git")
          || d.equals("node_modules") || d.equals(".idea") || d.equals("generated-sources")) {
        return true;
      }
    }
    return false;
  }

  private static boolean isTestSource(Path root, Path file) {
    String rel = root.relativize(file).toString().replace('\\', '/').toLowerCase(Locale.ROOT);
    return rel.contains("/src/test/")
        || rel.startsWith("src/test/")
        || rel.contains("/test/java/")
        || rel.startsWith("test/java/");
  }

  private static void usage() {
    System.out.println("""
        黑百盒 · Java 白盒调用链分析器 v0.1.0

        用法：
          java -jar java-analyzer.jar --project <Java工程目录> [选项]

        选项：
          --project <dir>     必填，被分析的 Java 工程根目录
          --out <file>        输出 JSON 文件路径，默认 ./flows.json
          --entry <filter>    只分析匹配的入口（类名#方法名 / 方法名 / 类名，模糊匹配）
          --depth <n>         调用链最大深度，默认 6
          --include-test      把 src/test 下的源码也纳入分析
          --include-accessors  保留 getter/setter 等样板方法（默认跳过，流程图更干净）
          --list              只列出识别到的 Controller 接口入口，不生成流程
          --help              显示本帮助

        示例：
          java -jar java-analyzer.jar --project D:\\work\\order-service --out flows.json
          java -jar java-analyzer.jar --project . --entry OrderController#createOrder
          java -jar java-analyzer.jar --project . --list
        """);
  }
}
