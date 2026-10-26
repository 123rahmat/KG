"""kgvec: write Kindgleam test vectors from Python test generators.

Copy this file into your project's tests/ folder and import it from tests/gen_*.py scripts.
A generator only prints vectors; Kindgleam runs it twice in its sandbox, checks that both
runs print exactly the same text, and parses every vector with its normal strict parser.

    from kgvec import Vector
    v = Vector("sp60", req="REQ-001", ticks=4000)
    v.set(0, "setpoint", 60)
    v.check("from 2000 always abs(temp - setpoint) <= 0.5")
    v.emit()

Keep generators deterministic: no clock, no unseeded random (use random.Random(1234)),
no network, no files outside the project.
"""

import re
import sys

_NAME = re.compile(r"[a-z0-9_]{1,24}\Z")
_REQ = re.compile(r"REQ-[0-9]{3,4}\Z")
_SIGNAL = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,40}\Z")


def num(x):
    """Numbers are written the same way on every computer."""
    if isinstance(x, bool):
        raise TypeError("use 0 or 1, not True/False")
    if isinstance(x, int):
        return str(x)
    v = float(x)
    if v != v or v in (float("inf"), float("-inf")):
        raise ValueError("not a finite number: %r" % (x,))
    s = "%.6g" % v
    return "0" if s == "-0" else s


class Vector:
    def __init__(self, name, req, ticks, comment=None):
        if not _NAME.match(name):
            raise ValueError("vector name must be 1-24 of a-z, 0-9, _: %r" % (name,))
        if not _REQ.match(req):
            raise ValueError("requirement id must look like REQ-001: %r" % (req,))
        if not isinstance(ticks, int) or ticks < 1:
            raise ValueError("ticks must be a positive whole number")
        self.name, self.req, self.ticks = name, req, ticks
        self.lines = []
        if comment:
            for c in str(comment).splitlines():
                self.lines.append("# " + c)

    def set(self, tick, signal, value):
        self._tick(tick)
        self._sig(signal)
        self.lines.append("SET %d %s %s" % (tick, signal, num(value)))
        return self

    def fault(self, tick, kind, *args):
        self._tick(tick)
        if kind not in ("hang", "stuck", "offset", "noise", "freeze", "disturb"):
            raise ValueError("unknown fault kind %r" % (kind,))
        parts = [kind] + [a if isinstance(a, str) else num(a) for a in args]
        self.lines.append("FAULT %d %s" % (tick, " ".join(parts)))
        return self

    def check(self, assertion):
        """An ASSERT line without the word ASSERT, e.g. 'always heater <= 1'."""
        a = " ".join(str(assertion).split())
        if not a.startswith(("always ", "from ", "eventually ")):
            raise ValueError("an assertion starts with 'always', 'from' or 'eventually': %r" % (a,))
        self.lines.append("ASSERT " + a)
        return self

    def text(self):
        return "\n".join(["REQ " + self.req, "TICKS %d" % self.ticks] + self.lines) + "\n"

    def emit(self, out=None):
        (out or sys.stdout).write("### VECTOR %s\n%s" % (self.name, self.text()))

    def _tick(self, t):
        if not isinstance(t, int) or t < 0 or t >= self.ticks:
            raise ValueError("tick %r is outside 0..%d" % (t, self.ticks - 1))

    @staticmethod
    def _sig(s):
        if not _SIGNAL.match(s):
            raise ValueError("bad signal name %r" % (s,))
