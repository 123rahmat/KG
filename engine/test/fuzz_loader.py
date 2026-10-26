"""Corrupts the header of a valid model file in many ways; the engine must refuse each one
cleanly (exit 1 with ERR) and never crash. Run against an AddressSanitizer build."""
import hashlib, os, random, subprocess, sys
eng, src, work, n = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
data = open(src, "rb").read()
random.seed(1)
crashes = 0
outcomes = {}
for i in range(n):
    b = bytearray(data)
    for _ in range(random.randint(1, 6)):
        pos = random.randint(0, 6000)
        b[pos] = random.choice([0, 255, random.randint(0, 255)])
    if random.random() < 0.2:
        b = b[:random.randint(0, len(b))]
    p = os.path.join(work, "fuzz.gguf")
    open(p, "wb").write(b)
    r = subprocess.run([eng, "--model", p, "--sha256", hashlib.sha256(b).hexdigest(), "--threads", "2"],
                       input=b"QUIT\n", capture_output=True, timeout=120)
    if r.returncode not in (0, 1) or b"Sanitizer" in r.stderr:
        crashes += 1
        print("CRASH", i, r.returncode, r.stderr.decode()[:300])
    outcomes[r.returncode] = outcomes.get(r.returncode, 0) + 1
print("runs", n, "outcomes", outcomes, "crashes", crashes)
sys.exit(1 if crashes else 0)
