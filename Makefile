# Kindgleam product build. Fully offline: javac + jar only, no downloads.
JAVAC   := javac
JAR     := jar
# Java 21 needs --enable-preview for the Foreign Function & Memory API; Java 22+ (e.g. 25) does not.
JAVA_FEATURE := $(shell env -u JAVA_TOOL_OPTIONS $(JAVAC) -version 2>&1 | sed -n -E 's/^javac ([0-9]+).*/\1/p')
ifeq ($(JAVA_FEATURE),21)
JFLAGS  := --release 21 --enable-preview -Xlint:-preview
else
JFLAGS  := --release $(JAVA_FEATURE)
endif
MODS    := kg.core kg.gates kg.sil kg.rig kg.verdict kg.harness kg.assist kg.cli kg.app
SRC     := $(shell find modules -name '*.java')

.PHONY: all clean

all: build/.stamp build/native/libkglink.so engine/build/kg-infer

build/.stamp: $(SRC)
	rm -rf build/classes build/mods
	mkdir -p build/classes build/mods
	$(JAVAC) -Xlint:all $(JFLAGS) -Werror \
	  --module-source-path modules -d build/classes $(SRC)
	for m in $(MODS); do $(JAR) --create --date=2026-01-01T00:00:00Z --file build/mods/$$m.jar -C build/classes/$$m . || exit 1; done
	touch $@

CFLAGS_STRICT := -std=c11 -O2 -Wall -Wextra -Werror -pedantic -Wshadow -Wstrict-prototypes -Wcast-qual \
                 -Wdouble-promotion -Wconversion -Wundef -fno-common

build/native/libkglink.so: firmware-support/kg_link.c firmware-support/kg_link.h
	mkdir -p build/native
	gcc $(CFLAGS_STRICT) -fPIC -shared -nostdlib -o $@ firmware-support/kg_link.c

# Assistant engine: standard C++17 only. The binary must import no network or process functions.
CXXFLAGS_ENGINE := -std=c++17 -O3 -Wall -Wextra -Werror -Wconversion -Wno-sign-conversion -pthread

engine/build/kg-infer: $(wildcard engine/src/*.cpp engine/src/*.hpp)
	mkdir -p engine/build
	g++ $(CXXFLAGS_ENGINE) -o $@ engine/src/main.cpp
	if (nm -u $@ 2>/dev/null || nm -D $@) | grep -E ' U _?(socket|connect|getaddrinfo|gethostbyname|bind|listen|accept|send|sendto|recv|recvfrom|system|popen|fork|execv|execve|execl|execvp|dlopen)(@|$$)'; then \
	  echo "engine imports a forbidden function"; rm -f $@; exit 1; fi

clean:
	rm -rf build baseline.txt baseline.sig engine/build
