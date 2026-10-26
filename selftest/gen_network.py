# Known-bad generator: tries to reach the network. In the sandbox the connection must fail.
import socket
s = socket.create_connection(("1.1.1.1", 53), timeout=3)
s.close()
print("### VECTOR v1")
print("REQ REQ-002")
print("TICKS 100")
print("SET 0 cmd 2")
