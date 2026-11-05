package com.heibaihe.analyzer;

import com.sun.source.tree.AnnotationTree;
import com.sun.source.tree.CaseTree;
import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.ConditionalExpressionTree;
import com.sun.source.tree.IfTree;
import com.sun.source.tree.MemberSelectTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.StatementTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.VariableTree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;

import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Java 白盒调用链分析器。
 *
 * <p>使用 JDK 自带的 {@code com.sun.source} 解析 API（jdk.compiler 模块），
 * 不需要 Maven、不需要 JavaParser，JDK 17+ 直接编译运行。
 *
 * <p>分析思路：
 * <ol>
 *   <li>解析全部 .java 源码，建立「类 → 字段 / 方法」索引；</li>
 *   <li>扫描每个方法体，记录方法调用点，并按字段类型 / 局部变量类型 / 链式返回类型解析目标方法；</li>
 *   <li>从 Spring Controller 的接口方法出发，按调用关系做广度优先展开，生成白盒流程。</li>
 * </ol>
 */
public class ProjectAnalyzer {

  private static final Pattern CHAIN = Pattern.compile("([A-Za-z_$][\\w$]*)\\s*\\(\\s*\\)");
  private static final Pattern QUOTED = Pattern.compile("\"([^\"]*)\"");

  private static final String[] HTTP_MAPPINGS = {
    "GetMapping", "PostMapping", "PutMapping", "DeleteMapping", "PatchMapping", "RequestMapping"
  };

  private final Path root;
  private final List<Path> sources;
  private final Map<String, Model.ClassModel> classes = new LinkedHashMap<>();
  private final Map<String, Model.ClassModel> bySimpleName = new HashMap<>();
  private final Set<Model.ClassModel> indexed = new HashSet<>();
  private final List<Model.Diag> diagnostics = new ArrayList<>();
  private Trees trees;
  private boolean includeAccessors = false;

  public ProjectAnalyzer(Path root, List<Path> sources) {
    this.root = root;
    this.sources = sources;
  }

  /** 是否把 getter/setter/toString 等样板方法也画进调用链（默认跳过，保持流程图可读） */
  public void setIncludeAccessors(boolean includeAccessors) {
    this.includeAccessors = includeAccessors;
  }

  // ============================================================
  // 解析
  // ============================================================

  public void parse() throws IOException {
    if (sources.isEmpty()) return;

    JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
    if (compiler == null) {
      throw new IllegalStateException("未找到 Java 编译器：请使用 JDK 17+ 运行（JRE 不含编译器）");
    }

    DiagnosticCollector<JavaFileObject> collector = new DiagnosticCollector<>();
    StandardJavaFileManager fileManager =
        compiler.getStandardFileManager(collector, null, StandardCharsets.UTF_8);

    try {
      Iterable<? extends JavaFileObject> units = fileManager.getJavaFileObjectsFromPaths(sources);
      // -proc:none 关闭注解处理，纯解析；忽略编译错误，尽量产出调用链
      JavacTask task = (JavacTask) compiler.getTask(
          null, fileManager, collector, List.of("-proc:none", "-nowarn"), null, units);

      this.trees = Trees.instance(task);
      Iterable<? extends CompilationUnitTree> parsed = task.parse();

      for (CompilationUnitTree unit : parsed) {
        new StructureScanner(unit).scan(unit, null);
      }
    } finally {
      fileManager.close();
    }

    for (Model.ClassModel c : classes.values()) {
      indexed.add(c);
      bySimpleName.putIfAbsent(c.simpleName, c);
    }

    for (Diagnostic<? extends JavaFileObject> d : collector.getDiagnostics()) {
      if (d.getKind() != Diagnostic.Kind.ERROR) continue;
      Model.Diag diag = new Model.Diag();
      diag.file = d.getSource() == null ? "" : relFile(d.getSource().toUri());
      diag.line = d.getLineNumber();
      diag.message = d.getMessage(null);
      diagnostics.add(diag);
    }
  }

  // ============================================================
  // 流程构建
  // ============================================================

  /**
   * @param entryFilter 入口过滤（类名#方法名 / 方法名 / 类名，均模糊匹配），null 表示全部 Spring Controller 接口
   * @param maxDepth    调用链最大深度
   */
  public List<Model.Flow> buildFlows(String entryFilter, int maxDepth) {
    List<Model.Flow> flows = new ArrayList<>();

    for (Model.ClassModel c : classes.values()) {
      if (!isController(c)) continue;
      for (Model.MethodInfo m : c.methods) {
        if (!isHttpMapping(m)) continue;
        if (!matches(c, m, entryFilter)) continue;
        flows.add(buildFlow(c, m, maxDepth));
      }
    }

    // 没有 Spring 注解（或过滤条件未命中 Controller）时，退化为「按指定入口 / 有调用的方法」生成
    if (flows.isEmpty()) {
      for (Model.ClassModel c : classes.values()) {
        for (Model.MethodInfo m : c.methods) {
          if (m.name.equals("<init>")) continue;
          if (entryFilter != null) {
            if (!matches(c, m, entryFilter)) continue;
          } else if (m.calls.isEmpty()) {
            continue;
          }
          flows.add(buildFlow(c, m, maxDepth));
          if (flows.size() >= 40) break;
        }
        if (flows.size() >= 40) break;
      }
    }

    return flows;
  }

  private Model.Flow buildFlow(Model.ClassModel rootClass, Model.MethodInfo rootMethod, int maxDepth) {
    Model.Flow flow = new Model.Flow();
    flow.entry = rootClass.simpleName + "#" + rootMethod.name;

    Model.HttpInfo http = httpInfo(rootMethod);
    String path = joinPath(classBasePath(rootClass), http.path);
    String prefix = http.httpMethod.isEmpty() ? "" : http.httpMethod + " ";
    flow.name = path.isEmpty() ? prefix + flow.entry : prefix + path + " · " + flow.entry;

    Map<String, Model.MethodRef> nodes = new LinkedHashMap<>();
    Set<String> expanded = new HashSet<>();
    Deque<Object[]> queue = new ArrayDeque<>();

    Model.MethodRef rootRef = makeNode(rootClass, rootMethod, 0, 1, true);
    nodes.put(key(rootClass, rootMethod), rootRef);
    queue.add(new Object[] {rootClass, rootMethod, 0});

    while (!queue.isEmpty()) {
      Object[] cur = queue.poll();
      Model.ClassModel ownerClass = (Model.ClassModel) cur[0];
      Model.MethodInfo ownerMethod = (Model.MethodInfo) cur[1];
      int depth = (Integer) cur[2];

      String k = key(ownerClass, ownerMethod);
      if (!expanded.add(k)) continue;
      if (depth >= maxDepth) continue;

      Model.MethodRef from = nodes.get(k);
      if (from == null) continue;

      for (Model.CallSite site : ownerMethod.calls) {
        Model.MethodInfo target = resolveCall(ownerClass, ownerMethod, site);
        if (target == null || target.owner == null) continue;
        if (!indexed.contains(target.owner)) continue;
        if (!includeAccessors && isTrivialAccessor(target)) continue;

        String tk = key(target.owner, target);
        Model.MethodRef to = nodes.get(tk);
        if (to == null) {
          if (nodes.size() >= 150) continue;
          to = makeNode(target.owner, target, depth + 1, nodes.size() + 1, false);
          nodes.put(tk, to);
          queue.add(new Object[] {target.owner, target, depth + 1});
        }
        flow.addEdge(from.id, to.id, site.condition);
      }
    }

    flow.nodes.addAll(nodes.values());
    return flow;
  }

  private Model.MethodRef makeNode(Model.ClassModel c, Model.MethodInfo m, int depth, int seq, boolean entry) {
    Model.MethodRef ref = new Model.MethodRef();
    ref.id = "m" + seq;
    ref.className = c.simpleName;
    ref.packageName = c.packageName;
    ref.method = m.name;
    ref.signature = m.signature;
    ref.kind = kindOf(c, m, entry);
    ref.file = c.file;
    ref.line = m.line;
    ref.depth = depth;
    ref.entry = entry;
    return ref;
  }

  private static String key(Model.ClassModel c, Model.MethodInfo m) {
    return c.fqn() + "#" + m.signature;
  }

  /** 节点类型：用于画布配色与分组 */
  private static String kindOf(Model.ClassModel c, Model.MethodInfo m, boolean entry) {
    if (entry) return "controller";
    String n = c.simpleName;
    String pkg = c.packageName == null ? "" : c.packageName.toLowerCase();
    if (n.endsWith("Controller")) return "controller";
    if (n.endsWith("Service") || n.endsWith("ServiceImpl")) return "service";
    if (n.endsWith("Mapper") || n.endsWith("Dao") || n.endsWith("Repository")) return "mapper";
    if (n.endsWith("Client") || n.endsWith("Feign")) return "client";
    if (n.endsWith("Util") || n.endsWith("Utils") || n.endsWith("Helper")) return "util";
    if (n.endsWith("Listener") || n.endsWith("Consumer")) return "listener";
    if (pkg.contains(".service")) return "service";
    if (pkg.contains(".mapper") || pkg.contains(".repository") || pkg.contains(".dao")) return "mapper";
    return "component";
  }

  // ============================================================
  // 调用解析
  // ============================================================

  private Model.MethodInfo resolveCall(Model.ClassModel owner, Model.MethodInfo method, Model.CallSite site) {
    Model.ClassModel type;
    String expr = site.expr == null ? null : site.expr.trim();

    if (expr == null || expr.isEmpty() || expr.equals("this")) {
      type = owner;
    } else if (expr.equals("super")) {
      type = resolveType(owner.extendsName, owner);
    } else {
      String typeText = method.localTypes.get(expr);
      if (typeText == null) typeText = fieldType(owner, expr);
      if (typeText == null && expr.startsWith("this.")) {
        typeText = fieldType(owner, expr.substring("this.".length()));
      }
      if (typeText == null) {
        Matcher m = CHAIN.matcher(expr);
        if (m.matches()) {
          Model.MethodInfo getter = owner.findMethod(m.group(1), -1);
          if (getter == null && owner.outer != null) getter = owner.outer.findMethod(m.group(1), -1);
          if (getter != null) typeText = getter.returnType;
        }
      }
      // 兜底：表达式的最后一个标识符当作类名（静态调用）
      if (typeText == null) typeText = expr;
      type = resolveType(typeText, owner);
    }

    if (type == null) return null;

    Model.MethodInfo target = type.findMethod(site.method, site.arity);
    if (target == null && type.extendsName != null) {
      Model.ClassModel parent = resolveType(type.extendsName, type);
      if (parent != null) target = parent.findMethod(site.method, site.arity);
    }
    return target;
  }

  private static String fieldType(Model.ClassModel owner, String name) {
    Model.ClassModel cur = owner;
    while (cur != null) {
      Model.FieldModel f = cur.fields.get(name);
      if (f != null) return f.type;
      cur = cur.outer;
    }
    return null;
  }

  private Model.ClassModel resolveType(String typeText, Model.ClassModel ctx) {
    if (typeText == null) return null;
    String t = typeText.trim();
    if (t.isEmpty()) return null;

    int lt = t.indexOf('<');
    if (lt > 0) t = t.substring(0, lt);
    t = t.replace("[]", "").replace("...", "").trim();
    if (t.isEmpty()) return null;

    Model.ClassModel c = classes.get(t);
    if (c != null) return c;

    String simple = t.substring(t.lastIndexOf('.') + 1);
    c = bySimpleName.get(simple);
    if (c != null) return c;

    // 内部类可能以 Outer$Inner / Outer.Inner 形式出现
    int dot = simple.lastIndexOf('$');
    if (dot > 0) return bySimpleName.get(simple.substring(dot + 1));
    return null;
  }

  // ============================================================
  // Spring 注解识别
  // ============================================================

  private static boolean isController(Model.ClassModel c) {
    return c.hasAnnotation("RestController") || c.hasAnnotation("Controller");
  }

  private static boolean isHttpMapping(Model.MethodInfo m) {
    for (String mapping : HTTP_MAPPINGS) {
      if (m.hasAnnotationPrefix(mapping)) return true;
    }
    return false;
  }

  private static Model.HttpInfo httpInfo(Model.MethodInfo m) {
    Model.HttpInfo info = new Model.HttpInfo();
    for (String ann : m.annotations) {
      String name = ann;
      String args = "";
      int p = ann.indexOf('(');
      if (p >= 0) {
        name = ann.substring(0, p).trim();
        args = ann.substring(p);
      }
      String httpMethod = switch (name) {
        case "GetMapping" -> "GET";
        case "PostMapping" -> "POST";
        case "PutMapping" -> "PUT";
        case "DeleteMapping" -> "DELETE";
        case "PatchMapping" -> "PATCH";
        case "RequestMapping" -> requestMappingMethod(args);
        default -> "";
      };
      if (httpMethod.isEmpty() && !name.equals("RequestMapping")) continue;
      info.httpMethod = httpMethod;
      Matcher q = QUOTED.matcher(args);
      info.path = q.find() ? q.group(1) : "";
      return info;
    }
    return info;
  }

  private static String requestMappingMethod(String args) {
    for (String m : new String[] {"GET", "POST", "PUT", "DELETE", "PATCH"}) {
      if (args.contains("RequestMethod." + m)) return m;
    }
    return "";
  }

  /** 类上的 @RequestMapping("/api/orders") 前缀 */
  private static String classBasePath(Model.ClassModel c) {
    for (String ann : c.annotations) {
      int p = ann.indexOf('(');
      if (p < 0) continue;
      String name = ann.substring(0, p).trim();
      if (!name.endsWith("Mapping")) continue;
      Matcher q = QUOTED.matcher(ann.substring(p));
      if (q.find()) return q.group(1);
    }
    return "";
  }

  /** 是否属于 getter / setter / toString 之类的样板方法 */
  private static boolean isTrivialAccessor(Model.MethodInfo m) {
    if (m.name.equals("<init>") || m.name.equals("toString")
        || m.name.equals("equals") || m.name.equals("hashCode")) {
      return true;
    }
    boolean accessorName = m.name.matches("(get|is|set)[A-Z].*");
    return accessorName && m.calls.size() <= 1;
  }

  private static String joinPath(String base, String path) {
    String b = base == null ? "" : base.trim();
    String p = path == null ? "" : path.trim();
    if (b.isEmpty()) return p;
    if (p.isEmpty()) return b;
    if (b.endsWith("/") && p.startsWith("/")) return b + p.substring(1);
    if (!b.endsWith("/") && !p.startsWith("/")) return b + "/" + p;
    return b + p;
  }

  private static boolean matches(Model.ClassModel c, Model.MethodInfo m, String filter) {
    if (filter == null || filter.isEmpty()) return true;
    String f = filter.toLowerCase();
    String label = (c.simpleName + "#" + m.name).toLowerCase();
    return label.contains(f)
        || c.fqn().toLowerCase().contains(f)
        || m.name.toLowerCase().contains(f)
        || c.simpleName.toLowerCase().contains(f);
  }

  // ============================================================
  // 源码结构扫描
  // ============================================================

  private final class StructureScanner extends TreePathScanner<Void, Void> {
    private final CompilationUnitTree unit;
    private Model.ClassModel current;

    StructureScanner(CompilationUnitTree unit) {
      this.unit = unit;
    }

    @Override
    public Void visitClass(ClassTree node, Void p) {
      String simpleName = node.getSimpleName().toString();
      if (simpleName.isEmpty()) return null; // 匿名类：方法体交给 BodyScanner

      Model.ClassModel prev = current;
      Model.ClassModel cm = new Model.ClassModel();
      cm.simpleName = simpleName;
      cm.packageName = unit.getPackageName() == null ? "" : unit.getPackageName().toString();
      cm.file = relFile(unit.getSourceFile().toUri());
      cm.outer = prev;
      cm.annotations = annotationTexts(node.getModifiers());
      if (node.getExtendsClause() != null) cm.extendsName = node.getExtendsClause().toString();

      String key = cm.fqn();
      if (classes.containsKey(key)) key = key + "$" + simpleName;
      classes.put(key, cm);

      current = cm;
      for (Tree member : node.getMembers()) {
        if (member instanceof VariableTree vt && vt.getType() != null) {
          Model.FieldModel f = new Model.FieldModel();
          f.name = vt.getName().toString();
          f.type = vt.getType().toString();
          cm.fields.put(f.name, f);
        } else if (member instanceof MethodTree mt) {
          cm.methods.add(readMethod(cm, mt));
        } else if (member instanceof ClassTree) {
          scan(member, p);
        }
      }
      current = prev;
      return null;
    }

    private Model.MethodInfo readMethod(Model.ClassModel owner, MethodTree mt) {
      Model.MethodInfo mi = new Model.MethodInfo();
      mi.owner = owner;
      mi.name = mt.getName().toString();
      mi.returnType = mt.getReturnType() == null ? "void" : mt.getReturnType().toString();
      mi.annotations = annotationTexts(mt.getModifiers());
      mi.line = lineOf(unit, mt);
      mi.arity = mt.getParameters().size();

      StringBuilder sig = new StringBuilder(mi.name).append('(');
      List<String> params = new ArrayList<>();
      for (VariableTree param : mt.getParameters()) {
        String type = param.getType() == null ? "" : param.getType().toString();
        params.add(type + " " + param.getName());
        mi.localTypes.put(param.getName().toString(), type);
      }
      mi.signature = sig.append(String.join(", ", params)).append(')').toString();

      if (mt.getBody() != null && !mi.name.equals("<init>")) {
        com.sun.source.util.TreePath bodyPath =
            com.sun.source.util.TreePath.getPath(unit, mt.getBody());
        if (bodyPath != null) {
          new BodyScanner(unit, owner, mi).scan(bodyPath, null);
        }
      }
      return mi;
    }
  }

  /** 方法体扫描：记录局部变量类型与调用点 */
  private final class BodyScanner extends TreePathScanner<Void, Void> {
    private final CompilationUnitTree unit;
    private final Model.ClassModel owner;
    private final Model.MethodInfo method;
    private final Deque<String> conditions = new ArrayDeque<>();

    BodyScanner(CompilationUnitTree unit, Model.ClassModel owner, Model.MethodInfo method) {
      this.unit = unit;
      this.owner = owner;
      this.method = method;
    }

    @Override
    public Void visitVariable(VariableTree node, Void p) {
      if (node.getType() != null) {
        method.localTypes.put(node.getName().toString(), node.getType().toString());
      }
      return super.visitVariable(node, p);
    }

    @Override
    public Void visitIf(IfTree node, Void p) {
      String cond = shorten(node.getCondition().toString(), 110);
      conditions.push(cond);
      try {
        scan(node.getThenStatement(), p);
      } finally {
        conditions.pop();
      }
      if (node.getElseStatement() != null) {
        conditions.push("!(" + cond + ")");
        try {
          scan(node.getElseStatement(), p);
        } finally {
          conditions.pop();
        }
      }
      return null;
    }

    @Override
    public Void visitConditionalExpression(ConditionalExpressionTree node, Void p) {
      conditions.push(shorten(node.getCondition().toString(), 110));
      try {
        scan(node.getTrueExpression(), p);
        scan(node.getFalseExpression(), p);
      } finally {
        conditions.pop();
      }
      return null;
    }

    @Override
    public Void visitSwitch(com.sun.source.tree.SwitchTree node, Void p) {
      for (CaseTree c : node.getCases()) {
        String label = c.getExpressions().isEmpty() ? "default" : c.getExpressions().get(0).toString();
        conditions.push("case " + shorten(label, 60));
        try {
          if (c.getStatements() != null) {
            for (StatementTree s : c.getStatements()) scan(s, p);
          }
          if (c.getBody() != null) scan(c.getBody(), p);
        } finally {
          conditions.pop();
        }
      }
      return null;
    }

    @Override
    public Void visitMethodInvocation(MethodInvocationTree node, Void p) {
      Model.CallSite site = new Model.CallSite();
      if (node.getMethodSelect() instanceof MemberSelectTree ms) {
        site.method = ms.getIdentifier().toString();
        site.expr = ms.getExpression().toString();
      } else {
        site.method = node.getMethodSelect().toString();
        site.expr = null;
      }
      site.arity = node.getArguments().size();
      site.line = lineOf(unit, node);
      site.condition = conditions.isEmpty() ? "" : conditions.peek();
      method.calls.add(site);
      return super.visitMethodInvocation(node, p);
    }
  }

  // ============================================================
  // 工具
  // ============================================================

  private static List<String> annotationTexts(com.sun.source.tree.ModifiersTree modifiers) {
    List<String> out = new ArrayList<>();
    if (modifiers == null) return out;
    for (AnnotationTree a : modifiers.getAnnotations()) {
      out.add(a.toString().replaceFirst("^@", "").trim());
    }
    return out;
  }

  private int lineOf(CompilationUnitTree unit, Tree tree) {
    try {
      long pos = trees.getSourcePositions().getStartPosition(unit, tree);
      if (pos < 0) return 0;
      return (int) unit.getLineMap().getLineNumber(pos);
    } catch (Exception e) {
      return 0;
    }
  }

  private String shorten(String path) {
    try {
      Path p = Path.of(path);
      Path rel = root.relativize(p);
      return rel.toString().replace('\\', '/');
    } catch (Exception e) {
      return path;
    }
  }

  /** URI → 相对工程根目录的路径（统一用 / 分隔，便于跨平台展示） */
  private String relFile(java.net.URI uri) {
    try {
      Path p = Path.of(uri);
      return root.relativize(p).toString().replace('\\', '/');
    } catch (Exception e) {
      return uri.getPath() == null ? uri.toString() : uri.getPath();
    }
  }

  private static String shorten(String s, int max) {
    String one = s.replaceAll("\\s+", " ").trim();
    return one.length() <= max ? one : one.substring(0, max) + "…";
  }

  // ============================================================
  // 对外只读信息
  // ============================================================

  public int classCount() {
    return classes.size();
  }

  public List<Model.Diag> getDiagnostics() {
    return diagnostics;
  }

  public List<Model.ClassModel> getClasses() {
    return new ArrayList<>(classes.values());
  }

  public List<Model.MethodRef> listEntries() {
    List<Model.MethodRef> out = new ArrayList<>();
    for (Model.ClassModel c : classes.values()) {
      for (Model.MethodInfo m : c.methods) {
        if (!isHttpMapping(m)) continue;
        Model.MethodRef ref = new Model.MethodRef();
        ref.className = c.simpleName;
        ref.packageName = c.packageName;
        ref.method = m.name;
        ref.signature = m.signature;
        ref.file = c.file;
        ref.line = m.line;
        ref.kind = "controller";
        ref.entry = true;
        out.add(ref);
      }
    }
    return out;
  }

  public static Set<String> knownKinds() {
    return new LinkedHashSet<>(List.of(
        "controller", "service", "mapper", "client", "util", "listener", "component", "method"));
  }
}
