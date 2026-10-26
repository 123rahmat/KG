// Dequantization of one row of weights into floats. Layouts follow the GGML block formats.
#pragma once
#include <cmath>
#include <cstdint>
#include <cstring>
#include "gguf.hpp"

namespace kg {

inline float f16_to_f32(uint16_t h) {
    uint32_t sign = (uint32_t)(h & 0x8000) << 16;
    uint32_t exp = (h >> 10) & 0x1f;
    uint32_t man = h & 0x3ff;
    uint32_t bits;
    if (exp == 0) {
        if (man == 0) {
            bits = sign;
        } else {
            exp = 127 - 15 + 1;
            while (!(man & 0x400)) {
                man <<= 1;
                exp--;
            }
            man &= 0x3ff;
            bits = sign | (exp << 23) | (man << 13);
        }
    } else if (exp == 31) {
        bits = sign | 0x7f800000 | (man << 13);
    } else {
        bits = sign | ((exp + 127 - 15) << 23) | (man << 13);
    }
    float f;
    std::memcpy(&f, &bits, 4);
    return f;
}

inline float bf16_to_f32(uint16_t h) {
    uint32_t bits = (uint32_t)h << 16;
    float f;
    std::memcpy(&f, &bits, 4);
    return f;
}

inline uint16_t rd16(const uint8_t* p) {
    uint16_t v;
    std::memcpy(&v, p, 2);
    return v;
}

static inline void scale_min_k4(int j, const uint8_t* q, uint8_t& d, uint8_t& m) {
    if (j < 4) {
        d = (uint8_t)(q[j] & 63);
        m = (uint8_t)(q[j + 4] & 63);
    } else {
        d = (uint8_t)((q[j + 4] & 0xF) | ((q[j - 4] >> 6) << 4));
        m = (uint8_t)((q[j + 4] >> 4) | ((q[j] >> 6) << 4));
    }
}

// Converts n elements (a whole row) starting at src into y.
inline void dequant_row(uint32_t type, const uint8_t* src, float* y, uint64_t n) {
    switch (type) {
        case T_F32:
            std::memcpy(y, src, n * 4);
            return;
        case T_F16:
            for (uint64_t i = 0; i < n; i++) y[i] = f16_to_f32(rd16(src + 2 * i));
            return;
        case T_BF16:
            for (uint64_t i = 0; i < n; i++) y[i] = bf16_to_f32(rd16(src + 2 * i));
            return;
        case T_Q4_0:
            for (uint64_t b = 0; b < n / 32; b++, src += 18, y += 32) {
                float d = f16_to_f32(rd16(src));
                const uint8_t* qs = src + 2;
                for (int j = 0; j < 16; j++) {
                    y[j] = (float)((qs[j] & 0xF) - 8) * d;
                    y[j + 16] = (float)((qs[j] >> 4) - 8) * d;
                }
            }
            return;
        case T_Q5_0:
            for (uint64_t b = 0; b < n / 32; b++, src += 22, y += 32) {
                float d = f16_to_f32(rd16(src));
                uint32_t qh;
                std::memcpy(&qh, src + 2, 4);
                const uint8_t* qs = src + 6;
                for (int j = 0; j < 16; j++) {
                    int xh0 = ((qh >> j) << 4) & 0x10;
                    int xh1 = (qh >> (j + 12)) & 0x10;
                    y[j] = (float)(((qs[j] & 0xF) | xh0) - 16) * d;
                    y[j + 16] = (float)(((qs[j] >> 4) | xh1) - 16) * d;
                }
            }
            return;
        case T_Q8_0:
            for (uint64_t b = 0; b < n / 32; b++, src += 34, y += 32) {
                float d = f16_to_f32(rd16(src));
                const int8_t* qs = (const int8_t*)(src + 2);
                for (int j = 0; j < 32; j++) y[j] = qs[j] * d;
            }
            return;
        case T_Q4_K:
            for (uint64_t b = 0; b < n / 256; b++, src += 144) {
                float d = f16_to_f32(rd16(src));
                float dmin = f16_to_f32(rd16(src + 2));
                const uint8_t* sc = src + 4;
                const uint8_t* q = src + 16;
                int is = 0;
                for (int j = 0; j < 256; j += 64) {
                    uint8_t s, m;
                    scale_min_k4(is, sc, s, m);
                    float d1 = d * s, m1 = dmin * m;
                    scale_min_k4(is + 1, sc, s, m);
                    float d2 = d * s, m2 = dmin * m;
                    for (int l = 0; l < 32; l++) *y++ = d1 * (q[l] & 0xF) - m1;
                    for (int l = 0; l < 32; l++) *y++ = d2 * (q[l] >> 4) - m2;
                    q += 32;
                    is += 2;
                }
            }
            return;
        case T_Q6_K:
            for (uint64_t b = 0; b < n / 256; b++, src += 210) {
                const uint8_t* ql = src;
                const uint8_t* qh = src + 128;
                const int8_t* sc = (const int8_t*)(src + 192);
                float d = f16_to_f32(rd16(src + 208));
                for (int half = 0; half < 2; half++) {
                    for (int l = 0; l < 32; l++) {
                        int is = l / 16;
                        int q1 = (int)((ql[l] & 0xF) | (((qh[l] >> 0) & 3) << 4)) - 32;
                        int q2 = (int)((ql[l + 32] & 0xF) | (((qh[l] >> 2) & 3) << 4)) - 32;
                        int q3 = (int)((ql[l] >> 4) | (((qh[l] >> 4) & 3) << 4)) - 32;
                        int q4 = (int)((ql[l + 32] >> 4) | (((qh[l] >> 6) & 3) << 4)) - 32;
                        y[l] = d * (float)(sc[is] * q1);
                        y[l + 32] = d * (float)(sc[is + 2] * q2);
                        y[l + 64] = d * (float)(sc[is + 4] * q3);
                        y[l + 96] = d * (float)(sc[is + 6] * q4);
                    }
                    y += 128;
                    ql += 64;
                    qh += 32;
                    sc += 8;
                }
            }
            return;
        default:
            throw LoadError("unsupported tensor type");
    }
}

}  // namespace kg
