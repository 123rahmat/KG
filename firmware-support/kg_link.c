#include "kg_link.h"

#define SOF1 0xA5u
#define SOF2 0x5Au

uint32_t kg_crc32(const uint8_t *p, uint32_t n)
{
    uint32_t crc = 0xFFFFFFFFu;
    uint32_t i;
    for (i = 0u; i < n; i++) {
        uint32_t k;
        crc ^= (uint32_t)p[i];
        for (k = 0u; k < 8u; k++) {
            uint32_t mask = (uint32_t)(-(int32_t)(crc & 1u));
            crc = (crc >> 1) ^ (0xEDB88320u & mask);
        }
    }
    return ~crc;
}

void kg_decoder_init(kg_decoder_t *d)
{
    d->n = 0u;
    d->crc_errors = 0u;
    d->framing_errors = 0u;
}

/* Drop the first `from` bytes, then everything up to the next start byte. Iterative, bounded. */
static void shift_to_next_start(kg_decoder_t *d, uint16_t from)
{
    uint16_t j = from;
    uint16_t k;
    while ((j < d->n) && (d->buf[j] != SOF1)) {
        j++;
    }
    for (k = 0u; (uint16_t)(j + k) < d->n; k++) {
        d->buf[k] = d->buf[j + k];
    }
    d->n = (uint16_t)(d->n - j);
}

static uint16_t get16(const uint8_t *p)
{
    return (uint16_t)((uint16_t)p[0] | (uint16_t)((uint16_t)p[1] << 8));
}

static uint32_t get32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

int kg_decoder_feed(kg_decoder_t *d, uint8_t b, kg_frame_t *out)
{
    if (d->n >= KG_LINK_FRAME_MAX) {
        d->framing_errors++;
        d->n = 0u;
    }
    d->buf[d->n] = b;
    d->n++;
    for (;;) {
        uint16_t len;
        uint16_t need;
        uint16_t i;
        if (d->n == 0u) {
            return 0;
        }
        if (d->buf[0] != SOF1) {
            shift_to_next_start(d, 1u);
            continue;
        }
        if ((d->n >= 2u) && (d->buf[1] != SOF2)) {
            d->framing_errors++;
            shift_to_next_start(d, 1u);
            continue;
        }
        if ((d->n >= 3u) && (d->buf[2] != KG_LINK_VERSION)) {
            d->framing_errors++;
            shift_to_next_start(d, 1u);
            continue;
        }
        if (d->n < 8u) {
            return 0;
        }
        len = get16(&d->buf[6]);
        if (len > KG_LINK_MAX_PAYLOAD) {
            d->framing_errors++;
            shift_to_next_start(d, 1u);
            continue;
        }
        need = (uint16_t)(12u + len);
        if (d->n < need) {
            return 0;
        }
        if (kg_crc32(&d->buf[2], (uint32_t)(6u + len)) != get32(&d->buf[8u + len])) {
            d->crc_errors++;
            shift_to_next_start(d, 1u);
            continue;
        }
        out->type = d->buf[3];
        out->seq = get16(&d->buf[4]);
        out->len = len;
        for (i = 0u; i < len; i++) {
            out->payload[i] = d->buf[8u + i];
        }
        shift_to_next_start(d, need);
        return 1;
    }
}

uint16_t kg_frame_encode(const kg_frame_t *f, uint8_t *out, uint16_t cap)
{
    uint16_t total;
    uint16_t i;
    uint32_t crc;
    if (f->len > KG_LINK_MAX_PAYLOAD) {
        return 0u;
    }
    total = (uint16_t)(12u + f->len);
    if (cap < total) {
        return 0u;
    }
    out[0] = (uint8_t)SOF1;
    out[1] = (uint8_t)SOF2;
    out[2] = (uint8_t)KG_LINK_VERSION;
    out[3] = f->type;
    out[4] = (uint8_t)(f->seq & 0xFFu);
    out[5] = (uint8_t)(f->seq >> 8);
    out[6] = (uint8_t)(f->len & 0xFFu);
    out[7] = (uint8_t)(f->len >> 8);
    for (i = 0u; i < f->len; i++) {
        out[8u + i] = f->payload[i];
    }
    crc = kg_crc32(&out[2], (uint32_t)(6u + f->len));
    out[8u + f->len] = (uint8_t)(crc & 0xFFu);
    out[9u + f->len] = (uint8_t)((crc >> 8) & 0xFFu);
    out[10u + f->len] = (uint8_t)((crc >> 16) & 0xFFu);
    out[11u + f->len] = (uint8_t)((crc >> 24) & 0xFFu);
    return total;
}
