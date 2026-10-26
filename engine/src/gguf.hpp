// Strict GGUF reader. The model file is untrusted input: every length, count, offset and
// shape is checked before use, and anything unexpected stops loading with a clear message.
#pragma once
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

namespace kg {

struct LoadError : std::runtime_error {
    explicit LoadError(const std::string& m) : std::runtime_error(m) {}
};

enum GType : uint32_t {
    T_F32 = 0, T_F16 = 1, T_Q4_0 = 2, T_Q5_0 = 6, T_Q8_0 = 8, T_Q4_K = 12, T_Q6_K = 14, T_BF16 = 30
};

// Bytes per block and elements per block for the supported tensor types.
inline bool type_info(uint32_t t, size_t& block_bytes, size_t& block_elems) {
    switch (t) {
        case T_F32: block_bytes = 4; block_elems = 1; return true;
        case T_F16: block_bytes = 2; block_elems = 1; return true;
        case T_BF16: block_bytes = 2; block_elems = 1; return true;
        case T_Q4_0: block_bytes = 18; block_elems = 32; return true;
        case T_Q5_0: block_bytes = 22; block_elems = 32; return true;
        case T_Q8_0: block_bytes = 34; block_elems = 32; return true;
        case T_Q4_K: block_bytes = 144; block_elems = 256; return true;
        case T_Q6_K: block_bytes = 210; block_elems = 256; return true;
        default: return false;
    }
}

struct Value {
    enum Kind { NUM, STR, ARR_STR, ARR_NUM, OTHER } kind = OTHER;
    double num = 0;
    std::string str;
    std::vector<std::string> strs;
    std::vector<double> nums;
};

struct Tensor {
    std::string name;
    uint32_t type = 0;
    uint64_t ne[4] = {1, 1, 1, 1};
    uint32_t n_dims = 0;
    uint64_t offset = 0;  // relative to data section
    uint64_t size = 0;    // bytes
    const uint8_t* data = nullptr;
    uint64_t row_bytes() const {
        size_t bb = 0, be = 1;
        type_info(type, bb, be);
        return ne[0] / be * bb;
    }
};

class Gguf {
public:
    std::map<std::string, Value> kv;
    std::map<std::string, Tensor> tensors;

    // Limits keep a malformed file from asking for absurd allocations.
    static constexpr uint64_t MAX_STR = 1u << 20;         // 1 MiB per string
    static constexpr uint64_t MAX_ARR = 1u << 22;         // 4M array items
    static constexpr uint64_t MAX_TENSORS = 4096;
    static constexpr uint64_t MAX_KV = 4096;
    static constexpr uint64_t MAX_TOTAL_STR = 512ull << 20;

    void parse(const uint8_t* buf, uint64_t len) {
        p_ = buf;
        len_ = len;
        pos_ = 0;
        total_str_ = 0;
        if (len < 24 || std::memcmp(buf, "GGUF", 4) != 0) throw LoadError("not a GGUF model file");
        pos_ = 4;
        uint32_t ver = u32();
        if (ver != 2 && ver != 3) throw LoadError("unsupported GGUF version " + std::to_string(ver));
        uint64_t nt = u64();
        uint64_t nk = u64();
        if (nt == 0 || nt > MAX_TENSORS) throw LoadError("bad tensor count");
        if (nk > MAX_KV) throw LoadError("bad metadata count");
        for (uint64_t i = 0; i < nk; i++) {
            std::string k = str();
            uint32_t t = u32();
            if (kv.count(k)) throw LoadError("duplicate metadata key " + k);
            kv[k] = value(t, 0);
        }
        uint64_t align = 32;
        auto a = kv.find("general.alignment");
        if (a != kv.end()) {
            if (a->second.kind != Value::NUM) throw LoadError("bad alignment");
            align = (uint64_t)a->second.num;
            if (align == 0 || align > 65536 || (align & (align - 1))) throw LoadError("bad alignment");
        }
        std::vector<Tensor> list;
        for (uint64_t i = 0; i < nt; i++) {
            Tensor t;
            t.name = str();
            t.n_dims = u32();
            if (t.n_dims == 0 || t.n_dims > 4) throw LoadError("tensor " + t.name + ": bad dimension count");
            uint64_t elems = 1;
            for (uint32_t d = 0; d < t.n_dims; d++) {
                t.ne[d] = u64();
                if (t.ne[d] == 0 || t.ne[d] > (1ull << 32)) throw LoadError("tensor " + t.name + ": bad shape");
                if (elems > (1ull << 40) / t.ne[d]) throw LoadError("tensor " + t.name + ": too large");
                elems *= t.ne[d];
            }
            t.type = u32();
            size_t bb = 0, be = 1;
            if (!type_info(t.type, bb, be)) throw LoadError("tensor " + t.name + ": unsupported type " + std::to_string(t.type));
            if (t.ne[0] % be != 0) throw LoadError("tensor " + t.name + ": row not a whole number of blocks");
            t.size = elems / be * bb;
            t.offset = u64();
            if (t.offset % align != 0) throw LoadError("tensor " + t.name + ": misaligned");
            if (tensors.count(t.name)) throw LoadError("duplicate tensor " + t.name);
            list.push_back(t);
            tensors[t.name] = t;
        }
        uint64_t data_start = (pos_ + align - 1) / align * align;
        if (data_start > len_) throw LoadError("file truncated before tensor data");
        uint64_t data_len = len_ - data_start;
        // Every tensor must lie fully inside the file and no two may overlap.
        std::vector<std::pair<uint64_t, uint64_t>> spans;
        for (auto& kvp : tensors) {
            Tensor& t = kvp.second;
            if (t.offset > data_len || t.size > data_len - t.offset)
                throw LoadError("tensor " + t.name + ": data outside the file");
            t.data = p_ + data_start + t.offset;
            spans.push_back({t.offset, t.offset + t.size});
        }
        std::sort(spans.begin(), spans.end());
        for (size_t i = 1; i < spans.size(); i++)
            if (spans[i].first < spans[i - 1].second) throw LoadError("tensor data overlaps");
    }

    const Value* get(const std::string& k) const {
        auto it = kv.find(k);
        return it == kv.end() ? nullptr : &it->second;
    }

    double num(const std::string& k) const {
        const Value* v = get(k);
        if (!v || v->kind != Value::NUM) throw LoadError("missing number " + k);
        return v->num;
    }

    double num_or(const std::string& k, double d) const {
        const Value* v = get(k);
        return v && v->kind == Value::NUM ? v->num : d;
    }

    std::string s(const std::string& k) const {
        const Value* v = get(k);
        if (!v || v->kind != Value::STR) throw LoadError("missing text " + k);
        return v->str;
    }

    const Tensor& t(const std::string& name) const {
        auto it = tensors.find(name);
        if (it == tensors.end()) throw LoadError("missing tensor " + name);
        return it->second;
    }

    const Tensor* t_opt(const std::string& name) const {
        auto it = tensors.find(name);
        return it == tensors.end() ? nullptr : &it->second;
    }

private:
    const uint8_t* p_ = nullptr;
    uint64_t len_ = 0;
    uint64_t pos_ = 0;
    uint64_t total_str_ = 0;

    void need(uint64_t n) {
        if (n > len_ || pos_ > len_ - n) throw LoadError("file truncated in header");
    }
    template <typename T> T rd() {
        need(sizeof(T));
        T v;
        std::memcpy(&v, p_ + pos_, sizeof(T));
        pos_ += sizeof(T);
        return v;
    }
    uint32_t u32() { return rd<uint32_t>(); }
    uint64_t u64() { return rd<uint64_t>(); }
    std::string str() {
        uint64_t n = u64();
        if (n > MAX_STR) throw LoadError("string too long in header");
        total_str_ += n;
        if (total_str_ > MAX_TOTAL_STR) throw LoadError("header too large");
        need(n);
        std::string s((const char*)p_ + pos_, (size_t)n);
        pos_ += n;
        return s;
    }
    double scalar(uint32_t t) {
        switch (t) {
            case 0: return rd<uint8_t>();
            case 1: return rd<int8_t>();
            case 2: return rd<uint16_t>();
            case 3: return rd<int16_t>();
            case 4: return rd<uint32_t>();
            case 5: return rd<int32_t>();
            case 6: return rd<float>();
            case 7: return rd<uint8_t>() ? 1 : 0;
            case 10: return (double)rd<uint64_t>();
            case 11: return (double)rd<int64_t>();
            case 12: return rd<double>();
            default: throw LoadError("bad metadata type");
        }
    }
    Value value(uint32_t t, int depth) {
        Value v;
        if (t == 8) {
            v.kind = Value::STR;
            v.str = str();
        } else if (t == 9) {
            if (depth > 0) throw LoadError("nested arrays not allowed");
            uint32_t et = u32();
            uint64_t n = u64();
            if (n > MAX_ARR) throw LoadError("array too long in header");
            if (et == 8) {
                v.kind = Value::ARR_STR;
                v.strs.reserve((size_t)n);
                for (uint64_t i = 0; i < n; i++) v.strs.push_back(str());
            } else {
                v.kind = Value::ARR_NUM;
                v.nums.reserve((size_t)n);
                for (uint64_t i = 0; i < n; i++) v.nums.push_back(scalar(et));
            }
        } else {
            v.kind = Value::NUM;
            v.num = scalar(t);
        }
        return v;
    }
};

}  // namespace kg
