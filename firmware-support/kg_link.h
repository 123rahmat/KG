#ifndef KG_LINK_H
#define KG_LINK_H

/*
 * Kindgleam link protocol v2, on-chip side. Byte-for-byte identical to kg.rig.Frame (Java).
 *   A5 5A | ver | type | seq(LE16) | len(LE16) | payload[len<=256] | CRC-32(LE) over ver..payload
 * Static memory only, no recursion, no library calls. Safe to call from a UART receive loop.
 */

#include <stdint.h>

#define KG_LINK_VERSION      2u
#define KG_LINK_MAX_PAYLOAD  256u
#define KG_LINK_FRAME_MAX    (8u + KG_LINK_MAX_PAYLOAD + 4u)

typedef struct {
    uint8_t  type;
    uint16_t seq;
    uint16_t len;
    uint8_t  payload[KG_LINK_MAX_PAYLOAD];
} kg_frame_t;

typedef struct {
    uint8_t  buf[KG_LINK_FRAME_MAX];
    uint16_t n;
    uint32_t crc_errors;
    uint32_t framing_errors;
} kg_decoder_t;

uint32_t kg_crc32(const uint8_t *p, uint32_t n);
void     kg_decoder_init(kg_decoder_t *d);

/* Feeds one received byte. Returns 1 and fills *out when a verified frame is complete, else 0.
 * Any bad header, length or CRC is dropped and the buffered bytes are re-scanned for the next start. */
int      kg_decoder_feed(kg_decoder_t *d, uint8_t b, kg_frame_t *out);

/* Encodes f into out. Returns the number of bytes written, or 0 if it does not fit or is invalid. */
uint16_t kg_frame_encode(const kg_frame_t *f, uint8_t *out, uint16_t cap);

#endif
