// kg-infer: Kindgleam's local code-assistant engine.
//
// Safety design:
//  - No networking code of any kind; the build checks the binary imports no socket functions.
//  - The model file is hashed while it is read, and the exact bytes in memory must match the
//    SHA-256 the app passes in (the app has already checked the signature of that hash).
//  - The file is parsed as untrusted input with strict bounds checks (gguf.hpp).
//  - Text from the user can never become a control token (tokenizer.hpp).
//  - Each request starts from an empty context and has token and time limits.
//  - The engine only reads requests from stdin and writes tokens to stdout. It opens no other
//    files after loading and runs no commands.
//
// Protocol (stdin, binary safe):
//   GEN <max_tokens> <temperature_milli> <seed> <max_seconds> <n_messages>\n
//   then per message: MSG <system|user|assistant> <n_bytes>\n<bytes>
//   QUIT\n
// Replies (stdout): READY ..., T <hex bytes>, END <reason> <prompt_tokens> <generated> <ms>, ERR <text>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <random>
#include <string>
#include <vector>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif
#include "gguf.hpp"
#include "model.hpp"
#include "sha256.hpp"
#include "tokenizer.hpp"

using namespace kg;

static const size_t MAX_REQUEST_BYTES = 2u << 20;

static void out(const std::string& s) {
    std::fwrite(s.data(), 1, s.size(), stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
}

static std::string hex(const std::string& b) {
    static const char* d = "0123456789abcdef";
    std::string s;
    for (unsigned char c : b) {
        s += d[c >> 4];
        s += d[c & 15];
    }
    return s;
}

static bool read_line(std::string& line) {
    line.clear();
    int c;
    while ((c = std::fgetc(stdin)) != EOF) {
        if (c == '\n') return true;
        if (line.size() > 256) return false;
        line += (char)c;
    }
    return !line.empty();
}

static std::vector<uint8_t> load_file(const std::string& path, std::string& sha) {
    std::ifstream f(path, std::ios::binary);
    if (!f) throw LoadError("cannot open model file");
    f.seekg(0, std::ios::end);
    std::streamoff n = f.tellg();
    if (n < 64 || n > (std::streamoff)(64ll << 30)) throw LoadError("model file size is out of range");
    f.seekg(0);
    std::vector<uint8_t> buf((size_t)n);
    Sha256 h;
    size_t got = 0;
    const size_t chunk = 8u << 20;
    while (got < buf.size()) {
        size_t k = std::min(chunk, buf.size() - got);
        f.read((char*)buf.data() + got, (std::streamsize)k);
        if ((size_t)f.gcount() != k) throw LoadError("model file could not be read completely");
        h.update(buf.data() + got, k);
        got += k;
    }
    sha = h.hex();
    return buf;
}

static int sample(const std::vector<float>& logits, float temp, std::mt19937_64& rng) {
    int best = 0;
    for (size_t i = 1; i < logits.size(); i++)
        if (logits[i] > logits[best]) best = (int)i;
    if (temp <= 0.f) return best;
    std::vector<std::pair<float, int>> p;
    float mx = logits[best];
    double sum = 0;
    for (size_t i = 0; i < logits.size(); i++) {
        float e = std::exp((logits[i] - mx) / temp);
        if (e > 1e-6f) {
            p.push_back({e, (int)i});
            sum += e;
        }
    }
    std::sort(p.begin(), p.end(), [](auto& a, auto& b) { return a.first > b.first; });
    double keep = 0;
    size_t cut = 0;
    while (cut < p.size() && keep < 0.9 * sum) keep += p[cut++].first;
    std::uniform_real_distribution<double> u(0.0, keep);
    double r = u(rng);
    for (size_t i = 0; i < cut; i++) {
        r -= p[i].first;
        if (r <= 0) return p[i].second;
    }
    return p[0].second;
}

// Generation loop shared by chat (GEN) and fill-in-the-middle (FIM) requests.
//  - Mild repetition penalty on the last 64 generated tokens only (never on the prompt, so the
//    model can still reproduce existing code exactly).
//  - Loop guard: if the same block of 4..40 tokens has just appeared three times in a row, stop.
static void generate(Model& m, const Tokenizer& tok, const std::vector<int>& prompt, int max_tok, float temp,
                     unsigned long long seed, int max_s, const std::vector<int>& stops) {
    auto t0 = std::chrono::steady_clock::now();
    std::mt19937_64 rng(seed);
    std::vector<float> logits;
    for (size_t at = 0; at < prompt.size(); at += 64) {
        std::vector<int> chunk(prompt.begin() + (long)at, prompt.begin() + (long)std::min(prompt.size(), at + 64));
        logits = m.forward(chunk, (int)at);
    }
    int pos = (int)prompt.size();
    int gen = 0;
    std::vector<int> hist;
    std::string reason = "length";
    while (gen < max_tok) {
        if (pos >= m.n_ctx) {
            reason = "context";
            break;
        }
        double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
        if (secs > max_s) {
            reason = "time";
            break;
        }
        size_t from = hist.size() > 64 ? hist.size() - 64 : 0;
        std::vector<int> seen(hist.begin() + (long)from, hist.end());
        std::sort(seen.begin(), seen.end());
        seen.erase(std::unique(seen.begin(), seen.end()), seen.end());
        for (int s : seen) {
            float& l = logits[(size_t)s];
            l = l > 0 ? l / 1.05f : l * 1.05f;
        }
        int id = sample(logits, temp, rng);
        if (id == tok.im_end || id == tok.eot || std::find(stops.begin(), stops.end(), id) != stops.end()) {
            reason = "stop";
            break;
        }
        hist.push_back(id);
        std::string p = tok.piece(id);
        if (!p.empty()) out("T " + hex(p));
        gen++;
        bool loop = false;
        for (size_t w = 4; w <= 40 && !loop && hist.size() >= 3 * w; w++) {
            size_t n = hist.size();
            loop = std::equal(hist.end() - (long)w, hist.end(), hist.end() - (long)(2 * w))
                   && std::equal(hist.end() - (long)w, hist.end(), hist.end() - (long)(3 * w));
            (void)n;
        }
        if (loop) {
            reason = "loop";
            break;
        }
        logits = m.forward({id}, pos++);
    }
    long ms = (long)std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
    out("END " + reason + " " + std::to_string(prompt.size()) + " " + std::to_string(gen) + " " + std::to_string(ms));
}

int main(int argc, char** argv) {
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    std::string path, want, mode = "serve";
    bool exact = false;
    int ctx = 4096, threads = (int)std::max(1u, std::thread::hardware_concurrency());
    for (int i = 1; i + 1 < argc; i += 2) {
        std::string a = argv[i], v = argv[i + 1];
        if (a == "--model") path = v;
        else if (a == "--sha256") want = v;
        else if (a == "--ctx") ctx = std::max(64, std::min(32768, std::atoi(v.c_str())));
        else if (a == "--threads") threads = std::max(1, std::min(64, std::atoi(v.c_str())));
        else if (a == "--mode") mode = v;
        else if (a == "--exact") exact = v == "1";
#ifdef KG_HAVE_AVX2_KERNELS
        else if (a == "--simd") simd_disabled() = v == "0";
#else
        else if (a == "--simd") {}
#endif
        else {
            out("ERR unknown option " + a);
            return 2;
        }
    }
    // --sha256 takes one fingerprint or several separated by commas (every published file accepted)
    std::vector<std::string> wants;
    {
        size_t at = 0;
        while (at <= want.size()) {
            size_t c = want.find(',', at);
            std::string one = want.substr(at, c == std::string::npos ? std::string::npos : c - at);
            if (!one.empty()) wants.push_back(one);
            if (c == std::string::npos) break;
            at = c + 1;
        }
    }
    bool shape_ok = !wants.empty() && wants.size() <= 8;
    for (const std::string& w : wants) shape_ok = shape_ok && w.size() == 64 && w.find_first_not_of("0123456789abcdef") == std::string::npos;
    if (path.empty() || !shape_ok) {
        out("ERR usage: kg-infer --model <file.gguf> --sha256 <hash>[,<hash>...] [--ctx N] [--threads N]");
        return 2;
    }
    try {
        std::string sha;
        std::vector<uint8_t> file = load_file(path, sha);
        if (std::find(wants.begin(), wants.end(), sha) == wants.end()) {
            out("ERR model file hash " + sha + " is not one of the published model files; refusing to load");
            return 3;
        }
        Gguf g;
        g.parse(file.data(), file.size());
        Tokenizer tok;
        tok.load(g);
        Model m(g, ctx, threads, exact);
        if ((int)tok.vocab_size() > m.n_vocab) throw LoadError("tokenizer and model vocabulary sizes differ");
        out("READY vocab=" + std::to_string(m.n_vocab) + " ctx=" + std::to_string(m.n_ctx) + " layers="
            + std::to_string(m.n_layer) + " threads=" + std::to_string(threads));

        std::string line;
        while (read_line(line)) {
            if (line == "QUIT") break;
            if (line.rfind("TOKENIZE ", 0) == 0 || line.rfind("LOGITS ", 0) == 0) {
                // Test commands used by the self-test against the reference implementation.
                bool logits = line[0] == 'L';
                size_t n = std::strtoul(line.c_str() + (logits ? 7 : 9), nullptr, 10);
                if (n > MAX_REQUEST_BYTES) {
                    out("ERR request too large");
                    return 4;
                }
                std::string body(n, '\0');
                if (std::fread(&body[0], 1, n, stdin) != n) return 4;
                std::vector<int> ids = tok.encode(body);
                std::string s = logits ? "L" : "IDS";
                if (logits) {
                    if (ids.empty()) {
                        out("ERR empty");
                        continue;
                    }
                    std::vector<float> lg = m.forward(ids, 0);
                    char b[32];
                    for (float f : lg) {
                        std::snprintf(b, sizeof b, " %.6g", f);
                        s += b;
                    }
                } else {
                    for (int id : ids) s += " " + std::to_string(id);
                }
                out(s);
                continue;
            }
            if (line.rfind("FIM ", 0) == 0) {
                // FIM <max_tokens> <max_seconds> <prefix_bytes> <suffix_bytes>, then the two texts.
                int fmax = 0, fsec = 0;
                unsigned long np = 0, ns = 0;
                if (std::sscanf(line.c_str(), "FIM %d %d %lu %lu", &fmax, &fsec, &np, &ns) != 4 || fmax < 1 || fmax > 512
                    || fsec < 1 || np + ns > MAX_REQUEST_BYTES) {
                    out("ERR bad request");
                    return 4;
                }
                std::string pre(np, '\0'), suf(ns, '\0');
                if ((np && std::fread(&pre[0], 1, np, stdin) != np) || (ns && std::fread(&suf[0], 1, ns, stdin) != ns)) return 4;
                if (tok.fim_prefix < 0 || tok.fim_suffix < 0 || tok.fim_middle < 0) {
                    out("ERR this model has no fill-in-the-middle tokens");
                    continue;
                }
                std::vector<int> prompt{tok.fim_prefix};
                for (int id : tok.encode(pre)) prompt.push_back(id);
                prompt.push_back(tok.fim_suffix);
                for (int id : tok.encode(suf)) prompt.push_back(id);
                prompt.push_back(tok.fim_middle);
                if ((int)prompt.size() >= m.n_ctx - fmax - 8) {
                    out("ERR the file is too long for completion; it has " + std::to_string(prompt.size()) + " tokens");
                    continue;
                }
                std::vector<int> stops;
                for (int s : {tok.fim_pad, tok.file_sep, tok.fim_prefix, tok.fim_suffix, tok.fim_middle}) {
                    if (s >= 0) stops.push_back(s);
                }
                generate(m, tok, prompt, fmax, 0.f, 1, fsec, stops);
                continue;
            }
            int max_tok = 0, temp_milli = 0, max_s = 0, n_msg = 0;
            unsigned long long seed = 0;
            if (std::sscanf(line.c_str(), "GEN %d %d %llu %d %d", &max_tok, &temp_milli, &seed, &max_s, &n_msg) != 5
                || max_tok < 1 || n_msg < 1 || n_msg > 64 || temp_milli < 0 || temp_milli > 2000 || max_s < 1) {
                out("ERR bad request");
                return 4;
            }
            std::vector<int> prompt;
            size_t total = 0;
            bool bad = false;
            for (int i = 0; i < n_msg; i++) {
                std::string h;
                char role[16] = {0};
                unsigned long n = 0;
                if (!read_line(h) || std::sscanf(h.c_str(), "MSG %15s %lu", role, &n) != 2) {
                    bad = true;
                    break;
                }
                std::string r = role;
                total += n;
                if ((r != "system" && r != "user" && r != "assistant") || total > MAX_REQUEST_BYTES) {
                    bad = true;
                    break;
                }
                std::string body(n, '\0');
                if (n && std::fread(&body[0], 1, n, stdin) != n) {
                    bad = true;
                    break;
                }
                prompt.push_back(tok.im_start);
                for (int id : tok.encode(r + "\n")) prompt.push_back(id);
                for (int id : tok.encode(body)) prompt.push_back(id);
                prompt.push_back(tok.im_end);
                for (int id : tok.encode("\n")) prompt.push_back(id);
            }
            if (bad) {
                out("ERR bad message");
                return 4;
            }
            prompt.push_back(tok.im_start);
            for (int id : tok.encode("assistant\n")) prompt.push_back(id);
            if ((int)prompt.size() >= m.n_ctx - 8) {
                out("ERR prompt has " + std::to_string(prompt.size()) + " tokens; the limit is " + std::to_string(m.n_ctx - 8));
                continue;
            }
            generate(m, tok, prompt, max_tok, (float)temp_milli / 1000.f, seed, max_s, {});
        }
    } catch (const std::exception& e) {
        out(std::string("ERR ") + e.what());
        return 1;
    }
    return 0;
}
