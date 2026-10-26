// Fused AVX2 dot products: weights are decoded inside 256-bit registers and multiplied with
// 8-bit activations in the same pass, so no row is ever expanded in memory. Chosen at run time
// only when the CPU has AVX2 and FMA; otherwise the portable kernels in kernels.hpp are used.
#pragma once
#include <cstdint>
#include "kernels.hpp"

#if (defined(__GNUC__) || defined(__clang__)) && (defined(__x86_64__) || defined(_M_X64))
#define KG_HAVE_AVX2_KERNELS 1
#include <immintrin.h>

namespace kg {

#define KG_AVX2 __attribute__((target("avx2,fma,f16c")))

KG_AVX2 static inline float h2f(const uint8_t* p) { return _cvtsh_ss(rd16(p)); }

KG_AVX2 static inline float hsum8(__m256 v) {
    __m128 lo = _mm256_castps256_ps128(v), hi = _mm256_extractf128_ps(v, 1);
    lo = _mm_add_ps(lo, hi);
    __m128 sh = _mm_movehdup_ps(lo);
    __m128 s = _mm_add_ps(lo, sh);
    sh = _mm_movehl_ps(sh, s);
    s = _mm_add_ss(s, sh);
    return _mm_cvtss_f32(s);
}

// unsigned weights (0..127) times signed activations: 8 int32 sums of 4 products each
KG_AVX2 static inline __m256i dot_u8s8(__m256i w, __m256i x) {
    return _mm256_madd_epi16(_mm256_maddubs_epi16(w, x), _mm256_set1_epi16(1));
}

// signed times signed via the sign trick
KG_AVX2 static inline __m256i dot_s8s8(__m256i w, __m256i x) {
    return dot_u8s8(_mm256_sign_epi8(w, w), _mm256_sign_epi8(x, w));
}

KG_AVX2 static float dot_q8_0_avx2(const uint8_t* src, const QAct& x, int n) {
    __m256 acc = _mm256_setzero_ps();
    for (int b = 0; b < n / 32; b++, src += 34) {
        float d = h2f(src) * x.d[b];
        __m256i w = _mm256_loadu_si256((const __m256i*)(src + 2));
        __m256i xv = _mm256_loadu_si256((const __m256i*)(x.q.data() + 32 * b));
        acc = _mm256_fmadd_ps(_mm256_cvtepi32_ps(dot_s8s8(w, xv)), _mm256_set1_ps(d), acc);
    }
    return hsum8(acc);
}

KG_AVX2 static float dot_q4_k_avx2(const uint8_t* src, const QAct& x, int n) {
    const __m256i m4 = _mm256_set1_epi8(0x0F);
    __m256 acc = _mm256_setzero_ps();
    float mins = 0;
    for (int blk = 0; blk < n / 256; blk++, src += 144) {
        float d = h2f(src);
        float dmin = h2f(src + 2);
        const uint8_t* sc = src + 4;
        const uint8_t* qs = src + 16;
        const int8_t* xq = x.q.data() + 256 * blk;
        const float* xd = x.d.data() + 8 * blk;
        const int32_t* xs = x.s.data() + 16 * blk;
        for (int j = 0; j < 4; j++) {
            uint8_t s0, m0, s1, m1;
            scale_min_k4(2 * j, sc, s0, m0);
            scale_min_k4(2 * j + 1, sc, s1, m1);
            __m256i q = _mm256_loadu_si256((const __m256i*)(qs + 32 * j));
            __m256i lo = _mm256_and_si256(q, m4);
            __m256i hi = _mm256_and_si256(_mm256_srli_epi16(q, 4), m4);
            __m256i x0 = _mm256_loadu_si256((const __m256i*)(xq + 64 * j));
            __m256i x1 = _mm256_loadu_si256((const __m256i*)(xq + 64 * j + 32));
            float dx0 = xd[2 * j], dx1 = xd[2 * j + 1];
            acc = _mm256_fmadd_ps(_mm256_cvtepi32_ps(dot_u8s8(lo, x0)), _mm256_set1_ps(d * (float)s0 * dx0), acc);
            acc = _mm256_fmadd_ps(_mm256_cvtepi32_ps(dot_u8s8(hi, x1)), _mm256_set1_ps(d * (float)s1 * dx1), acc);
            mins += dmin * ((float)m0 * dx0 * (float)(xs[4 * j] + xs[4 * j + 1]) + (float)m1 * dx1 * (float)(xs[4 * j + 2] + xs[4 * j + 3]));
        }
    }
    return hsum8(acc) - mins;
}

KG_AVX2 static float dot_q6_k_avx2(const uint8_t* src, const QAct& x, int n) {
    const __m256i m4 = _mm256_set1_epi8(0x0F);
    const __m256i m30 = _mm256_set1_epi8(0x30);
    __m256 acc = _mm256_setzero_ps();
    float off = 0;
    for (int blk = 0; blk < n / 256; blk++, src += 210) {
        const uint8_t* ql = src;
        const uint8_t* qh = src + 128;
        const int8_t* sc = (const int8_t*)(src + 192);
        float d = h2f(src + 208);
        const int8_t* xq = x.q.data() + 256 * blk;
        const float* xd = x.d.data() + 8 * blk;
        const int32_t* xs = x.s.data() + 16 * blk;
        for (int half = 0; half < 2; half++) {
            __m256i L0 = _mm256_loadu_si256((const __m256i*)ql);
            __m256i L1 = _mm256_loadu_si256((const __m256i*)(ql + 32));
            __m256i H = _mm256_loadu_si256((const __m256i*)qh);
            __m256i q[4];
            q[0] = _mm256_or_si256(_mm256_and_si256(L0, m4), _mm256_and_si256(_mm256_slli_epi16(H, 4), m30));
            q[1] = _mm256_or_si256(_mm256_and_si256(L1, m4), _mm256_and_si256(_mm256_slli_epi16(H, 2), m30));
            q[2] = _mm256_or_si256(_mm256_and_si256(_mm256_srli_epi16(L0, 4), m4), _mm256_and_si256(H, m30));
            q[3] = _mm256_or_si256(_mm256_and_si256(_mm256_srli_epi16(L1, 4), m4), _mm256_and_si256(_mm256_srli_epi16(H, 2), m30));
            for (int k = 0; k < 4; k++) {
                int g = 4 * half + k;  // which 32-value group in this block
                float dx = xd[g];
                float sa = (float)sc[8 * half + 2 * k] , sb = (float)sc[8 * half + 2 * k + 1];
                __m256i xv = _mm256_loadu_si256((const __m256i*)(xq + 32 * g));
                __m256 scale = _mm256_setr_ps(sa, sa, sa, sa, sb, sb, sb, sb);
                __m256 p = _mm256_cvtepi32_ps(dot_u8s8(q[k], xv));
                acc = _mm256_fmadd_ps(_mm256_mul_ps(p, scale), _mm256_set1_ps(d * dx), acc);
                off += d * dx * 32.f * (sa * (float)xs[2 * g] + sb * (float)xs[2 * g + 1]);
            }
            ql += 64;
            qh += 32;
        }
    }
    return hsum8(acc) - off;
}


// Batched path (prompt reading): decode a row once into int8 + per-16 multipliers, then reuse it
// for every token in the batch.
KG_AVX2 static void unpack_row_avx2_raw(uint32_t type, const uint8_t* src, int n, QRow& r);

KG_AVX2 static void unpack_row_avx2(uint32_t type, const uint8_t* src, int n, QRow& r) {
    unpack_row_avx2_raw(type, src, n, r);
    r.has_b = type == T_Q4_K || type == T_Q6_K;
    r.unsigned_q = type == T_Q4_K || type == T_Q6_K;
    for (int c = 0; c < n / 32; c++) {
        float a0 = r.a[2 * c], a1 = r.a[2 * c + 1];
        float* v = r.av.data() + 8 * c;
        v[0] = v[1] = v[2] = v[3] = a0;
        v[4] = v[5] = v[6] = v[7] = a1;
    }
}

KG_AVX2 static void unpack_row_avx2_raw(uint32_t type, const uint8_t* src, int n, QRow& r) {
    if (type == T_Q4_K) {
        const __m256i m4 = _mm256_set1_epi8(0x0F);
        for (int blk = 0; blk < n / 256; blk++, src += 144) {
            float d = h2f(src);
            float dmin = h2f(src + 2);
            const uint8_t* sc = src + 4;
            const uint8_t* qs = src + 16;
            int8_t* qo = r.q.data() + 256 * blk;
            float* ao = r.a.data() + 16 * blk;
            float* bo = r.b.data() + 16 * blk;
            for (int j = 0; j < 4; j++) {
                uint8_t s0, m0, s1, m1;
                scale_min_k4(2 * j, sc, s0, m0);
                scale_min_k4(2 * j + 1, sc, s1, m1);
                __m256i q = _mm256_loadu_si256((const __m256i*)(qs + 32 * j));
                _mm256_storeu_si256((__m256i*)(qo + 64 * j), _mm256_and_si256(q, m4));
                _mm256_storeu_si256((__m256i*)(qo + 64 * j + 32), _mm256_and_si256(_mm256_srli_epi16(q, 4), m4));
                ao[4 * j] = ao[4 * j + 1] = d * (float)s0;
                bo[4 * j] = bo[4 * j + 1] = -dmin * (float)m0;
                ao[4 * j + 2] = ao[4 * j + 3] = d * (float)s1;
                bo[4 * j + 2] = bo[4 * j + 3] = -dmin * (float)m1;
            }
        }
        return;
    }
    if (type == T_Q6_K) {
        const __m256i m4 = _mm256_set1_epi8(0x0F);
        const __m256i m30 = _mm256_set1_epi8(0x30);
        for (int blk = 0; blk < n / 256; blk++, src += 210) {
            const uint8_t* ql = src;
            const uint8_t* qh = src + 128;
            const int8_t* sc = (const int8_t*)(src + 192);
            float d = h2f(src + 208);
            int8_t* qo = r.q.data() + 256 * blk;
            for (int half = 0; half < 2; half++) {
                __m256i L0 = _mm256_loadu_si256((const __m256i*)ql);
                __m256i L1 = _mm256_loadu_si256((const __m256i*)(ql + 32));
                __m256i H = _mm256_loadu_si256((const __m256i*)qh);
                __m256i q0 = _mm256_or_si256(_mm256_and_si256(L0, m4), _mm256_and_si256(_mm256_slli_epi16(H, 4), m30));
                __m256i q1 = _mm256_or_si256(_mm256_and_si256(L1, m4), _mm256_and_si256(_mm256_slli_epi16(H, 2), m30));
                __m256i q2 = _mm256_or_si256(_mm256_and_si256(_mm256_srli_epi16(L0, 4), m4), _mm256_and_si256(H, m30));
                __m256i q3 = _mm256_or_si256(_mm256_and_si256(_mm256_srli_epi16(L1, 4), m4), _mm256_and_si256(_mm256_srli_epi16(H, 2), m30));
                // kept as 0..63; the -32 is applied through the offset b = -32 * a
                _mm256_storeu_si256((__m256i*)(qo), q0);
                _mm256_storeu_si256((__m256i*)(qo + 32), q1);
                _mm256_storeu_si256((__m256i*)(qo + 64), q2);
                _mm256_storeu_si256((__m256i*)(qo + 96), q3);
                qo += 128;
                ql += 64;
                qh += 32;
            }
            for (int k = 0; k < 16; k++) {
                r.a[16 * blk + k] = d * (float)sc[k];
                r.b[16 * blk + k] = -32.f * d * (float)sc[k];
            }
        }
        return;
    }
    unpack_row(type, src, n, r);
}

// Up to 4 tokens per pass: each weight chunk is loaded and prepared once.
KG_AVX2 static void qdot4_avx2(const QRow& r, const QAct* const* x, int nt, int n, float* out) {
    __m256 acc[4] = {_mm256_setzero_ps(), _mm256_setzero_ps(), _mm256_setzero_ps(), _mm256_setzero_ps()};
    const int8_t* wq = r.q.data();
    const float* av = r.av.data();
    const __m256i ones = _mm256_set1_epi16(1);
    if (r.unsigned_q) {
        for (int c = 0; c < n / 32; c++) {
            __m256i w = _mm256_loadu_si256((const __m256i*)(wq + 32 * c));
            __m256 sc = _mm256_loadu_ps(av + 8 * c);
            for (int t = 0; t < nt; t++) {
                __m256i xv = _mm256_loadu_si256((const __m256i*)(x[t]->q.data() + 32 * c));
                __m256i p = _mm256_madd_epi16(_mm256_maddubs_epi16(w, xv), ones);
                acc[t] = _mm256_fmadd_ps(_mm256_mul_ps(_mm256_cvtepi32_ps(p), sc), _mm256_broadcast_ss(&x[t]->d[c]), acc[t]);
            }
        }
    } else {
        for (int c = 0; c < n / 32; c++) {
            __m256i w = _mm256_loadu_si256((const __m256i*)(wq + 32 * c));
            __m256i aw = _mm256_sign_epi8(w, w);
            __m256 sc = _mm256_loadu_ps(av + 8 * c);
            for (int t = 0; t < nt; t++) {
                __m256i xv = _mm256_loadu_si256((const __m256i*)(x[t]->q.data() + 32 * c));
                __m256i p = _mm256_madd_epi16(_mm256_maddubs_epi16(aw, _mm256_sign_epi8(xv, w)), ones);
                acc[t] = _mm256_fmadd_ps(_mm256_mul_ps(_mm256_cvtepi32_ps(p), sc), _mm256_broadcast_ss(&x[t]->d[c]), acc[t]);
            }
        }
    }
    for (int t = 0; t < nt; t++) {
        float o = hsum8(acc[t]);
        if (r.has_b) {
            __m256 ob = _mm256_setzero_ps();
            const float* ds = x[t]->ds.data();
            for (int g = 0; g < n / 16; g += 8) ob = _mm256_fmadd_ps(_mm256_loadu_ps(r.b.data() + g), _mm256_loadu_ps(ds + g), ob);
            o += hsum8(ob);
        }
        out[t] = o;
    }
}

inline bool& simd_disabled() {
    static bool off = false;
    return off;
}

inline bool cpu_has_avx2() {
    static const bool ok = __builtin_cpu_supports("avx2") && __builtin_cpu_supports("fma") && __builtin_cpu_supports("f16c");
    return ok && !simd_disabled();
}

}  // namespace kg
#endif
