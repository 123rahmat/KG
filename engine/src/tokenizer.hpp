// Byte-level BPE tokenizer (GPT-2 style, Qwen2 pre-tokenizer rules).
// Special tokens are never produced from user text: a user who types "<|im_start|>" gets
// ordinary text tokens, so text cannot break out of its role in the conversation.
#pragma once
#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>
#include "gguf.hpp"

namespace kg {

class Tokenizer {
public:
    int im_start = -1, im_end = -1, eot = -1;
    // Qwen2.5-Coder fill-in-the-middle tokens (absent in models that were not trained for it)
    int fim_prefix = -1, fim_suffix = -1, fim_middle = -1, fim_pad = -1, file_sep = -1;
    size_t vocab_size() const { return tokens_.size(); }

    void load(const Gguf& g) {
        std::string model = g.s("tokenizer.ggml.model");
        if (model != "gpt2") throw LoadError("tokenizer type '" + model + "' is not supported (need gpt2 byte-level BPE)");
        const Value* t = g.get("tokenizer.ggml.tokens");
        const Value* m = g.get("tokenizer.ggml.merges");
        if (!t || t->kind != Value::ARR_STR || t->strs.empty()) throw LoadError("missing tokenizer tokens");
        if (!m || m->kind != Value::ARR_STR) throw LoadError("missing tokenizer merges");
        tokens_ = t->strs;
        const Value* types = g.get("tokenizer.ggml.token_type");
        special_.assign(tokens_.size(), false);
        if (types && types->kind == Value::ARR_NUM && types->nums.size() == tokens_.size())
            for (size_t i = 0; i < tokens_.size(); i++) special_[i] = types->nums[i] == 3 || types->nums[i] == 4;
        for (size_t i = 0; i < tokens_.size(); i++) {
            if (!special_[i]) ids_.emplace(tokens_[i], (int)i);
            if (tokens_[i] == "<|im_start|>") im_start = (int)i;
            if (tokens_[i] == "<|im_end|>") im_end = (int)i;
            if (tokens_[i] == "<|endoftext|>") eot = (int)i;
            if (tokens_[i] == "<|fim_prefix|>") fim_prefix = (int)i;
            if (tokens_[i] == "<|fim_suffix|>") fim_suffix = (int)i;
            if (tokens_[i] == "<|fim_middle|>") fim_middle = (int)i;
            if (tokens_[i] == "<|fim_pad|>") fim_pad = (int)i;
            if (tokens_[i] == "<|file_sep|>") file_sep = (int)i;
        }
        if (im_start < 0 || im_end < 0) throw LoadError("model has no chat tokens (<|im_start|>, <|im_end|>); an instruct model is required");
        for (size_t i = 0; i < m->strs.size(); i++) ranks_.emplace(m->strs[i], (int)i);
        // GPT-2 byte to printable character table.
        int n = 0;
        for (int b = 0; b < 256; b++) {
            bool keep = (b >= '!' && b <= '~') || (b >= 0xA1 && b <= 0xAC) || (b >= 0xAE && b <= 0xFF);
            int cp = keep ? b : 256 + n++;
            byte_char_[b] = utf8(cp);
            char_byte_[cp] = (uint8_t)b;
        }
    }

    // Ordinary text to tokens. Never yields special tokens.
    std::vector<int> encode(const std::string& text) const {
        std::vector<int> out;
        std::vector<uint32_t> cps;
        std::vector<size_t> at;  // byte offset of each code point
        decode_utf8(text, cps, at);
        at.push_back(text.size());
        size_t i = 0;
        while (i < cps.size()) {
            size_t j = match(cps, i);
            std::string piece = text.substr(at[i], at[j] - at[i]);
            bpe(piece, out);
            i = j;
        }
        return out;
    }

    // Bytes of one token (special tokens decode to nothing).
    std::string piece(int id) const {
        if (id < 0 || (size_t)id >= tokens_.size() || special_[id]) return "";
        std::string out;
        std::vector<uint32_t> cps;
        std::vector<size_t> at;
        decode_utf8(tokens_[id], cps, at);
        for (uint32_t cp : cps) {
            auto it = char_byte_.find(cp);
            if (it != char_byte_.end()) out += (char)it->second;
        }
        return out;
    }

private:
    std::vector<std::string> tokens_;
    std::vector<bool> special_;
    std::unordered_map<std::string, int> ids_;
    std::unordered_map<std::string, int> ranks_;
    std::string byte_char_[256];
    std::unordered_map<uint32_t, uint8_t> char_byte_;
    mutable std::unordered_map<std::string, std::vector<int>> cache_;

    static std::string utf8(uint32_t cp) {
        std::string s;
        if (cp < 0x80) {
            s += (char)cp;
        } else if (cp < 0x800) {
            s += (char)(0xC0 | (cp >> 6));
            s += (char)(0x80 | (cp & 0x3F));
        } else if (cp < 0x10000) {
            s += (char)(0xE0 | (cp >> 12));
            s += (char)(0x80 | ((cp >> 6) & 0x3F));
            s += (char)(0x80 | (cp & 0x3F));
        } else {
            s += (char)(0xF0 | (cp >> 18));
            s += (char)(0x80 | ((cp >> 12) & 0x3F));
            s += (char)(0x80 | ((cp >> 6) & 0x3F));
            s += (char)(0x80 | (cp & 0x3F));
        }
        return s;
    }

    // Lenient UTF-8 decode: an invalid byte becomes its own code point in the 0xDC80 range so
    // nothing is lost and offsets stay exact.
    static void decode_utf8(const std::string& s, std::vector<uint32_t>& cps, std::vector<size_t>& at) {
        size_t i = 0;
        while (i < s.size()) {
            uint8_t c = (uint8_t)s[i];
            int len = c < 0x80 ? 1 : (c >> 5) == 6 ? 2 : (c >> 4) == 14 ? 3 : (c >> 3) == 30 ? 4 : 0;
            bool ok = len > 0 && i + len <= s.size();
            uint32_t cp = 0;
            if (ok) {
                cp = len == 1 ? c : len == 2 ? (c & 0x1F) : len == 3 ? (c & 0x0F) : (c & 0x07);
                for (int k = 1; k < len; k++) {
                    uint8_t d = (uint8_t)s[i + k];
                    if ((d & 0xC0) != 0x80) {
                        ok = false;
                        break;
                    }
                    cp = (cp << 6) | (d & 0x3F);
                }
            }
            if (!ok) {
                cp = 0xDC00 | c;
                len = 1;
            }
            cps.push_back(cp);
            at.push_back(i);
            i += len;
        }
    }

    static bool is_space(uint32_t c) {
        return c == ' ' || (c >= 9 && c <= 13) || c == 0x85 || c == 0xA0 || c == 0x1680 || (c >= 0x2000 && c <= 0x200A)
               || c == 0x2028 || c == 0x2029 || c == 0x202F || c == 0x205F || c == 0x3000;
    }
    static bool is_num(uint32_t c) { return (c >= '0' && c <= '9') || (c >= 0xFF10 && c <= 0xFF19); }
    static bool is_punct_range(uint32_t c) {
        return (c >= 0x80 && c <= 0xBF) || c == 0xD7 || c == 0xF7 || (c >= 0x2010 && c <= 0x2BFF) || (c >= 0x3001 && c <= 0x303F)
               || (c >= 0xFF01 && c <= 0xFF0F) || (c >= 0xFF1A && c <= 0xFF20) || (c >= 0xDC00 && c <= 0xDCFF)
               || (c >= 0xE000 && c <= 0xF8FF) || (c >= 0x1F000);
    }
    static bool is_letter(uint32_t c) {
        if (c < 0x80) return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
        return !is_space(c) && !is_num(c) && !is_punct_range(c);
    }
    static bool is_nl(uint32_t c) { return c == '\r' || c == '\n'; }
    static uint32_t lower(uint32_t c) { return c >= 'A' && c <= 'Z' ? c + 32 : c; }

    // End index of the pre-token starting at i (Qwen2 split rules).
    static size_t match(const std::vector<uint32_t>& c, size_t i) {
        size_t n = c.size();
        // 1. contractions
        if (c[i] == '\'' && i + 1 < n) {
            uint32_t a = lower(c[i + 1]);
            uint32_t b = i + 2 < n ? lower(c[i + 2]) : 0;
            if ((a == 'r' && b == 'e') || (a == 'v' && b == 'e') || (a == 'l' && b == 'l')) return i + 3;
            if (a == 's' || a == 't' || a == 'm' || a == 'd') return i + 2;
        }
        // 2. optional non-letter/digit/newline prefix, then letters
        {
            size_t j = i;
            if (!is_nl(c[j]) && !is_letter(c[j]) && !is_num(c[j]) && j + 1 < n && is_letter(c[j + 1])) j++;
            if (is_letter(c[j])) {
                while (j < n && is_letter(c[j])) j++;
                return j;
            }
        }
        // 3. one digit
        if (is_num(c[i])) return i + 1;
        // 4. optional space, punctuation run, trailing newlines
        {
            size_t j = i;
            if (c[j] == ' ' && j + 1 < n && !is_space(c[j + 1]) && !is_letter(c[j + 1]) && !is_num(c[j + 1])) j++;
            if (!is_space(c[j]) && !is_letter(c[j]) && !is_num(c[j])) {
                while (j < n && !is_space(c[j]) && !is_letter(c[j]) && !is_num(c[j])) j++;
                while (j < n && is_nl(c[j])) j++;
                return j;
            }
        }
        // 5-7. whitespace
        size_t e = i;
        while (e < n && is_space(c[e])) e++;
        size_t last_nl = n;
        for (size_t k = i; k < e; k++)
            if (is_nl(c[k])) last_nl = k;
        if (last_nl != n) return last_nl + 1;
        if (e == n) return e;
        if (e - i > 1) return e - 1;
        return e > i ? e : i + 1;
    }

    void bpe(const std::string& piece, std::vector<int>& out) const {
        auto hit = cache_.find(piece);
        if (hit != cache_.end()) {
            out.insert(out.end(), hit->second.begin(), hit->second.end());
            return;
        }
        std::vector<std::string> sym;
        for (unsigned char b : piece) sym.push_back(byte_char_[b]);
        while (sym.size() > 1) {
            int best = -1;
            size_t at = 0;
            for (size_t k = 0; k + 1 < sym.size(); k++) {
                auto r = ranks_.find(sym[k] + " " + sym[k + 1]);
                if (r != ranks_.end() && (best < 0 || r->second < best)) {
                    best = r->second;
                    at = k;
                }
            }
            if (best < 0) break;
            sym[at] += sym[at + 1];
            sym.erase(sym.begin() + (long)at + 1);
        }
        std::vector<int> ids;
        for (const std::string& s : sym) {
            auto it = ids_.find(s);
            if (it != ids_.end()) {
                ids.push_back(it->second);
            } else {
                // Fall back to single bytes; every byte has a token in a byte-level vocabulary.
                std::vector<uint32_t> cps;
                std::vector<size_t> at;
                decode_utf8(s, cps, at);
                for (uint32_t cp : cps) {
                    auto b = ids_.find(utf8(cp));
                    if (b != ids_.end()) ids.push_back(b->second);
                }
            }
        }
        if (cache_.size() < 200000) cache_.emplace(piece, ids);
        out.insert(out.end(), ids.begin(), ids.end());
    }
};

}  // namespace kg
