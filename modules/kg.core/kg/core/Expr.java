package kg.core;

import java.util.ArrayList;
import java.util.List;
import java.util.function.ToIntFunction;

/**
 * Assertion language for requirements over time. A small, strict recursive-descent parser:
 * no code execution, no reflection, every signal name resolved when the vector is loaded.
 *
 *   cond   := impl
 *   impl   := or ( '->' or )?                 a -> b   means "whenever a, also b"
 *   or     := and ( 'or' and )*
 *   and    := not ( 'and' not )*
 *   not    := 'not' not | '(' cond ')' | cmp
 *   cmp    := arith ( '<' | '<=' | '>' | '>=' | '==' | '!=' ) arith
 *   arith  := term ( ('+' | '-') term )*
 *   term   := factor ( ('*' | '/') factor )*
 *   factor := number | signal | '-' factor | '(' arith ')' | abs(arith) | min(arith, arith) | max(arith, arith)
 */
public final class Expr {
    /** Reads one numeric value per column for the current tick. */
    public interface Row {
        double get(int column);
    }

    public sealed interface Num permits Lit, Sig, Bin, Fn, Neg { }

    public record Lit(double v) implements Num { }

    public record Sig(String name, int col) implements Num { }

    public record Bin(char op, Num a, Num b) implements Num { }

    public record Fn(String fn, Num a, Num b) implements Num { }

    public record Neg(Num a) implements Num { }

    public sealed interface Cond permits Cmp, And, Or, Not, Implies { }

    public record Cmp(String op, Num a, Num b) implements Cond { }

    public record And(Cond a, Cond b) implements Cond { }

    public record Or(Cond a, Cond b) implements Cond { }

    public record Not(Cond a) implements Cond { }

    public record Implies(Cond a, Cond b) implements Cond { }

    private final List<String> tok;
    private final ToIntFunction<String> resolve;
    private final String source;
    private int pos;

    private Expr(List<String> tok, ToIntFunction<String> resolve, String source) {
        this.tok = tok;
        this.resolve = resolve;
        this.source = source;
    }

    /** Parses a condition. resolve returns the column of a signal name, or -1 if unknown. */
    public static Cond parse(String text, ToIntFunction<String> resolve) throws InputException {
        if (text.length() > 400) {
            throw new InputException("assertion too long (max 400 characters)");
        }
        Expr e = new Expr(lex(text), resolve, text);
        Cond c = e.impl();
        if (e.pos != e.tok.size()) {
            throw new InputException("unexpected '" + e.tok.get(e.pos) + "' in: " + text);
        }
        return c;
    }

    private static List<String> lex(String s) throws InputException {
        List<String> out = new ArrayList<>();
        int i = 0;
        while (i < s.length()) {
            char c = s.charAt(i);
            if (Character.isWhitespace(c)) {
                i++;
            } else if (Character.isDigit(c) || (c == '.' && i + 1 < s.length() && Character.isDigit(s.charAt(i + 1)))) {
                int st = i;
                while (i < s.length() && (Character.isDigit(s.charAt(i)) || s.charAt(i) == '.')) {
                    i++;
                }
                out.add(s.substring(st, i));
            } else if (Character.isLetter(c) || c == '_') {
                int st = i;
                while (i < s.length() && (Character.isLetterOrDigit(s.charAt(i)) || s.charAt(i) == '_')) {
                    i++;
                }
                out.add(s.substring(st, i));
            } else if (s.startsWith("->", i) || s.startsWith("<=", i) || s.startsWith(">=", i)
                    || s.startsWith("==", i) || s.startsWith("!=", i)) {
                out.add(s.substring(i, i + 2));
                i += 2;
            } else if ("+-*/()<>,".indexOf(c) >= 0) {
                out.add(String.valueOf(c));
                i++;
            } else {
                throw new InputException("character '" + c + "' not allowed in an assertion");
            }
            if (out.size() > 200) {
                throw new InputException("assertion too complex");
            }
        }
        return out;
    }

    private String peek() {
        return pos < tok.size() ? tok.get(pos) : "";
    }

    private void expect(String t) throws InputException {
        if (!peek().equals(t)) {
            throw new InputException("expected '" + t + "' but found '" + peek() + "' in: " + source);
        }
        pos++;
    }

    private Cond impl() throws InputException {
        Cond a = or();
        if (peek().equals("->")) {
            pos++;
            return new Implies(a, or());
        }
        return a;
    }

    private Cond or() throws InputException {
        Cond a = and();
        while (peek().equals("or")) {
            pos++;
            a = new Or(a, and());
        }
        return a;
    }

    private Cond and() throws InputException {
        Cond a = not();
        while (peek().equals("and")) {
            pos++;
            a = new And(a, not());
        }
        return a;
    }

    private Cond not() throws InputException {
        if (peek().equals("not")) {
            pos++;
            return new Not(not());
        }
        if (peek().equals("(")) {
            int save = pos;
            pos++;
            try {
                Cond c = impl();
                expect(")");
                return c;
            } catch (InputException e) {
                pos = save; /* it was a parenthesised arithmetic expression, not a condition */
            }
        }
        Num a = arith();
        String op = peek();
        if (!List.of("<", "<=", ">", ">=", "==", "!=").contains(op)) {
            throw new InputException("expected a comparison after a value in: " + source);
        }
        pos++;
        return new Cmp(op, a, arith());
    }

    private Num arith() throws InputException {
        Num a = term();
        while (peek().equals("+") || peek().equals("-")) {
            char op = tok.get(pos++).charAt(0);
            a = new Bin(op, a, term());
        }
        return a;
    }

    private Num term() throws InputException {
        Num a = factor();
        while (peek().equals("*") || peek().equals("/")) {
            char op = tok.get(pos++).charAt(0);
            a = new Bin(op, a, factor());
        }
        return a;
    }

    private Num factor() throws InputException {
        String t = peek();
        if (t.isEmpty()) {
            throw new InputException("assertion ends too early: " + source);
        }
        pos++;
        if (t.equals("-")) {
            return new Neg(factor());
        }
        if (t.equals("(")) {
            Num a = arith();
            expect(")");
            return a;
        }
        if (Character.isDigit(t.charAt(0)) || t.charAt(0) == '.') {
            try {
                double v = Double.parseDouble(t);
                if (!Double.isFinite(v)) {
                    throw new NumberFormatException();
                }
                return new Lit(v);
            } catch (NumberFormatException e) {
                throw new InputException("bad number '" + t + "'");
            }
        }
        if (t.equals("abs") || t.equals("min") || t.equals("max")) {
            expect("(");
            Num a = arith();
            Num b = null;
            if (!t.equals("abs")) {
                expect(",");
                b = arith();
            }
            expect(")");
            return new Fn(t, a, b);
        }
        if (List.of("and", "or", "not").contains(t)) {
            throw new InputException("'" + t + "' cannot be used as a value in: " + source);
        }
        int col = resolve.applyAsInt(t);
        if (col < 0) {
            throw new InputException("unknown signal '" + t + "' in: " + source);
        }
        return new Sig(t, col);
    }

    public static double eval(Num n, Row r) {
        return switch (n) {
            case Lit l -> l.v();
            case Sig s -> r.get(s.col());
            case Neg g -> -eval(g.a(), r);
            case Bin b -> {
                double x = eval(b.a(), r);
                double y = eval(b.b(), r);
                yield switch (b.op()) {
                    case '+' -> x + y;
                    case '-' -> x - y;
                    case '*' -> x * y;
                    default -> y == 0 ? Double.NaN : x / y;
                };
            }
            case Fn f -> switch (f.fn()) {
                case "abs" -> Math.abs(eval(f.a(), r));
                case "min" -> Math.min(eval(f.a(), r), eval(f.b(), r));
                default -> Math.max(eval(f.a(), r), eval(f.b(), r));
            };
        };
    }

    /** NaN anywhere makes a comparison false, so a division by zero can never pass silently. */
    public static boolean test(Cond c, Row r) {
        return switch (c) {
            case Cmp m -> {
                double a = eval(m.a(), r);
                double b = eval(m.b(), r);
                if (Double.isNaN(a) || Double.isNaN(b)) {
                    yield false;
                }
                yield switch (m.op()) {
                    case "<" -> a < b;
                    case "<=" -> a <= b;
                    case ">" -> a > b;
                    case ">=" -> a >= b;
                    case "==" -> a == b;
                    default -> a != b;
                };
            }
            case And a -> test(a.a(), r) && test(a.b(), r);
            case Or o -> test(o.a(), r) || test(o.b(), r);
            case Not n -> !test(n.a(), r);
            case Implies i -> !test(i.a(), r) || test(i.b(), r);
        };
    }

    /** Signal names used, for printing the values that explain a failure. */
    public static void signals(Cond c, List<Sig> out) {
        switch (c) {
            case Cmp m -> {
                sig(m.a(), out);
                sig(m.b(), out);
            }
            case And a -> {
                signals(a.a(), out);
                signals(a.b(), out);
            }
            case Or o -> {
                signals(o.a(), out);
                signals(o.b(), out);
            }
            case Not n -> signals(n.a(), out);
            case Implies i -> {
                signals(i.a(), out);
                signals(i.b(), out);
            }
        }
    }

    private static void sig(Num n, List<Sig> out) {
        switch (n) {
            case Sig s -> {
                if (out.stream().noneMatch(x -> x.name().equals(s.name()))) {
                    out.add(s);
                }
            }
            case Bin b -> {
                sig(b.a(), out);
                sig(b.b(), out);
            }
            case Fn f -> {
                sig(f.a(), out);
                if (f.b() != null) {
                    sig(f.b(), out);
                }
            }
            case Neg g -> sig(g.a(), out);
            case Lit l -> {
                // constants carry no signal
            }
        }
    }
}
