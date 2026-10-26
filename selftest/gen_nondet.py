# Known-bad generator: prints different text on every run (128 random bits, so two runs never match).
import os
print("### VECTOR v1")
print("# run " + os.urandom(16).hex())
print("REQ REQ-002")
print("TICKS 100")
print("SET 0 cmd 2")
print("ASSERT always level <= 300")
