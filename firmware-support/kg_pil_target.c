#include "kg_pil_target.h"
#include "kg_link.h"
#include "fw_ctrl.h"

#define T_HELLO     0x01u
#define T_INIT      0x02u
#define T_STEP      0x03u
#define T_HANG      0x04u
#define T_SAFE      0x05u
#define T_HEARTBEAT 0x06u
#define T_NAK       0xFFu

static kg_decoder_t g_dec;
static kg_frame_t   g_req;
static kg_frame_t   g_rsp;
static uint8_t      g_wire[KG_LINK_FRAME_MAX];
static uint16_t     g_wire_len;
static int32_t      g_last_seq;
static fw_state_t   g_fw;
static uint8_t      g_initialised;
static uint8_t      g_hung;
static uint8_t      g_safe;
static uint8_t      g_latch;              /* 0 max, 1 last, 2 safe: what outputs do after a hang */
static float        g_in[FW_N_IN];
static float        g_out[FW_N_OUT];
static float        g_last[FW_N_OUT];
static float        g_safe_v[FW_N_OUT];
static float        g_max_v[FW_N_OUT];

typedef union { uint32_t u; float f; } kg_word_t;

static uint32_t rd32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static void wr32(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)(v & 0xFFu);
    p[1] = (uint8_t)((v >> 8) & 0xFFu);
    p[2] = (uint8_t)((v >> 16) & 0xFFu);
    p[3] = (uint8_t)((v >> 24) & 0xFFu);
}

static float rdf(const uint8_t *p)
{
    kg_word_t w;
    w.u = rd32(p);
    return w.f;
}

static void wrf(uint8_t *p, float f)
{
    kg_word_t w;
    w.f = f;
    wr32(p, w.u);
}

static uint32_t state_hash(void)
{
    const uint8_t *b = (const uint8_t *)&g_fw;
    uint32_t h = 0x811c9dc5u;
    uint32_t i;
    for (i = 0u; i < (uint32_t)sizeof(g_fw); i++) {
        h ^= (uint32_t)b[i];
        h *= 0x01000193u;
    }
    return h;
}

static uint16_t copy_str(uint8_t *dst, const char *s, uint16_t max)
{
    uint16_t n = 0u;
    while ((n < max) && (s[n] != '\0')) {
        dst[n] = (uint8_t)s[n];
        n++;
    }
    return n;
}

static void reply(uint8_t type, uint16_t len)
{
    g_rsp.type = type;
    g_rsp.seq = g_req.seq;
    g_rsp.len = len;
    g_wire_len = kg_frame_encode(&g_rsp, g_wire, (uint16_t)sizeof(g_wire));
    g_last_seq = (int32_t)g_req.seq;
}

static void nak(uint8_t code)
{
    g_rsp.payload[0] = code;
    reply(T_NAK, 1u);
}

static void handle(void)
{
    uint16_t n;
    uint16_t k;
    uint32_t i;
    switch (g_req.type) {
    case T_HELLO:
        g_rsp.payload[0] = (uint8_t)KG_LINK_VERSION;
        wr32(&g_rsp.payload[1], kg_port_chip_id());
        n = copy_str(&g_rsp.payload[6], kg_board_name, 40u);
        g_rsp.payload[5] = (uint8_t)n;
        k = (uint16_t)(6u + n);
        n = copy_str(&g_rsp.payload[k + 1u], kg_board_rev, 40u);
        g_rsp.payload[k] = (uint8_t)n;
        k = (uint16_t)(k + 1u + n);
        for (n = 0u; n < 32u; n++) {
            g_rsp.payload[k + n] = kg_firmware_hash[n];
        }
        k = (uint16_t)(k + 32u);
        g_rsp.payload[k] = (uint8_t)FW_N_IN;
        g_rsp.payload[k + 1u] = (uint8_t)FW_N_OUT;
        reply(0x81u, (uint16_t)(k + 2u));
        break;
    case T_INIT:
        if ((g_req.len != (uint16_t)(2u + 8u * FW_N_OUT)) || (g_req.payload[1] != (uint8_t)FW_N_OUT) || (g_req.payload[0] > 2u)) {
            nak(3u);
            break;
        }
        g_latch = g_req.payload[0];
        for (i = 0u; i < FW_N_OUT; i++) {
            g_safe_v[i] = rdf(&g_req.payload[2u + 4u * i]);
            g_max_v[i] = rdf(&g_req.payload[2u + 4u * (FW_N_OUT + i)]);
            g_last[i] = g_safe_v[i];
        }
        fw_init(&g_fw);
        g_initialised = 1u;
        g_hung = 0u;
        reply(0x82u, 0u);
        break;
    case T_STEP:
        if ((g_initialised == 0u) || (g_req.len != (uint16_t)(6u + 4u * FW_N_IN)) || (g_req.payload[5] != (uint8_t)FW_N_IN)) {
            nak(2u);
            break;
        }
        {
            uint32_t tick = rd32(g_req.payload);
            uint8_t tripped;
            for (i = 0u; i < FW_N_IN; i++) {
                g_in[i] = rdf(&g_req.payload[6u + 4u * i]);
            }
            if (g_hung != 0u) {
                for (i = 0u; i < FW_N_OUT; i++) {
                    g_out[i] = (g_latch == 0u) ? g_max_v[i] : ((g_latch == 1u) ? g_last[i] : g_safe_v[i]);
                }
            } else {
                fw_step(&g_fw, g_in, g_out);
                for (i = 0u; i < FW_N_OUT; i++) {
                    g_last[i] = g_out[i];
                }
                if (g_req.payload[4] != 0u) {
                    kg_port_watchdog_kick(fw_progress_token(&g_fw, tick));
                }
            }
            tripped = kg_port_watchdog_tripped();
            if ((tripped != 0u) || (g_safe != 0u)) {
                for (i = 0u; i < FW_N_OUT; i++) {
                    g_out[i] = g_safe_v[i];
                }
            }
            wr32(g_rsp.payload, tick);
            g_rsp.payload[4] = tripped;
            g_rsp.payload[5] = (uint8_t)FW_N_OUT;
            for (i = 0u; i < FW_N_OUT; i++) {
                wrf(&g_rsp.payload[6u + 4u * i], g_out[i]);
            }
            wr32(&g_rsp.payload[6u + 4u * FW_N_OUT], state_hash());
            wr32(&g_rsp.payload[10u + 4u * FW_N_OUT], kg_port_step_cycles_ns());
            reply(0x83u, (uint16_t)(14u + 4u * FW_N_OUT));
        }
        break;
#ifdef KG_PIL_TEST_BUILD
    case T_HANG:
        g_hung = 1u;
        reply(0x84u, 0u);
        break;
#endif
    case T_SAFE:
        g_safe = 1u;
        kg_port_outputs_safe();
        reply(0x85u, 0u);
        break;
    case T_HEARTBEAT:
        reply(0x86u, 0u);
        break;
    default:
        nak(1u);
        break;
    }
}

void kg_pil_init(void)
{
    kg_decoder_init(&g_dec);
    g_last_seq = -1;
    g_initialised = 0u;
    g_hung = 0u;
    g_safe = 0u;
    g_latch = 0u;
    g_wire_len = 0u;
}

void kg_pil_on_byte(uint8_t b)
{
    if (kg_decoder_feed(&g_dec, b, &g_req) == 0) {
        return;
    }
    if (((int32_t)g_req.seq != g_last_seq) || (g_wire_len == 0u)) {
        handle(); /* a repeated sequence number is a retry: resend, never act twice */
    }
    if (g_wire_len != 0u) {
        kg_port_uart_write(g_wire, g_wire_len);
    }
}
