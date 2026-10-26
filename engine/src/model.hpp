// Qwen2-family transformer, CPU only. Weights stay in their original quantized form and are
// expanded one row at a time while multiplying, so memory stays close to the file size.
#pragma once
#include <algorithm>
#include <atomic>
#include <cmath>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include "gguf.hpp"
#include "kernels.hpp"
#include "simd.hpp"
#include "quant.hpp"

namespace kg {

class Pool {
public:
    explicit Pool(int n) : n_(std::max(1, n)) {
        for (int i = 1; i < n_; i++) workers_.emplace_back([this, i] { loop(i); });
    }
    ~Pool() {
        {
            std::lock_guard<std::mutex> l(m_);
            stop_ = true;
            gen_++;
        }
        cv_.notify_all();
        for (auto& t : workers_) t.join();
    }
    int size() const { return n_; }

    // Runs fn(thread, begin, end) over [0, total) split across all threads.
    void run(size_t total, const std::function<void(int, size_t, size_t)>& fn) {
        if (n_ == 1 || total < 2) {
            fn(0, 0, total);
            return;
        }
        {
            std::lock_guard<std::mutex> l(m_);
            fn_ = &fn;
            total_ = total;
            pending_ = n_ - 1;
            gen_++;
        }
        cv_.notify_all();
        part(0);
        std::unique_lock<std::mutex> l(m_);
        done_.wait(l, [this] { return pending_ == 0; });
    }

private:
    int n_;
    std::vector<std::thread> workers_;
    std::mutex m_;
    std::condition_variable cv_, done_;
    const std::function<void(int, size_t, size_t)>* fn_ = nullptr;
    size_t total_ = 0;
    int pending_ = 0;
    uint64_t gen_ = 0;
    bool stop_ = false;

    void part(int i) {
        size_t b = total_ * i / n_, e = total_ * (i + 1) / n_;
        if (b < e) (*fn_)(i, b, e);
    }
    void loop(int i) {
        uint64_t seen = 0;
        for (;;) {
            std::unique_lock<std::mutex> l(m_);
            cv_.wait(l, [&] { return gen_ != seen; });
            seen = gen_;
            if (stop_) return;
            l.unlock();
            part(i);
            l.lock();
            if (--pending_ == 0) done_.notify_one();
        }
    }
};

struct Layer {
    const Tensor *wq, *wk, *wv, *wo, *wg, *wu, *wd;
    std::vector<float> attn_norm, ffn_norm, bq, bk, bv;
};

class Model {
public:
    int n_layer = 0, n_embd = 0, n_ff = 0, n_head = 0, n_kv = 0, head_dim = 0, n_vocab = 0, n_ctx = 0;
    float eps = 1e-6f, rope_base = 1000000.f;

    Model(const Gguf& g, int ctx, int threads, bool exact = false) : pool_(threads), exact_(exact) {
        std::string arch = g.s("general.architecture");
        if (arch != "qwen2") throw LoadError("model architecture '" + arch + "' is not supported (need qwen2)");
        n_layer = (int)g.num("qwen2.block_count");
        n_embd = (int)g.num("qwen2.embedding_length");
        n_ff = (int)g.num("qwen2.feed_forward_length");
        n_head = (int)g.num("qwen2.attention.head_count");
        n_kv = (int)g.num_or("qwen2.attention.head_count_kv", n_head);
        eps = (float)g.num_or("qwen2.attention.layer_norm_rms_epsilon", 1e-6);
        rope_base = (float)g.num_or("qwen2.rope.freq_base", 1000000.0);
        int train_ctx = (int)g.num_or("qwen2.context_length", 4096);
        if (n_layer < 1 || n_layer > 256 || n_embd < 8 || n_embd > 65536 || n_head < 1 || n_kv < 1 || n_head % n_kv
            || n_embd % n_head || n_ff < 1 || n_ff > 262144)
            throw LoadError("model settings are out of range");
        head_dim = n_embd / n_head;
        if (head_dim % 2) throw LoadError("odd head size");
        n_ctx = std::min(ctx, train_ctx);
        if (n_ctx < 16) throw LoadError("context too small");

        embd_ = &shape(g, "token_embd.weight", n_embd, -1);
        n_vocab = (int)embd_->ne[1];
        out_norm_ = vec(g, "output_norm.weight", n_embd);
        out_ = g.t_opt("output.weight") ? &shape(g, "output.weight", n_embd, n_vocab) : embd_;
        int kvd = n_kv * head_dim;
        for (int l = 0; l < n_layer; l++) {
            std::string p = "blk." + std::to_string(l) + ".";
            Layer L;
            L.wq = &shape(g, p + "attn_q.weight", n_embd, n_embd);
            L.wk = &shape(g, p + "attn_k.weight", n_embd, kvd);
            L.wv = &shape(g, p + "attn_v.weight", n_embd, kvd);
            L.wo = &shape(g, p + "attn_output.weight", n_embd, n_embd);
            L.wg = &shape(g, p + "ffn_gate.weight", n_embd, n_ff);
            L.wu = &shape(g, p + "ffn_up.weight", n_embd, n_ff);
            L.wd = &shape(g, p + "ffn_down.weight", n_ff, n_embd);
            L.attn_norm = vec(g, p + "attn_norm.weight", n_embd);
            L.ffn_norm = vec(g, p + "ffn_norm.weight", n_embd);
            L.bq = g.t_opt(p + "attn_q.bias") ? vec(g, p + "attn_q.bias", n_embd) : std::vector<float>(n_embd, 0.f);
            L.bk = g.t_opt(p + "attn_k.bias") ? vec(g, p + "attn_k.bias", kvd) : std::vector<float>(kvd, 0.f);
            L.bv = g.t_opt(p + "attn_v.bias") ? vec(g, p + "attn_v.bias", kvd) : std::vector<float>(kvd, 0.f);
            layers_.push_back(std::move(L));
        }
        kc_.assign((size_t)n_layer * n_ctx * kvd, 0.f);
        vc_.assign((size_t)n_layer * n_ctx * kvd, 0.f);
        rows_.assign(pool_.size(), std::vector<float>(std::max(n_embd, n_ff)));
        qrows_.resize(pool_.size());
        for (auto& r : qrows_) r.size(std::max(n_embd, n_ff));
        tmp_.assign(pool_.size(), std::vector<int32_t>(std::max(n_embd, n_ff) / 16 + 1));
        inv_freq_.resize(head_dim / 2);
        for (int i = 0; i < head_dim / 2; i++) inv_freq_[i] = std::pow(rope_base, -2.0f * (float)i / (float)head_dim);
    }

    // Runs tokens at positions [pos, pos+n) and returns logits for the last one.
    std::vector<float> forward(const std::vector<int>& toks, int pos) {
        int B = (int)toks.size();
        if (B == 0 || pos < 0 || pos + B > n_ctx) throw std::runtime_error("context full");
        int kvd = n_kv * head_dim;
        std::vector<float> x((size_t)B * n_embd), h((size_t)B * n_embd), q((size_t)B * n_embd), k((size_t)B * kvd),
            v((size_t)B * kvd), att((size_t)B * n_embd), g((size_t)B * n_ff), u((size_t)B * n_ff), o((size_t)B * n_embd);
        for (int b = 0; b < B; b++) {
            if (toks[b] < 0 || toks[b] >= n_vocab) throw std::runtime_error("bad token");
            dequant_row(embd_->type, embd_->data + (uint64_t)toks[b] * embd_->row_bytes(), &x[(size_t)b * n_embd], n_embd);
        }
        for (int l = 0; l < n_layer; l++) {
            Layer& L = layers_[l];
            rmsnorm(x, h, L.attn_norm, B);
            matmul(*L.wq, h, q, B, n_embd, n_embd);
            matmul(*L.wk, h, k, B, n_embd, kvd);
            matmul(*L.wv, h, v, B, n_embd, kvd);
            for (int b = 0; b < B; b++) {
                for (int i = 0; i < n_embd; i++) q[(size_t)b * n_embd + i] += L.bq[i];
                for (int i = 0; i < kvd; i++) {
                    k[(size_t)b * kvd + i] += L.bk[i];
                    v[(size_t)b * kvd + i] += L.bv[i];
                }
                for (int hh = 0; hh < n_head; hh++) rope(&q[(size_t)b * n_embd + hh * head_dim], pos + b);
                for (int hh = 0; hh < n_kv; hh++) rope(&k[(size_t)b * kvd + hh * head_dim], pos + b);
                size_t off = ((size_t)l * n_ctx + pos + b) * kvd;
                std::copy(&k[(size_t)b * kvd], &k[(size_t)b * kvd] + kvd, &kc_[off]);
                std::copy(&v[(size_t)b * kvd], &v[(size_t)b * kvd] + kvd, &vc_[off]);
            }
            attention(l, q, att, B, pos);
            matmul(*L.wo, att, o, B, n_embd, n_embd);
            for (size_t i = 0; i < x.size(); i++) x[i] += o[i];
            rmsnorm(x, h, L.ffn_norm, B);
            matmul(*L.wg, h, g, B, n_embd, n_ff);
            matmul(*L.wu, h, u, B, n_embd, n_ff);
            for (size_t i = 0; i < g.size(); i++) g[i] = g[i] / (1.f + std::exp(-g[i])) * u[i];
            matmul(*L.wd, g, o, B, n_ff, n_embd);
            for (size_t i = 0; i < x.size(); i++) x[i] += o[i];
        }
        std::vector<float> last(x.end() - n_embd, x.end()), ln(n_embd), logits(n_vocab);
        rmsnorm(last, ln, out_norm_, 1);
        matmul(*out_, ln, logits, 1, n_embd, n_vocab);
        return logits;
    }

private:
    Pool pool_;
    const Tensor* embd_ = nullptr;
    const Tensor* out_ = nullptr;
    std::vector<float> out_norm_;
    std::vector<Layer> layers_;
    std::vector<float> kc_, vc_, inv_freq_;
    std::vector<std::vector<float>> rows_;
    bool exact_ = false;
    std::vector<QRow> qrows_;
    std::vector<std::vector<int32_t>> tmp_;
    std::vector<QAct> qx_;

    static const Tensor& shape(const Gguf& g, const std::string& n, int in, int out) {
        const Tensor& t = g.t(n);
        if (t.n_dims != 2 || (int64_t)t.ne[0] != in || (out >= 0 && (int64_t)t.ne[1] != out))
            throw LoadError("tensor " + n + " has an unexpected shape");
        return t;
    }
    static std::vector<float> vec(const Gguf& g, const std::string& n, int len) {
        const Tensor& t = g.t(n);
        if (t.n_dims != 1 || (int64_t)t.ne[0] != len) throw LoadError("tensor " + n + " has an unexpected shape");
        std::vector<float> v(len);
        dequant_row(t.type, t.data, v.data(), len);
        return v;
    }

    void rmsnorm(const std::vector<float>& x, std::vector<float>& y, const std::vector<float>& w, int B) {
        int n = (int)w.size();
        for (int b = 0; b < B; b++) {
            const float* xi = &x[(size_t)b * n];
            double ss = 0;
            for (int i = 0; i < n; i++) ss += (double)xi[i] * xi[i];
            float s = 1.f / std::sqrt((float)(ss / n) + eps);
            for (int i = 0; i < n; i++) y[(size_t)b * n + i] = xi[i] * s * w[i];
        }
    }

    // y[b][r] = sum_i W[r][i] * x[b][i]; rows split across threads.
    void matmul(const Tensor& W, const std::vector<float>& x, std::vector<float>& y, int B, int in, int out) {
        uint64_t rb = W.row_bytes();
        if (!exact_ && int_path(W.type) && in % 32 == 0) {
            qx_.resize((size_t)B);
            for (int b = 0; b < B; b++) quantize_act(&x[(size_t)b * in], in, qx_[(size_t)b]);
            pool_.run((size_t)out, [&](int th, size_t r0, size_t r1) {
                QRow& qr = qrows_[th];
                int32_t* tmp = tmp_[th].data();
#ifdef KG_HAVE_AVX2_KERNELS
                if (cpu_has_avx2() && B >= 4 && in % 128 == 0) {
                    const QAct* xs[4];
                    float o4[4];
                    for (size_t r = r0; r < r1; r++) {
                        unpack_row_avx2(W.type, W.data + r * rb, in, qr);
                        for (int b = 0; b < B; b += 4) {
                            int nt = std::min(4, B - b);
                            for (int t = 0; t < nt; t++) xs[t] = &qx_[(size_t)(b + t)];
                            qdot4_avx2(qr, xs, nt, in, o4);
                            for (int t = 0; t < nt; t++) y[(size_t)(b + t) * out + r] = o4[t];
                        }
                    }
                    return;
                }
                if (cpu_has_avx2() && (W.type == T_Q4_K || W.type == T_Q6_K || W.type == T_Q8_0)) {
                    for (size_t r = r0; r < r1; r++) {
                        const uint8_t* row = W.data + r * rb;
                        for (int b = 0; b < B; b++) {
                            const QAct& xa = qx_[(size_t)b];
                            y[(size_t)b * out + r] = W.type == T_Q4_K ? dot_q4_k_avx2(row, xa, in)
                                                   : W.type == T_Q6_K ? dot_q6_k_avx2(row, xa, in)
                                                                      : dot_q8_0_avx2(row, xa, in);
                        }
                    }
                    return;
                }
#endif
                for (size_t r = r0; r < r1; r++) {
                    unpack_row(W.type, W.data + r * rb, in, qr);
                    for (int b = 0; b < B; b++) y[(size_t)b * out + r] = qdot(qr, qx_[(size_t)b], in, tmp);
                }
            });
            return;
        }
        pool_.run((size_t)out, [&](int th, size_t r0, size_t r1) {
            float* row = rows_[th].data();
            for (size_t r = r0; r < r1; r++) {
                dequant_row(W.type, W.data + r * rb, row, (uint64_t)in);
                for (int b = 0; b < B; b++) {
                    const float* xb = &x[(size_t)b * in];
                    float s0 = 0, s1 = 0, s2 = 0, s3 = 0;
                    int i = 0;
                    for (; i + 4 <= in; i += 4) {
                        s0 += row[i] * xb[i];
                        s1 += row[i + 1] * xb[i + 1];
                        s2 += row[i + 2] * xb[i + 2];
                        s3 += row[i + 3] * xb[i + 3];
                    }
                    for (; i < in; i++) s0 += row[i] * xb[i];
                    y[(size_t)b * out + r] = (s0 + s1) + (s2 + s3);
                }
            }
        });
    }

    // Rotary position embedding, NEOX layout (pairs i and i + d/2), as used by Qwen2.
    void rope(float* v, int p) {
        int half = head_dim / 2;
        for (int i = 0; i < half; i++) {
            float a = (float)p * inv_freq_[i];
            float c = std::cos(a), s = std::sin(a);
            float x0 = v[i], x1 = v[i + half];
            v[i] = x0 * c - x1 * s;
            v[i + half] = x0 * s + x1 * c;
        }
    }

    void attention(int l, const std::vector<float>& q, std::vector<float>& out, int B, int pos) {
        int kvd = n_kv * head_dim;
        int group = n_head / n_kv;
        float scale = 1.f / std::sqrt((float)head_dim);
        pool_.run((size_t)B * n_head, [&](int, size_t a, size_t e) {
            std::vector<float> sc;
            for (size_t w = a; w < e; w++) {
                int b = (int)(w / n_head), hh = (int)(w % n_head);
                int p = pos + b;
                const float* qh = &q[(size_t)b * n_embd + hh * head_dim];
                int kh = hh / group;
                sc.assign(p + 1, 0.f);
                float mx = -1e30f;
                for (int t = 0; t <= p; t++) {
                    const float* kk = &kc_[((size_t)l * n_ctx + t) * kvd + kh * head_dim];
                    float s = 0;
                    for (int i = 0; i < head_dim; i++) s += qh[i] * kk[i];
                    sc[t] = s * scale;
                    mx = std::max(mx, sc[t]);
                }
                double sum = 0;
                for (int t = 0; t <= p; t++) {
                    sc[t] = std::exp(sc[t] - mx);
                    sum += sc[t];
                }
                float* oh = &out[(size_t)b * n_embd + hh * head_dim];
                std::fill(oh, oh + head_dim, 0.f);
                for (int t = 0; t <= p; t++) {
                    float wgt = (float)(sc[t] / sum);
                    const float* vv = &vc_[((size_t)l * n_ctx + t) * kvd + kh * head_dim];
                    for (int i = 0; i < head_dim; i++) oh[i] += wgt * vv[i];
                }
            }
        });
    }
};

}  // namespace kg
