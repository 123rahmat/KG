// Fast integer dot products. A weight row is unpacked to 8-bit integers with one multiplier
// (and, for Q4_K, one offset) per 16 values; the activations are rounded to 8-bit integers with
// one scale per 32 values. The inner loop is then plain integer multiply-add, which compilers
// turn into wide SIMD instructions. On x86-64 an AVX2 version is built alongside the baseline
// one and picked at run time, so one binary runs on every x86-64 CPU.
#pragma once
#include <cmath>
#include <cstdint>
#include <cstring>
#include "gguf.hpp"
#include "quant.hpp"

#if (defined(__GNUC__) || defined(__clang__)) && (defined(__x86_64__) || defined(_M_X64)) && !defined(_WIN32)
#define KG_MULTIVERSION __attribute__((target_clones("avx2", "default")))
#else
#define KG_MULTIVERSION
#endif

namespace kg {

inline bool int_path(uint32_t type) {
    return type == T_Q4_K || type == T_Q6_K || type == T_Q8_0 || type == T_Q4_0 || type == T_Q5_0;
}

// Activations rounded to int8: q[n], scale per 32 values d[n/32], sum of q per 16 values s[n/16].
struct QAct {
    std::vector<int8_t> q;
    std::vector<float> d;
    std::vector<int32_t> s;
    std::vector<float> ds;  // d[g/2] * s[g] per 16 values, for the offset term
};

inline void quantize_act(const float* x, int n, QAct& o) {
    o.q.resize(n);
    o.d.resize(n / 32);
    o.s.resize(n / 16);
    o.ds.resize(n / 16);
    for (int b = 0; b < n / 32; b++) {
        const float* xb = x + 32 * b;
        float amax = 0;
        for (int i = 0; i < 32; i++) amax = std::max(amax, std::fabs(xb[i]));
        float d = amax / 127.f;
        float id = d > 0 ? 1.f / d : 0.f;
        o.d[b] = d;
        for (int h = 0; h < 2; h++) {
            int32_t s = 0;
            for (int i = 0; i < 16; i++) {
                int v = (int)std::lround(xb[16 * h + i] * id);
                v = v > 127 ? 127 : v < -127 ? -127 : v;
                o.q[32 * b + 16 * h + i] = (int8_t)v;
                s += v;
            }
            o.s[2 * b + h] = s;
            o.ds[2 * b + h] = d * (float)s;
        }
    }
}

// A weight row as int8 values with a multiplier a[] and offset b[] per 16 values:
//   row[i] = a[i/16] * q[i] + b[i/16]
struct QRow {
    std::vector<int8_t> q;
    std::vector<float> a, b;
    std::vector<float> av;  // a expanded to 8 lanes per 32 values (SIMD batched path)
    bool has_b = false;
    bool unsigned_q = false;  // q holds 0..127 (lets the SIMD path skip the sign trick)
    void size(int n) {
        q.resize(n);
        a.resize(n / 16);
        b.resize(n / 16);
        av.resize((size_t)n / 32 * 8);
    }
};

inline void unpack_row(uint32_t type, const uint8_t* src, int n, QRow& r) {
    int8_t* q = r.q.data();
    float* a = r.a.data();
    float* bo = r.b.data();
    switch (type) {
        case T_Q8_0:
            for (int blk = 0; blk < n / 32; blk++, src += 34) {
                float d = f16_to_f32(rd16(src));
                std::memcpy(q + 32 * blk, src + 2, 32);
                a[2 * blk] = a[2 * blk + 1] = d;
                bo[2 * blk] = bo[2 * blk + 1] = 0.f;
            }
            return;
        case T_Q4_0:
            for (int blk = 0; blk < n / 32; blk++, src += 18) {
                float d = f16_to_f32(rd16(src));
                const uint8_t* qs = src + 2;
                for (int j = 0; j < 16; j++) {
                    q[32 * blk + j] = (int8_t)((qs[j] & 0xF) - 8);
                    q[32 * blk + j + 16] = (int8_t)((qs[j] >> 4) - 8);
                }
                a[2 * blk] = a[2 * blk + 1] = d;
                bo[2 * blk] = bo[2 * blk + 1] = 0.f;
            }
            return;
        case T_Q5_0:
            for (int blk = 0; blk < n / 32; blk++, src += 22) {
                float d = f16_to_f32(rd16(src));
                uint32_t qh;
                std::memcpy(&qh, src + 2, 4);
                const uint8_t* qs = src + 6;
                for (int j = 0; j < 16; j++) {
                    int xh0 = ((qh >> j) << 4) & 0x10;
                    int xh1 = (qh >> (j + 12)) & 0x10;
                    q[32 * blk + j] = (int8_t)(((qs[j] & 0xF) | xh0) - 16);
                    q[32 * blk + j + 16] = (int8_t)(((qs[j] >> 4) | xh1) - 16);
                }
                a[2 * blk] = a[2 * blk + 1] = d;
                bo[2 * blk] = bo[2 * blk + 1] = 0.f;
            }
            return;
        case T_Q4_K:
            for (int blk = 0; blk < n / 256; blk++, src += 144) {
                float d = f16_to_f32(rd16(src));
                float dmin = f16_to_f32(rd16(src + 2));
                const uint8_t* sc = src + 4;
                const uint8_t* qs = src + 16;
                int8_t* qo = q + 256 * blk;
                float* ao = a + 16 * blk;
                float* bb = bo + 16 * blk;
                for (int j = 0; j < 4; j++) {
                    uint8_t s0, m0, s1, m1;
                    scale_min_k4(2 * j, sc, s0, m0);
                    scale_min_k4(2 * j + 1, sc, s1, m1);
                    for (int l = 0; l < 32; l++) {
                        qo[64 * j + l] = (int8_t)(qs[32 * j + l] & 0xF);
                        qo[64 * j + 32 + l] = (int8_t)(qs[32 * j + l] >> 4);
                    }
                    ao[4 * j] = ao[4 * j + 1] = d * s0;
                    bb[4 * j] = bb[4 * j + 1] = -dmin * m0;
                    ao[4 * j + 2] = ao[4 * j + 3] = d * s1;
                    bb[4 * j + 2] = bb[4 * j + 3] = -dmin * m1;
                }
            }
            return;
        case T_Q6_K:
            for (int blk = 0; blk < n / 256; blk++, src += 210) {
                const uint8_t* ql = src;
                const uint8_t* qh = src + 128;
                const int8_t* sc = (const int8_t*)(src + 192);
                float d = f16_to_f32(rd16(src + 208));
                int8_t* qo = q + 256 * blk;
                for (int half = 0; half < 2; half++) {
                    for (int l = 0; l < 32; l++) {
                        qo[l] = (int8_t)(((ql[l] & 0xF) | (((qh[l] >> 0) & 3) << 4)) - 32);
                        qo[l + 32] = (int8_t)(((ql[l + 32] & 0xF) | (((qh[l] >> 2) & 3) << 4)) - 32);
                        qo[l + 64] = (int8_t)(((ql[l] >> 4) | (((qh[l] >> 4) & 3) << 4)) - 32);
                        qo[l + 96] = (int8_t)(((ql[l + 32] >> 4) | (((qh[l] >> 6) & 3) << 4)) - 32);
                    }
                    qo += 128;
                    ql += 64;
                    qh += 32;
                }
                for (int k = 0; k < 16; k++) {
                    a[16 * blk + k] = d * (float)sc[k];
                    bo[16 * blk + k] = 0.f;
                }
            }
            return;
        default:
            throw LoadError("no integer kernel for this tensor type");
    }
}

// Sum over groups of 16 of int8 products. The fixed-size inner loop vectorizes well.
KG_MULTIVERSION
inline void group_dots(const int8_t* __restrict w, const int8_t* __restrict x, int groups, int32_t* __restrict out) {
    for (int g = 0; g < groups; g++) {
        int32_t s = 0;
        for (int i = 0; i < 16; i++) s += (int32_t)w[16 * g + i] * (int32_t)x[16 * g + i];
        out[g] = s;
    }
}

// row . x for one unpacked row and one quantized activation vector of length n.
inline float qdot(const QRow& r, const QAct& x, int n, int32_t* tmp) {
    int groups = n / 16;
    group_dots(r.q.data(), x.q.data(), groups, tmp);
    float acc = 0;
    for (int g = 0; g < groups; g++)
        acc += x.d[g >> 1] * (r.a[g] * (float)tmp[g] + r.b[g] * (float)x.s[g]);
    return acc;
}

}  // namespace kg
