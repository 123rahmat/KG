"""Sends malformed and hostile requests; the engine must never crash (ASan build)."""
import hashlib, random, subprocess, sys
eng, model, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
sha = hashlib.sha256(open(model, "rb").read()).hexdigest()
random.seed(2)
cases = [b"GEN 5 0 1 10 1\nMSG user 999999999\nx", b"GEN -1 0 0 1 1\n", b"GEN 5 0 1 10 70\n", b"MSG user 3\nabc",
         b"GEN 99999 0 1 1 1\nMSG user 2\nhi", b"GEN 4 3000 1 10 1\nMSG user 1\nx", b"TOKENIZE 99999999999\n",
         b"LOGITS 0\n", b"GEN 4 500 9 10 1\nMSG root 2\nhi", b"\xff" * 5000, b"GEN 4 0 1 10 1\nMSG user 5\n\xff\xfe\x00\x01\x80"]
for _ in range(n):
    cases.append(bytes(random.randint(0, 255) for _ in range(random.randint(0, 300))))
    cases.append(b"GEN %d %d %d %d %d\nMSG user %d\n" % tuple(random.randint(-5, 50) for _ in range(6))
                 + bytes(random.randint(0, 255) for _ in range(random.randint(0, 60))))
crashes = 0
for c in cases:
    r = subprocess.run([eng, "--model", model, "--sha256", sha, "--threads", "2", "--ctx", "256"], input=c + b"\nQUIT\n",
                       capture_output=True, timeout=300)
    if r.returncode not in (0, 4) or b"Sanitizer" in r.stderr:
        crashes += 1
        print("CRASH", c[:60], r.returncode, r.stderr.decode()[:300])
print("cases", len(cases), "crashes", crashes)
sys.exit(1 if crashes else 0)
