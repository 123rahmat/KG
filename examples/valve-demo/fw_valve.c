#include "fw_valve.h"

#define KP        0.020f
#define KI        0.60f
#define KD        0.0012f
#define INTEG_MAX 0.5f

static float clampf(float v, float lo, float hi)
{
    if (v < lo) { return lo; }
    if (v > hi) { return hi; }
    return v;
}

uint32_t fw_abi_version(void) { return 2u; }
uint32_t fw_n_in(void)        { return FW_N_IN; }
uint32_t fw_n_out(void)       { return FW_N_OUT; }
uint32_t fw_state_size(void)  { return (uint32_t)sizeof(fw_state_t); }

void fw_init(fw_state_t *s)
{
    s->integ = 0.0f;
    s->last_pos = 0.0f;
    s->fault = 0u;
    s->started = 0u;
    s->done_mask = 0u;
}

void fw_step(fw_state_t *s, const float *in, float *out)
{
    float target = in[0];
    float enable = in[1];
    float pos = in[2];
    float drive = 0.0f;

    s->done_mask = 0u;
    if ((pos < FW_POS_MIN_VALID) || (pos > FW_POS_MAX_VALID)) {
        s->fault = 1u;                      /* latched until reset */
    }
    s->done_mask |= 1u;

    if ((s->fault == 0u) && (enable > 0.5f)) {
        float err = target - pos;
        float vel = (s->started != 0u) ? (pos - s->last_pos) / FW_DT_S : 0.0f;
        s->integ = clampf(s->integ + (KI * err * FW_DT_S * 0.01f), -INTEG_MAX, INTEG_MAX);
        drive = (target / FW_SPRING_GAIN) + (KP * err) + s->integ - (KD * vel);
    } else {
        s->integ = 0.0f;
    }
    s->last_pos = pos;
    s->started = 1u;
    s->done_mask |= 2u;

    out[0] = clampf(drive, -1.0f, 1.0f);
    s->done_mask |= 4u;
}

uint32_t fw_progress_token(const fw_state_t *s, uint32_t tick)
{
    return ((tick + 1u) << 3) | (s->done_mask & 7u);
}
